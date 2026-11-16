"""A conversation that continues an agent session, kept in step with that session (issue #20).

The session (an Antigravity cascade, a Claude Code / Codex / WorkBuddy session) is the one complete
record: the device collects every step of it, the questions Memento sent included. The conversation
holds what Memento ran, with what only Memento knows (the device, timings, live tool cards). What was
said in the tool's own app reached the conversation once at most, when it was first made from the
session: going back and forth between the app and Memento lost the app's turns for good.

Here the session's exchanges that are not Memento's own runs go into the conversation, in time order,
marked with the tool they happened in (the turn's ``origin``), whenever the session grows (ingest) or
the conversation is opened. Memento's runs are told apart by time (a run's question to its answer,
the window it ran in) or, for a device clock off by a few minutes, by the same question close by.
"""

from __future__ import annotations

import ast
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm.attributes import flag_modified

logger = logging.getLogger("server.ask")

# The turn field naming the tool an exchange happened in outside Memento, and the session line its
# question is on (the exchange's key: an exchange still being written is rebuilt under it)
ORIGIN = "origin"
ORIGIN_LINE = "origin_line"
# The conversation config entry recording how far the session was looked at
STATE = "session_sync"

# A run's window is its question to its answer; the session's own times come from the device's clock
WINDOW_SLACK = timedelta(seconds=30)
# The same question this close to one of Memento's is that one (a device clock a few minutes off)
SAME_QUESTION = timedelta(minutes=10)
# A session first taken in: its latest messages only, as the preview showed them
SEED_MESSAGES = 200
TOOL_OUTPUT_CHARS = 4000
THINKING_CHARS = 8000

_TOOL_NOISE = ("[Tool:", "[Result]", '{"tool_use_id"')
TOOL_DETAIL_KEYS = (
    "command", "cmd", "CommandLine", "Command",
    "file_path", "notebook_path", "path", "filePath", "file", "target_file", "TargetFile", "AbsolutePath", "Path", "File",
    "url", "Url", "query", "Query", "q", "pattern", "Pattern", "SearchPath", "DirectoryPath",
    "description", "skill", "name", "title", "prompt", "message",
)


@dataclass
class Msg:
    """One collected message of a session (a conversation_messages row)."""

    line: int
    role: str
    content: str
    ts: datetime | None = None
    kind: str = ""
    meta: dict = field(default_factory=dict)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _parse_time(val: Any) -> datetime | None:
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    if not val:
        return None
    try:
        dt = datetime.fromisoformat(str(val).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _norm(text: str) -> str:
    return " ".join((text or "").split())


# What Claude Code files under the user role without anyone saying it, as collected before the parser
# dropped it: the summary /compact writes, and a local command's echo (<local-command-stdout>Compacted…)
_INJECTED = re.compile(
    r"^\s*(?:This session is being continued from a previous conversation|<local-command-|<command-name>|<command-message>)"
)


def _said(content: str) -> bool:
    """User-role text someone typed: not tool output, not something Claude Code wrote there itself."""
    text = content or ""
    return not text.startswith(_TOOL_NOISE) and not _INJECTED.match(text)


def _is_question(m: Msg) -> bool:
    """A message the user said (not tool output or Claude Code's own entries filed under the user role)."""
    return m.role == "user" and _said(m.content)


# ── a session's messages as turns (apps/web/src/lib/ask/sessions.ts sessionMessagesToTurns) ──────────

def _tool_args(raw: str | None) -> dict | None:
    """A collected tool call's input as a dict: JSON (Claude Code, Codex) or the Python repr of the args
    with JSON-encoded string values (Antigravity)."""
    text = (raw or "").strip()
    if not text.startswith("{"):
        return None
    try:
        parsed = json.loads(text)
    except ValueError:
        try:
            parsed = ast.literal_eval(text)
        except (ValueError, SyntaxError, MemoryError, RecursionError):
            return None
    if not isinstance(parsed, dict):
        return None
    out = {}
    for k, v in parsed.items():
        if isinstance(v, str) and len(v) >= 2 and v.startswith('"') and v.endswith('"'):
            try:
                inner = json.loads(v)
                if isinstance(inner, str):
                    v = inner
            except ValueError:
                pass
        out[str(k)] = v
    return out


def tool_detail(raw: str | None) -> str:
    """What a collected tool call works on, as one line for its card."""
    args = _tool_args(raw)
    if not args:
        return (raw or "").strip()[:500]
    for k in TOOL_DETAIL_KEYS:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:500]
    pairs = [
        f"{k}: {str(v)[:120]}"
        for k, v in args.items()
        if isinstance(v, (str, int, float)) and str(v).strip()
        and k not in ("toolSummary", "toolAction", "WaitMsBeforeAsync", "SafeToAutoRun")
    ][:3]
    return "  ".join(pairs) if pairs else (raw or "").strip()[:500]


