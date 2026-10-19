"""Session reviews: what each finished session taught.

Nightly, every substantial session that has gone quiet is condensed (the user's
words, what the AI did, which tool calls failed) and read once by the
background model, which pulls out three things:

- a skill: a multi-step procedure that got something done in the user's own
  environment and will come up again (drafted; the user publishes it);
- pitfalls: something failed, the cause was found, and the fix is known
  (kept as memories, served before similar work);
- todos: work the session left unfinished that the user wanted done, and
  open todos the session finished.

Failed agent tasks dispatched from Memento feed pitfalls the same way.
Only concrete, observed things are kept; the prompt forbids generic advice.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    ConversationMessage, DeviceTask, Document, Machine, Project, SessionReview, Skill, Todo, User, UserMemory,
)
from . import ai_health
from .ai_provider import call_plain_chat
from .dreaming_service import SUBAGENT_PATH_REGEX, _safe_json_loads, clean_user_voice
from .skill_service import slugify, unique_slug, upsert_mined
from .todo_service import add_todo, clean_title, close_todo, open_todos, parse_due

logger = logging.getLogger("server.retrospective")

SETTLE = timedelta(minutes=20)  # a session quiet this long is ready for review
WINDOW = timedelta(days=3)
BACKFILL = timedelta(days=14)
MIN_MESSAGES = 12
MIN_TOOL_CALLS = 3
MAX_SESSIONS = 12
REGROW = 1.25  # re-review a session that grew by a quarter since its review
REGROW_MIN_NEW_MSGS = 30  # or added at least 30 new messages (for long-lived continued sessions)
MESSAGE_CAP = 700
TRANSCRIPT_CHARS = 14000
KNOWN_SKILLS = 60
KNOWN_PITFALLS = 50
PITFALL_MAX = 600

_ERR_RE = re.compile(
    r"error|failed|failure|traceback|exception|denied|not found|no such file|cannot|can't|fatal|"
    r"exit code [1-9]|exit status [1-9]|non-zero|refused|timed? ?out|panic|报错|失败|错误|超时|拒绝",
    re.IGNORECASE,
)
_TOOL_RE = re.compile(r"\[Tool: ([^\]]+)\]\n?")
_WS_RE = re.compile(r"\s+")
MAX_ERRORS = 3  # a session the model keeps failing on is given up after this many nights


def squash(text: str) -> str:
    return _WS_RE.sub(" ", text or "").strip()


# ---- condensing a transcript ----

def _tool_summary(name: str, raw: str) -> str:
    raw = raw.strip()
    try:
        args = json.loads(raw) if raw.startswith("{") else None
    except ValueError:
        args = None
    if isinstance(args, dict):
        for key in ("command", "cmd", "file_path", "path", "pattern", "url", "query", "prompt", "description"):
            if args.get(key):
                return f"{name}: {str(args[key])[:200]}"
        return f"{name}: {json.dumps(args, ensure_ascii=False)[:160]}"
    return f"{name}: {raw[:160]}"


def condense(messages: list[tuple[str | None, str]]) -> str:
    """(role, content) oldest first → a compact timeline an LLM can read in one go."""
    lines: list[str] = []
    for role, content in messages:
        content = content or ""
        if role == "user":
            if content.startswith("[Result]"):
                body = content[len("[Result]"):].strip()
                if _ERR_RE.search(body[:2000]):
                    lines.append(f"  ↳ 出错: {squash(body)[:240]}")
                continue
            voice = clean_user_voice(content)
            if voice:
                lines.append(f"【用户】{voice[:400]}")
            continue
        if role == "assistant":
            parts = _TOOL_RE.split(content)
            text = parts[0].strip()
            if text:
                lines.append(f"【AI】{squash(text)[:300]}")
            for i in range(1, len(parts) - 1, 2):
                lines.append(f"  ⚙ {_tool_summary(parts[i], parts[i + 1])}")
            continue
        if _ERR_RE.search(content[:2000]):
            lines.append(f"  ↳ 出错: {squash(content)[:240]}")
    text = "\n".join(lines)
    if len(text) <= TRANSCRIPT_CHARS:
        return text
    head = TRANSCRIPT_CHARS // 4
    return text[:head] + "\n…（中间省略）…\n" + text[-(TRANSCRIPT_CHARS - head):]


# ---- picking sessions ----

@dataclass
class Candidate:
    doc_id: uuid.UUID
    title: str
    tool_id: str
    project: str | None
    project_slug: str | None
    messages: int
    tool_calls: int
    last_at: datetime
    prev_messages: int = 0


async def pick_sessions(db: AsyncSession, user: User, since: datetime, now: datetime) -> list[Candidate]:
    machines = select(Machine.id).where(Machine.user_id == user.id)
    n_msgs = func.count(ConversationMessage.id)
    n_tools = func.sum(case((ConversationMessage.content.like("%[Tool:%"), 1), else_=0))
    last_at = func.max(ConversationMessage.timestamp)
    rows = (await db.execute(
        select(Document.id, Document.title, Document.tool_id, Project.title, Project.slug, n_msgs, n_tools, last_at)
        .join(ConversationMessage, ConversationMessage.document_id == Document.id)
        .outerjoin(Project, Project.id == Document.project_id)
        .where(
            Document.machine_id.in_(machines),
            Document.category == "conversation",
            Document.synced_at >= since,
            ~Document.relative_path.op("~")(SUBAGENT_PATH_REGEX),
            ~func.coalesce(Document.metadata_.has_key("parent_session_id"), False),
        )
        .group_by(Document.id, Document.title, Document.tool_id, Project.title, Project.slug)
        .having(n_msgs >= MIN_MESSAGES, last_at <= now - SETTLE, last_at >= since)
    )).all()
    reviewed = {doc_id: (count, outcome, result or {}) for doc_id, count, outcome, result in (await db.execute(
        select(SessionReview.document_id, SessionReview.message_count, SessionReview.outcome, SessionReview.result)
        .where(SessionReview.document_id.in_([r[0] for r in rows] or [uuid.uuid4()]))
    )).all()}
    out = []
    for doc_id, title, tool_id, project, slug, n, tools, last in rows:
        if (tools or 0) < MIN_TOOL_CALLS:
            continue
        before = reviewed.get(doc_id)
        prev_count = 0
        if before is not None:
            count, outcome, result = before
            prev_count = count or 0
            if outcome == "error":
                if int(result.get("errors") or 0) >= MAX_ERRORS:
                    continue
            elif n < count * REGROW and (n - count) < REGROW_MIN_NEW_MSGS:
                continue
        out.append(Candidate(doc_id, title or "", tool_id, project, slug, n, tools or 0, last, prev_messages=prev_count))
    out.sort(key=lambda c: (c.tool_calls, c.messages), reverse=True)
    return out[:MAX_SESSIONS]


async def load_transcript(db: AsyncSession, doc_id: uuid.UUID, prev_messages: int = 0) -> str:
    base = select(ConversationMessage.role, ConversationMessage.content).where(ConversationMessage.document_id == doc_id)
    if prev_messages > 0:
        start_line = max(0, prev_messages - 20)
        base = base.where(ConversationMessage.line_number >= start_line)
    total = (await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar() or 0
    if total <= MESSAGE_CAP:
        rows = (await db.execute(base.order_by(ConversationMessage.line_number))).all()
    else:
        head = (await db.execute(base.order_by(ConversationMessage.line_number).limit(MESSAGE_CAP // 5))).all()
        tail = (await db.execute(
            base.order_by(ConversationMessage.line_number.desc()).limit(MESSAGE_CAP - MESSAGE_CAP // 5)
        )).all()
        rows = list(head) + [("assistant", "（中间省略了较早的消息）")] + list(reversed(tail))
    return condense([(r, c) for r, c in rows])


# ---- what the model is told it already knows ----

@dataclass
class Known:
    skills: dict[str, Skill] = field(default_factory=dict)
    pitfalls: dict[str, UserMemory] = field(default_factory=dict)
    todos: dict[str, Todo] = field(default_factory=dict)

    def render(self) -> tuple[str, str, str]:
        status = {"draft": "草稿", "published": "已发布", "dismissed": "用户不要", "retired": "已停用"}
        skills = "\n".join(
            f"{ref} [{status.get(s.status, s.status)}] {s.slug}：{s.description[:120]}" for ref, s in self.skills.items()
        ) or "（无）"
        pitfalls = "\n".join(f"{ref} {m.content[:140]}" for ref, m in self.pitfalls.items()) or "（无）"
        todos = "\n".join(
            f"{ref} {t.title}" + (f"（{t.project}）" if t.project else "") for ref, t in self.todos.items()
        ) or "（无）"
        return skills, pitfalls, todos


async def load_known(db: AsyncSession, user: User, project: str | None) -> Known:
    known = Known()
    skills = (await db.execute(
        select(Skill).where(Skill.user_id == user.id).order_by(Skill.last_seen_at.desc().nulls_last()).limit(KNOWN_SKILLS)
    )).scalars().all()
    known.skills = {f"s{n}": s for n, s in enumerate(skills, 1)}
    pitfalls = (await db.execute(
        select(UserMemory).where(
            UserMemory.user_id == user.id, UserMemory.category == "pitfall", UserMemory.status == "active",
        ).order_by(UserMemory.updated_at.desc()).limit(400)
    )).scalars().all()
    if project:
        mark = f"/pitfall/{project_key(project)}/"
        pitfalls = sorted(pitfalls, key=lambda m: mark not in (m.tree_path or "").lower())
    known.pitfalls = {f"p{n}": m for n, m in enumerate(pitfalls[:KNOWN_PITFALLS], 1)}
    known.todos = {f"d{n}": t for n, t in enumerate(await open_todos(db, user), 1)}
    return known


_REVIEW_PROMPT = """你在帮一位开发者复盘他和 AI 编程工具的一次会话，目的是让以后的 AI 少走弯路。下面是会话的压缩记录：【用户】是他亲手打的话，【AI】是 AI 的回复，⚙ 是 AI 调用的工具，↳ 出错 是失败的工具结果。

## 会话
工具：{tool}　项目：{project}　标题：{title}
{transcript}

## 已经学到的技能
{skills}

## 已经记下的坑
{pitfalls}

## 还没完成的待办
{todos}

## 请提炼
1. outcome：done（目标达成）| partial（做了一部分）| failed（没做成）| chat（只是聊天/问答，没干活）。summary：一句话说这次会话干了什么、结果如何。
2. skill：只有当这次会话**成功完成**了一个多步骤流程、而且这个流程绑定了用户自己的环境（他的项目、机器、服务、目录、命令），以后很可能再做时才填，否则填 null。通用知识（怎么写 Python、git 基本用法）不算。
   - 步骤必须来自会话里真实执行过、最终成功的命令和操作，不许编造；失败绕过的弯路写成"注意"。
   - body：Markdown，按"## 何时使用 / ## 步骤（编号，带具体命令和路径）/ ## 验证 / ## 注意"组织，写给 AI 看的祈使句。
   - description：一句话说清"做什么 + 什么时候用"，AI 靠它决定是否调用，60-200 字。slug：英文小写加连字符，如 memento-gitops-deploy。title：中文短名。
   - 如果和已知技能是同一件事，match 填它的编号（如 "s2"），changes 写这次比已知版本多了/改了什么（没有变化就填空字符串）。用户不要的技能不要再提。