def clean_tool_output(text: str) -> tuple[str, int]:
    """Tool output without Antigravity's step header; the exit code it states (0 when none)."""
    rest = (text or "").replace("\r\n", "\n")
    while True:
        m = re.match(r"^\s*(?:Created At|Completed At):[^\n]*\n?", rest)
        if not m:
            break
        rest = rest[m.end():]
    exit_code = 0
    m = re.match(r"^\s*Command exited with code (-?\d+)\.?[^\n]*\n?", rest)
    if m:
        exit_code = int(m.group(1))
        rest = re.sub(r"^\s*Command output:[^\n]*\n?", "", rest[m.end():])
    return rest.lstrip("\n").rstrip(), exit_code


def messages_to_turns(msgs: list[Msg]) -> list[dict]:
    """Messages as turns: tool calls and their output go on the assistant turn before them."""
    turns: list[dict] = []
    for m in msgs:
        role, content, when = m.role, m.content or "", _iso(m.ts)
        if role == "user" and content.startswith("[Result]"):
            role, content = "tool", content[len("[Result]"):].lstrip()
        legacy = None
        if role == "assistant":
            idx = content.find("[Tool:")
            if idx != -1:
                lm = re.match(r"^\[Tool:\s*([^\]]+)\]\s*([\s\S]*)$", content[idx:])
                if lm:
                    legacy = (lm.group(1).strip(), tool_detail(lm.group(2).strip()))
                    content = content[:idx].strip()
                    role = "assistant" if content else "tool"
        if role == "user":
            if not _said(content):
                continue
            turns.append({"role": "user", "content": content, "created_at": when})
        elif role == "assistant":
            calls = []
            if legacy:
                calls.append({"name": legacy[0], "args": {"command": legacy[1]}})
            elif m.meta.get("tool_name"):
                calls.append({"name": m.meta["tool_name"], "args": {"command": tool_detail(m.meta.get("tool_input"))}})
            prev = turns[-1] if turns else None
            turn: dict = {"role": "assistant", "content": content, "created_at": when}
            if prev and prev["role"] == "user":
                turn["started_at"] = prev.get("created_at")
            thinking = m.meta.get("thinking")
            if thinking:
                turn["thinking"] = str(thinking)[:THINKING_CHARS]
            if calls:
                turn["toolCalls"] = calls
            turns.append(turn)
        elif role == "tool":
            last = turns[-1] if turns else None
            if not last or last["role"] != "assistant":
                last = {"role": "assistant", "content": "", "toolCalls": [], "created_at": when}
                if turns and turns[-1]["role"] == "user":
                    last["started_at"] = turns[-1].get("created_at")
                turns.append(last)
            elif when:
                last["created_at"] = when
            calls = last.setdefault("toolCalls", [])
            if legacy:
                calls.append({"name": legacy[0], "args": {"command": legacy[1]}})
            elif m.kind == "tool_call" or m.meta.get("tool_name"):
                calls.append({"name": m.meta.get("tool_name") or "tool", "args": {"command": tool_detail(m.meta.get("tool_input"))}})
            else:
                stdout, code = clean_tool_output(content)
                result = {"stdout": stdout[-TOOL_OUTPUT_CHARS:], "status": "succeeded" if code == 0 else "failed", "exit_code": code}
                if calls:
                    calls[-1]["result"] = result
                else:
                    calls.append({"name": "tool", "args": {}, "result": result})
    return turns