3. pitfalls：这次会话里**真实发生**的失败，且找到了原因和解法。每条写清 title（一句话）、symptom（报错/现象，保留关键原文）、cause（根因）、fix（怎么解决的）。只是猜测、没解决的不算。和已记下的坑是同一个的，match 填它的编号（如 "p3"），其余字段照样填。
   - 只记和用户的项目、代码、机器、服务、数据有关的坑。AI 工具自己的使用限制（写文件前要先读、每次 Bash 是独立 shell、sleep 被拦截、工具参数写错、找不到自己刚 cd 的目录）不算，不要写。
4. todos_new：会话结束时还没做完、而用户明确想做的事（用户说了以后再做，或 AI 提出后用户同意留到以后）。AI 自己随口建议但用户没回应的不算。title 是动宾短语，due 为 YYYY-MM-DD 或 null。
5. todos_done：已知待办里，这次会话明确做完了的，填编号（如 "d1"）和一句依据。

宁缺毋滥：拿不准就不填。只输出 JSON：
{{"outcome": "done", "summary": "...", "skill": null, "pitfalls": [], "todos_new": [], "todos_done": []}}
skill 的格式：{{"match": null, "slug": "...", "title": "...", "description": "...", "body": "...", "project": "...", "changes": ""}}
pitfall 的格式：{{"match": null, "title": "...", "symptom": "...", "cause": "...", "fix": "...", "project": "..."}}
todo 的格式：{{"title": "...", "detail": null, "due": null}}；done 的格式：{{"d": "d1", "evidence": "..."}}"""


# The AI tool's own mechanics, not the user's environment; models keep proposing these anyway.
_HARNESS_RE = re.compile(
    r"独立\s*的?\s*shell|工作目录不(会)?(保留|延续|保持)|先\s*read|has not been read|tool_use_error|"
    r"blocked:\s*sleep|sleep.{0,12}拦截|工具参数|invalid tool|InputValidationError",
    re.IGNORECASE,
)


def is_harness_pitfall(item: dict[str, Any]) -> bool:
    return bool(_HARNESS_RE.search(" ".join(str(item.get(k) or "") for k in ("title", "symptom", "cause", "fix"))))


def format_pitfall(item: dict[str, Any], project: str | None) -> str:
    def f(key: str, limit: int) -> str:
        return squash(str(item.get(key) or ""))[:limit]

    head = f"【{project}】" if project else ""
    text = f"{head}{f('title', 80)}。现象：{f('symptom', 200)}；原因：{f('cause', 160)}；解决：{f('fix', 200)}"
    return text[:PITFALL_MAX]


def pitfall_key(title: str) -> str:
    return "pitfall_" + hashlib.sha1((title or "").strip().lower().encode()).hexdigest()[:10]


def project_key(name: str | None) -> str:
    """Folder name for a project in memory paths: the project's name, not its per-tool slug,
    so the same repo worked on from Claude Code and Codex shares one folder."""
    name = (name or "").strip().split("/")[-1].lower()
    return re.sub(r"[^\w.-]+", "-", name).strip("-")[:60] or "general"


async def save_pitfall(
    db: AsyncSession, user: User, item: dict[str, Any], project: str | None, source: str,
) -> UserMemory | None:
    """A new pitfall memory, or None when the item is incomplete or already stored."""
    if not all(str(item.get(k) or "").strip() for k in ("title", "symptom", "fix")) or is_harness_pitfall(item):
        return None
    display = (project or str(item.get("project") or "")).strip().split("/")[-1] or None
    folder = project_key(display)
    key = pitfall_key(str(item["title"]))
    exists = (await db.execute(
        select(UserMemory.id).where(UserMemory.user_id == user.id, UserMemory.category == "pitfall", UserMemory.key == key)
    )).first()
    if exists:
        return None
    mem = UserMemory(
        user_id=user.id, category="pitfall", key=key,
        content=format_pitfall(item, display),
        confidence=0.85, source=source, tree_path=f"/pitfall/{folder}/{key}",
    )
    db.add(mem)
    await db.flush()
    try:
        from .cache import cache_delete_prefix
        await cache_delete_prefix(f"memory:resonance:{user.id}")
        await cache_delete_prefix(f"learning:check:{user.id}")
    except Exception as e:
        logger.warning("Failed to invalidate cache after save_pitfall: %s", e)
    return mem


async def review_session(db: AsyncSession, user: User, cand: Candidate) -> dict[str, Any]:
    transcript = await load_transcript(db, cand.doc_id, prev_messages=cand.prev_messages)
    known = await load_known(db, user, cand.project)
    skills_text, pitfalls_text, todos_text = known.render()
    await db.commit()  # let go of the connection while the model reads

    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You review a developer's AI coding session to extract reusable lessons. Respond only with valid JSON."},
            {"role": "user", "content": _REVIEW_PROMPT.format(
                tool=cand.tool_id, project=cand.project or "未知", title=cand.title or "（无标题）",
                transcript=transcript, skills=skills_text, pitfalls=pitfalls_text, todos=todos_text,
            )},
        ],
        max_tokens=3000,
        timeout=180.0,
    )
    if raw is None:
        raise RuntimeError("session review got no answer from any AI provider")
    data = _safe_json_loads(raw)
    now = datetime.now(timezone.utc)
    evidence = {"doc_id": str(cand.doc_id), "title": cand.title[:120], "tool_id": cand.tool_id, "at": cand.last_at.isoformat()}
    result: dict[str, Any] = {"skill": None, "skill_event": None, "pitfalls_new": 0, "pitfalls_seen": [], "todos_new": 0, "todos_done": 0}

    skill = data.get("skill")
    if isinstance(skill, dict) and str(skill.get("description") or "").strip() and str(skill.get("body") or "").strip():
        existing = known.skills.get(str(skill.get("match") or ""))
        slug = existing.slug if existing else await unique_slug(db, user, slugify(skill.get("slug"), skill.get("title") or ""))
        if not skill.get("project"):
            skill["project"] = cand.project
        row, event = upsert_mined(user, skill, existing, evidence, slug, now)
        if existing is None:
            db.add(row)
        result["skill"], result["skill_event"] = row.slug, event

    for item in data.get("pitfalls") or []:
        if not isinstance(item, dict):
            continue
        matched = known.pitfalls.get(str(item.get("match") or ""))
        if matched is not None:
            result["pitfalls_seen"].append(str(matched.id))
            continue
        if await save_pitfall(db, user, item, cand.project, "outcome"):
            result["pitfalls_new"] += 1

    for item in data.get("todos_new") or []:
        if not isinstance(item, dict) or not clean_title(item.get("title")):
            continue
        _, created = await add_todo(
            db, user, str(item["title"]),
            detail=str(item.get("detail") or "").strip() or None,
            project=cand.project or None,
            due_at=parse_due(item.get("due")),
            source="session", evidence=f"会话「{cand.title[:60]}」结束时还没做完", source_doc_id=cand.doc_id,
        )
        result["todos_new"] += int(created)

    for item in data.get("todos_done") or []:
        if not isinstance(item, dict):
            continue
        todo = known.todos.get(str(item.get("d") or ""))
        if todo is not None and todo.status == "open":
            close_todo(todo, "done", f"会话「{cand.title[:60]}」：{str(item.get('evidence') or '')[:300]}")
            result["todos_done"] += 1

    outcome = str(data.get("outcome") or "unknown")
    await _record(db, user, cand, outcome if outcome in ("done", "partial", "failed", "chat") else "unknown",
                  str(data.get("summary") or "")[:500], result)
    await db.commit()
    return result


async def _record(db: AsyncSession, user: User, cand: Candidate, outcome: str, summary: str | None, result: dict) -> None:
    review = await db.get(SessionReview, cand.doc_id)
    if review is None:
        review = SessionReview(document_id=cand.doc_id, user_id=user.id)
        db.add(review)
    review.message_count = cand.messages
    review.outcome = outcome
    review.summary = summary
    review.result = result
    review.reviewed_at = datetime.now(timezone.utc)


async def review_sessions(db: AsyncSession, user: User, now: datetime | None = None) -> dict[str, Any]:
    """Review the sessions that finished since the last run."""
    now = now or datetime.now(timezone.utc)
    first_run = (await db.execute(
        select(func.count()).select_from(SessionReview).where(SessionReview.user_id == user.id)
    )).scalar() == 0
    candidates = await pick_sessions(db, user, now - (BACKFILL if first_run else WINDOW), now)
    totals: dict[str, Any] = {"reviewed": 0, "failed": 0, "skills_new": [], "skill_updates": 0,
                              "pitfalls_new": 0, "todos_new": 0, "todos_done": 0}
    for cand in candidates:
        try:
            result = await review_session(db, user, cand)
        except Exception as e:
            await db.rollback()
            logger.warning("Session review failed for %s: %s", cand.doc_id, e)
            totals["failed"] += 1
            prior = await db.get(SessionReview, cand.doc_id)
            errors = int(((prior.result or {}).get("errors") or 0) if prior and prior.outcome == "error" else 0) + 1
            await _record(db, user, cand, "error", f"{type(e).__name__}: {e}"[:300], {"errors": errors})
            await db.commit()
            continue
        totals["reviewed"] += 1
        if result["skill_event"] == "new":
            totals["skills_new"].append(result["skill"])
        elif result["skill_event"] == "update_pending":
            totals["skill_updates"] += 1
        totals["pitfalls_new"] += result["pitfalls_new"]
        totals["todos_new"] += result["todos_new"]
        totals["todos_done"] += result["todos_done"]
    return totals


# ---- failed agent tasks ----

_TASK_PROMPT = """下面是 AI agent 在用户设备上执行失败的任务，以及同一台设备之后成功的任务（可能就是修好的做法）。请提炼出以后值得提醒 AI 的"坑"：什么操作、为什么失败、正确做法是什么。