# The agent binary a tool's run card names (ExecutionCard picks the brand from it)
_BINARY_OF_TOOL = {"claude_code": "claude", "codex": "codex", "antigravity": "agy", "workbuddy": "workbuddy"}


def fold_exchange(turns: list[dict], origin: str, line: int) -> list[dict]:
    """One exchange's turns (its question, then the assistant messages the tool wrote one by one) as
    Memento shows its own runs: the question and one answer, whose commands are the steps of a single
    run card (the "过程" timeline) and whose text is everything the agent said, in order. Without this
    every command of the app's answer was a turn of its own, a card per line."""
    question = next((t for t in turns if t.get("role") == "user"), None)
    answers = [t for t in turns if t.get("role") == "assistant"]
    if len(answers) <= 1 and not any(t.get("toolCalls") for t in answers):
        return turns
    texts = [str(t.get("content") or "").strip() for t in answers]
    thinking = "\n\n".join(str(t["thinking"]) for t in answers if t.get("thinking"))
    events: list[dict] = []
    for t in answers:
        for c in t.get("toolCalls") or []:
            r = c.get("result") or {}
            ev: dict = {"kind": "tool", "id": f"{origin}_{line}_{len(events)}", "name": c.get("name") or "tool", "status": "done"}
            detail = str((c.get("args") or {}).get("command") or "")
            if detail:
                ev["detail"] = detail
            if r.get("stdout"):
                ev["output"] = r["stdout"]
            if r.get("status") == "failed":
                ev["status"] = "failed"
            if t.get("created_at"):
                ev["at"] = t["created_at"]
            events.append(ev)
    content = "\n\n".join(x for x in texts if x)
    answer: dict = {"role": "assistant", "content": content, "created_at": answers[-1].get("created_at") or answers[0].get("created_at")}
    started = next((t.get("started_at") for t in answers if t.get("started_at")), None)
    if started:
        answer["started_at"] = started
    if thinking:
        answer["thinking"] = thinking[:THINKING_CHARS]
    if events:
        binary = _BINARY_OF_TOOL.get(origin, origin)
        prompt = str((question or {}).get("content") or "")
        answer["toolCalls"] = [{
            "id": f"session_{origin}_{line}",
            "name": "run_on_device",
            "action": "agent",
            "binary": binary,
            "args": {"action": "agent", "binary": binary, "prompt": prompt},
            "result": {"status": "succeeded", "exit_code": 0, "stdout": content, "events": events},
        }]
    out = [question] if question else []
    return out + [answer]


# ── merging a session into its conversation ────────────────────────────────────────────────────────

def _memento_runs(turns: list[dict]) -> tuple[list[tuple[datetime, datetime]], list[tuple[datetime | None, str]]]:
    """Memento's own runs in a conversation: the windows they ran in, and their questions with the time
    each was asked (None for a turn saved without one). Turns without an origin are Memento's, or were
    copied from the session before: those are known by their question too."""
    windows: list[tuple[datetime, datetime]] = []
    questions: list[tuple[datetime | None, str]] = []
    pending: datetime | None = None
    for t in turns:
        if not isinstance(t, dict) or t.get(ORIGIN):
            pending = None
            continue
        if t.get("role") == "user":
            pending = _parse_time(t.get("created_at"))
            questions.append((pending, _norm(str(t.get("content") or ""))))
        elif t.get("role") == "assistant" and pending:
            end = _parse_time(t.get("created_at")) or pending
            windows.append((pending, max(end, pending)))
            pending = None
    return windows, questions