## 已经记下的坑
{pitfalls}

## 任务
{tasks}

要求：只写能从上面的输出里看出原因的；看不出原因、或只是偶发网络抖动的不写。和已记下的坑是同一个的，match 填它的编号。
只输出 JSON：{{"pitfalls": [{{"match": null, "title": "...", "symptom": "...", "cause": "...", "fix": "...", "project": null}}]}}"""


def _task_line(t: DeviceTask) -> str:
    payload = t.payload or {}
    what = payload.get("command") or payload.get("prompt") or t.action
    out = (t.stderr or t.error or t.stdout or "").strip()
    return (
        f"- [{t.status} exit={t.exit_code}] {t.action}: {str(what)[:300]}"
        + (f" (cwd {payload.get('cwd')})" if payload.get("cwd") else "")
        + (f"\n  输出: {squash(out)[-500:]}" if out else "")
    )


async def learn_from_tasks(db: AsyncSession, user: User, now: datetime | None = None) -> dict[str, int]:
    """Pitfalls from agent tasks that failed since the last run."""
    now = now or datetime.now(timezone.utc)
    cursor_key = f"task_outcomes_cursor:{user.id}"
    cursor = await ai_health.get_json(cursor_key)
    since = datetime.fromisoformat(cursor) if cursor else now - timedelta(days=14)
    failed = (await db.execute(
        select(DeviceTask).where(
            DeviceTask.user_id == user.id,
            DeviceTask.status.in_(("failed", "timeout")),
            DeviceTask.action.in_(("shell", "agent")),
            DeviceTask.finished_at > since,
        ).order_by(DeviceTask.finished_at).limit(30)
    )).scalars().all()
    if not failed:
        await ai_health.put_json(cursor_key, now.isoformat(), ttl_seconds=90 * 24 * 3600)
        return {"tasks": 0, "pitfalls_new": 0}

    blocks = []
    for t in failed:
        after = (await db.execute(
            select(DeviceTask).where(
                DeviceTask.device_id == t.device_id,
                DeviceTask.status == "succeeded",
                DeviceTask.created_at > t.finished_at,
                DeviceTask.created_at <= t.finished_at + timedelta(minutes=60),
            ).order_by(DeviceTask.created_at).limit(1)
        )).scalar_one_or_none()
        blocks.append(_task_line(t) + (f"\n  之后成功的: {_task_line(after)}" if after else ""))
    known = await load_known(db, user, None)
    _, pitfalls_text, _ = known.render()
    await db.commit()

    raw = await call_plain_chat(
        messages=[
            {"role": "system", "content": "You extract lessons from failed commands. Respond only with valid JSON."},
            {"role": "user", "content": _TASK_PROMPT.format(pitfalls=pitfalls_text, tasks="\n".join(blocks)[:12000])},
        ],
        max_tokens=2000,
    )
    if raw is None:
        raise RuntimeError("task outcome review got no answer from any AI provider")
    created = 0
    for item in _safe_json_loads(raw).get("pitfalls") or []:
        if isinstance(item, dict) and not known.pitfalls.get(str(item.get("match") or "")):
            if await save_pitfall(db, user, item, None, "agent_task"):
                created += 1
    await db.commit()
    last = max(t.finished_at for t in failed if t.finished_at)
    await ai_health.put_json(cursor_key, last.isoformat(), ttl_seconds=90 * 24 * 3600)
    return {"tasks": len(failed), "pitfalls_new": created}


# ---- numbers for the health page ----

async def review_stats(db: AsyncSession, user: User, days: int = 7) -> dict[str, Any]:
    since = datetime.now(timezone.utc) - timedelta(days=days)
    rows = (await db.execute(
        select(SessionReview.outcome, SessionReview.result).where(
            SessionReview.user_id == user.id, SessionReview.reviewed_at >= since,
        )
    )).all()
    outcomes: dict[str, int] = {}
    repeats = 0
    for outcome, result in rows:
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
        repeats += len((result or {}).get("pitfalls_seen") or [])
    tasks = (await db.execute(
        select(DeviceTask.status, func.count()).where(
            DeviceTask.user_id == user.id, DeviceTask.created_at >= since, DeviceTask.action.in_(("shell", "agent")),
        ).group_by(DeviceTask.status)
    )).all()
    task_counts = {status: n for status, n in tasks}
    finished = sum(task_counts.get(s, 0) for s in ("succeeded", "failed", "timeout"))
    pitfalls_new = (await db.execute(
        select(func.count()).select_from(UserMemory).where(
            UserMemory.user_id == user.id, UserMemory.category == "pitfall", UserMemory.created_at >= since,
        )
    )).scalar() or 0
    pitfalls_total = (await db.execute(
        select(func.count()).select_from(UserMemory).where(
            UserMemory.user_id == user.id, UserMemory.category == "pitfall", UserMemory.status == "active",
        )
    )).scalar() or 0
    return {
        "days": days,
        "sessions": len(rows),
        "outcomes": outcomes,
        "pitfall_repeats": repeats,
        "pitfalls_new": pitfalls_new,
        "pitfalls_total": pitfalls_total,
        "agent_tasks": {
            "finished": finished,
            "succeeded": task_counts.get("succeeded", 0),
            "success_rate": round(task_counts.get("succeeded", 0) / finished, 3) if finished else None,
        },
    }