def _is_memento_exchange(question: Msg, windows, questions) -> bool:
    when = question.ts
    if when is not None and any(start - WINDOW_SLACK <= when <= end + WINDOW_SLACK for start, end in windows):
        return True
    text = _norm(question.content)
    if not text:
        return False
    return any(
        asked_text == text and (asked is None or when is None or abs(asked - when) <= SAME_QUESTION)
        for asked, asked_text in questions
    )


def _exchanges(msgs: list[Msg]) -> list[tuple[Msg | None, list[Msg]]]:
    """The messages grouped by the question each answers; a group before the first question has none."""
    out: list[tuple[Msg | None, list[Msg]]] = []
    for m in msgs:
        if _is_question(m) or not out:
            out.append((m if _is_question(m) else None, [m]))
        else:
            out[-1][1].append(m)
    return out


def _turn_time(t: dict) -> datetime | None:
    return _parse_time(t.get("created_at"))


def _insert_at(turns: list[dict], when: datetime | None) -> int:
    """Where an exchange asked at `when` goes: before the first later question, never inside a
    question-and-answer pair."""
    if when is None:
        return len(turns)
    for i, t in enumerate(turns):
        if t.get("role") == "user":
            at = _turn_time(t)
            if at and at > when:
                return i
    return len(turns)


def _merged_from(turn: dict, line: int) -> bool:
    """A turn merged from the session's exchange whose question is on `line`."""
    return bool(turn.get(ORIGIN)) and turn.get(ORIGIN_LINE) == line


# The execution mode of a tool's sessions
_MODE_OF_TOOL = {"claude_code": "claude", "codex": "codex", "antigravity": "antigravity", "workbuddy": "workbuddy"}


def merge_session(
    turns: list[dict], state: dict | None, msgs: list[Msg], session_id: str, origin: str,
) -> tuple[list[dict], dict, bool]:
    """The conversation's turns with the session's new messages (`msgs`, from the line `read_from`
    says, in line order) merged in: (turns, state, changed). Pure: the caller reads and writes."""
    state = dict(state or {})
    if state.get("sid") != session_id:
        state = {"sid": session_id}
    if not msgs:
        return list(turns), state, False
    out = list(turns)
    changed = False
    windows, questions = _memento_runs(out)
    last_line = state.get("line")
    open_line = None
    for question, group in _exchanges(msgs):
        last_line = max(last_line if last_line is not None else group[-1].line, group[-1].line)
        if question is None:
            # The rest of an exchange before these lines: Memento's own, or one not followed
            continue
        if _is_memento_exchange(question, windows, questions):
            open_line = None
            continue
        new_turns = fold_exchange(messages_to_turns(group), origin, question.line)
        if not new_turns:
            continue
        for t in new_turns:
            t[ORIGIN] = origin
            t[ORIGIN_LINE] = question.line
            if t["role"] == "assistant":
                t["execution_mode"] = _MODE_OF_TOOL.get(origin, origin)
                start, end = _parse_time(t.get("started_at")), _parse_time(t.get("created_at"))
                if start and end and end >= start:
                    t["duration_ms"] = int((end - start).total_seconds() * 1000)
        open_line = question.line
        before = [t for t in out if _merged_from(t, question.line)]
        if before == new_turns:
            continue  # read again while it was being written, and nothing came since
        kept = [t for t in out if not _merged_from(t, question.line)]
        pos = _insert_at(kept, question.ts)
        out = kept[:pos] + new_turns + kept[pos:]
        changed = True
    if last_line is not None:
        state["line"] = last_line
    # The latest exchange from the app may still be being written: read again from its question
    if open_line is not None:
        state["open"] = open_line
    else:
        state.pop("open", None)
    return out, state, changed


def read_from(state: dict | None, session_id: str) -> int | None:
    """The first session line to read for this state (None: from the latest SEED_MESSAGES)."""
    state = state or {}
    if state.get("sid") != session_id or state.get("line") is None:
        return None
    if state.get("open") is not None:
        return int(state["open"])
    return int(state["line"]) + 1


def drop_copies_of_run(turns: list[dict], question: str, asked_at: Any, answered_at: Any) -> list[dict]:
    """The turns without exchanges merged from the session that are this run of Memento's (merged
    before its turns were saved: a run recovered from the device after the server lost it)."""
    start, end = _parse_time(asked_at), _parse_time(answered_at)
    text = _norm(question)
    if not start or not text:
        return turns
    end = max(end or start, start)
    drop: set[int] = set()
    for t in turns:
        if t.get(ORIGIN) and t.get("role") == "user" and _norm(str(t.get("content") or "")) == text:
            at = _turn_time(t)
            if at and start - SAME_QUESTION <= at <= end + SAME_QUESTION:
                drop.add(t.get(ORIGIN_LINE))
    if not drop:
        return turns
    return [t for t in turns if not (t.get(ORIGIN) and t.get(ORIGIN_LINE) in drop)]


# ── reading and writing ─────────────────────────────────────────────────────────────────────────────


async def _session_document(db, user_id, tool: str, session_id: str) -> uuid.UUID | None:
    """The collected document of a session: the main log, not a subagent's."""
    from ..db.models import Document, Machine

    mine = select(Machine.id).where(Machine.user_id == user_id)
    for key in ("session_id", "cascade_id"):
        doc_id = (await db.execute(
            select(Document.id)
            .where(
                Document.metadata_.op("->>")(key) == session_id,
                Document.tool_id == tool,
                Document.category == "conversation",
                Document.machine_id.in_(mine),
                or_(Document.relative_path.is_(None), ~Document.relative_path.like("%/subagents/%")),
            )
            .order_by(Document.updated_at.desc().nulls_last())
            .limit(1)
        )).scalar_one_or_none()
        if doc_id:
            return doc_id
    return None


async def _messages(db, doc_id: uuid.UUID, start: int | None) -> list[Msg]:
    from ..db.models import ConversationMessage as CM

    q = select(CM.line_number, CM.role, CM.message_type, CM.content, CM.timestamp, CM.metadata_).where(
        CM.document_id == doc_id,
        CM.line_number >= 0,  # below 0: questions copied in from a tool's history file, already in the log
    )
    if start is None:
        # A session first taken in: its latest messages, from a question on
        floor = (await db.execute(
            select(CM.line_number).where(CM.document_id == doc_id, CM.line_number >= 0)
            .order_by(CM.line_number.desc()).offset(SEED_MESSAGES - 1).limit(1)
        )).scalar_one_or_none()
        if floor is not None:
            q = q.where(CM.line_number >= floor)
    else:
        q = q.where(CM.line_number >= start)
    rows = (await db.execute(q.order_by(CM.line_number.asc()))).all()
    return [
        Msg(line, (role or kind or "user"), content or "", _parse_time(ts), kind or "", dict(meta or {}))
        for line, role, kind, content, ts, meta in rows
    ]


async def sync_conversation(conv_id: uuid.UUID, doc_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None) -> bool:
    """Bring a conversation in step with the session it continues; True when its turns changed.
    Nothing while a run of it is going: what the session gets then is that run's own. With `user_id`,
    only that user's conversation."""
    from ..db.models import AskConversation, ConversationMessage
    from ..db.session import async_session_factory
    from .ask_runs import ask_runs
    from .ask_store import MODE_TOOL, bust_conv_list

    async with async_session_factory() as db:
        head = (await db.execute(
            select(AskConversation.user_id, AskConversation.config).where(AskConversation.id == conv_id)
        )).first()
        if head is None or head[0] is None or (user_id is not None and head[0] != user_id):
            return False
        user_id, cfg = head[0], dict(head[1] or {})
        session_id = str(cfg.get("session_id") or "").strip()
        tool = MODE_TOOL.get(str(cfg.get("execution_mode") or "").lower())
        if not session_id or not tool:
            return False
        state = cfg.get(STATE) if isinstance(cfg.get(STATE), dict) else {}
        if state.get("sid") == session_id and state.get("doc"):
            doc_id = doc_id or uuid.UUID(str(state["doc"]))
        doc_id = doc_id or await _session_document(db, user_id, tool, session_id)
        if doc_id is None:
            return False
        # Nothing new since the last look: no lock, no turns read
        latest = (await db.execute(
            select(func.max(ConversationMessage.line_number)).where(ConversationMessage.document_id == doc_id)
        )).scalar()
        if latest is None or (state.get("sid") == session_id and state.get("line") is not None and latest <= int(state["line"])):
            return False
        run = await ask_runs.get(str(conv_id), user_id)
        if run is not None and not run.done:
            return False

        conv = (await db.execute(
            select(AskConversation).where(AskConversation.id == conv_id).with_for_update()
        )).scalars().first()
        if conv is None:
            return False
        cfg = dict(conv.config or {})
        if str(cfg.get("session_id") or "").strip() != session_id:
            return False  # it moved on to another session meanwhile
        state = cfg.get(STATE) if isinstance(cfg.get(STATE), dict) else {}
        msgs = await _messages(db, doc_id, read_from(state, session_id))
        turns, new_state, changed = merge_session(list(conv.turns or []), state, msgs, session_id, tool)
        new_state["doc"] = str(doc_id)
        if not changed and new_state == state:
            return False
        cfg[STATE] = new_state
        conv.config = cfg
        if changed:
            conv.turns = turns
            conv.message_count = len(turns)
            flag_modified(conv, "turns")
            conv.updated_at = datetime.now(timezone.utc)
        await db.commit()
    if changed:
        await bust_conv_list(user_id)
        try:
            from .sse_service import publish_event
            publish_event("ask_conversation_synced", {"conversation_id": str(conv_id)}, user_id=str(user_id))
        except Exception:
            pass
    return changed


async def sync_quietly(conv_id: uuid.UUID, doc_id: uuid.UUID | None = None, user_id: uuid.UUID | None = None) -> bool:
    """sync_conversation for a caller that goes on whatever happens (opening the conversation)."""
    try:
        return await sync_conversation(conv_id, doc_id, user_id)
    except Exception as e:
        logger.warning("Bringing conversation %s in step with its session failed: %s", conv_id, e)
        return False


# Documents a sync is already on its way for, on this replica: a session being written comes in a
# slice every few seconds, one sync answers them all (losing this only means syncing once more)
_pending: set[str] = set()
COALESCE_SECONDS = 2.0


async def _sync_for_document(doc_id: str, user_id: str) -> None:
    import asyncio

    from ..db.models import AskConversation, Document
    from ..db.session import async_session_factory

    try:
        await asyncio.sleep(COALESCE_SECONDS)
        _pending.discard(doc_id)
        async with async_session_factory() as db:
            doc = (await db.execute(
                select(Document.tool_id, Document.category, Document.metadata_, Document.relative_path)
                .where(Document.id == uuid.UUID(doc_id))
            )).first()
            if doc is None or doc[1] != "conversation" or doc[0] not in _MODE_OF_TOOL or "/subagents/" in (doc[3] or ""):
                return
            meta = doc[2] or {}
            session_id = str(meta.get("session_id") or meta.get("cascade_id") or "").strip()
            if not session_id:
                return
            conv_ids = (await db.execute(
                select(AskConversation.id).where(
                    AskConversation.user_id == uuid.UUID(user_id),
                    AskConversation.config.op("->>")("session_id") == session_id,
                )
            )).scalars().all()
        for cid in conv_ids:
            await sync_quietly(cid, uuid.UUID(doc_id))
    except Exception as e:
        _pending.discard(doc_id)
        logger.warning("Syncing conversations of session document %s failed: %s", doc_id, e)


def schedule_for_document(doc_id: str | None, user_id: str | None) -> None:
    """After a collected file is committed: bring the conversations continuing its session in step."""
    if not doc_id or not user_id or doc_id in _pending:
        return
    _pending.add(doc_id)
    from .notify_service import spawn

    spawn(_sync_for_document(doc_id, user_id))
