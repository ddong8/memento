"""Session Compactor Service — Hierarchical Sliding-Window Context Compression.

Provides 3-tier memory management for agent sessions:
1. Working Memory (Short-Term): High-fidelity recent turns (last K user turns and their final replies).
2. Episodic Memory (Mid-Term): The dialogue (tool calls/output dropped, base64 pruned), digested from the
   newest message back on top of the latest summary Claude Code wrote when it compacted the session,
   and summarized into a high-density structured Markdown checkpoint (<2k tokens).
3. Long-Term Memory (Persistent): Integrated with Memento Knowledge Graph / MCP.

Enables seamless continuation without triggering CLI / model token overflow
("Prompt is too long" / 429 credit errors).
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document
from .ai_provider import call_plain_chat, get_ai_providers
from .conversation_parser import parse_conversation

logger = logging.getLogger("server.session_compactor")

# Base64 image pattern
_BASE64_DATA_RE = re.compile(
    r"data:image/[a-zA-Z0-9\+\.\-]+;base64,[A-Za-z0-9+/=]{60,}",
    re.IGNORECASE,
)
_RAW_BASE64_BLOB_RE = re.compile(
    r'([A-Za-z0-9+/]{120,}={0,2})',
)
# File path heuristic
_FILE_PATH_RE = re.compile(
    r'(?:^|[\s"\'`\(])((?:[a-zA-Z0-9_\-\.]+/)+[a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9_]{1,10})(?:$|[\s"\'`\)])',
)
# Claude Code writes its own compaction summary of everything before it into the transcript as a user message
_CC_SUMMARY_MARK = "This session is being continued from a previous conversation"
_CC_SUMMARY_TAIL_RE = re.compile(r"\n\s*If you need specific details from before compaction[\s\S]*$")
# What a compacted continuation put in front of the first prompt of the session it started
_INJECTED_CONTEXT_RE = re.compile(r"^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*")
_INJECTED_HEAD_RE = re.compile(r"^【前序会话核心记忆快照[^】]*】\s*")
_INJECTED_RULES_MARK = "【执行规则】"
_INJECTED_PROMPT_RE = re.compile(r"\n\s*当前用户指令[：:]\s*")
_NOISE_TAG_RE = re.compile(r"<system-reminder>[\s\S]*?</system-reminder>|<artifact-content-authored-by-others/>")
# Assistant rows holding reasoning rather than a reply
_THINKING_TYPES = {"pb_thinking", "reasoning", "thinking"}
_LOCAL_TZ = timezone(timedelta(hours=8), "Asia/Shanghai")

# Digest budgets (characters). Even with a 128K-token window these leave plenty of room.
DIGEST_DETAIL_CHARS = 24_000   # newest stretch: user and assistant
DIGEST_OUTLINE_CHARS = 8_000   # the stretch before it: user instructions only
EARLIER_SUMMARY_CHARS = 12_000
# Recent turns shown verbatim after the checkpoint
RECENT_USER_CHARS = 1_500
RECENT_REPLY_CHARS = 1_500
RECENT_LAST_REPLY_CHARS = 4_000


@dataclass
class SessionStats:
    session_id: str
    message_count: int
    char_count: int
    estimated_tokens: int
    file_size_bytes: int
    base64_blobs_found: int
    status: str  # "normal" | "heavy" | "overflow_risk"
    compact_recommended: bool
    # Claude Code sessions: the real context of the next step and what continuing it costs (see claude_session)
    resume: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def estimate_tokens(text: str) -> int:
    """Fast estimation of token count across multilingual text (CJK + Latin)."""
    if not text:
        return 0
    cjk_count = 0
    for ch in text:
        code = ord(ch)
        if 0x4E00 <= code <= 0x9FFF or 0x3040 <= code <= 0x30FF or 0xAC00 <= code <= 0xD7AF:
            cjk_count += 1
    other_chars = len(text) - cjk_count
    return int(cjk_count * 1.5 + (other_chars / 3.5))


def calculate_session_stats(
    session_id: str,
    messages: list[dict[str, Any]],
    file_size_bytes: int = 0,
) -> SessionStats:
    """Analyze session messages to estimate token footprint, bloat, and health status."""
    total_chars = 0
    est_tokens = 0
    base64_blobs = 0

    for m in messages:
        content = str(m.get("content") or "")
        thinking = str(m.get("thinking") or "")
        combined = content + "\n" + thinking
        total_chars += len(combined)
        est_tokens += estimate_tokens(combined)

        blobs = _BASE64_DATA_RE.findall(combined)
        if blobs:
            base64_blobs += len(blobs)
        elif len(combined) > 5000:
            raw_blobs = _RAW_BASE64_BLOB_RE.findall(combined)
            base64_blobs += len(raw_blobs)

    # Status evaluation
    is_overflow = est_tokens > 90_000 or file_size_bytes > 700_000 or len(messages) > 80
    is_heavy = (est_tokens > 35_000 or file_size_bytes > 300_000 or len(messages) > 35) and not is_overflow

    status = "overflow_risk" if is_overflow else ("heavy" if is_heavy else "normal")
    compact_recommended = status != "normal"

    return SessionStats(
        session_id=session_id,
        message_count=len(messages),
        char_count=total_chars,
        estimated_tokens=est_tokens,
        file_size_bytes=file_size_bytes,
        base64_blobs_found=base64_blobs,
        status=status,
        compact_recommended=compact_recommended,
    )


def prune_message_payloads(
    messages: list[dict[str, Any]],
    max_tool_output_chars: int = 800,
) -> list[dict[str, Any]]:
    """Prune non-essential bloat (base64 image blobs, giant raw command outputs).

    Preserves critical user intent, code diff snippets, and errors while slashing token size.
    """
    cleaned: list[dict[str, Any]] = []

    for m in messages:
        raw_content = str(m.get("content") or "")
        role = m.get("role", "user")

        # 1. Strip base64 image data
        content = _BASE64_DATA_RE.sub("[图片附件: base64 数据已在历史记录中处理]", raw_content)
        if len(content) > 3000:
            content = _RAW_BASE64_BLOB_RE.sub("[二进制/Base64数据已省略]", content)

        # 2. Truncate long tool outputs / command returns in older messages
        if role in ("tool", "system") or m.get("raw_type") in ("tool_output", "tool_result"):
            if len(content) > max_tool_output_chars:
                head = content[:max_tool_output_chars // 2]
                tail = content[-(max_tool_output_chars // 2):]
                content = f"{head}\n\n...[历史工具长输出截断，省略 {len(content) - max_tool_output_chars} 字符]...\n\n{tail}"

        # 3. Truncate long assistant thinking if preserved
        thinking = m.get("thinking")
        if thinking and len(str(thinking)) > 1000:
            thinking = str(thinking)[:1000] + "...[思考链已精简]"

        item = dict(m)
        item["content"] = content
        if thinking is not None:
            item["thinking"] = thinking
        cleaned.append(item)

    return cleaned


def is_dialogue(m: dict[str, Any]) -> bool:
    """A user prompt or an assistant reply; tool calls, tool output and reasoning are not."""
    if m.get("role") not in ("user", "assistant") or (m.get("raw_type") or "") in _THINKING_TYPES:
        return False
    content = str(m.get("content") or "")
    return bool(content.strip()) and not content.startswith("[Tool:") and not content.startswith("[Result]")


def _is_cc_summary(m: dict[str, Any]) -> bool:
    return m.get("role") == "user" and _CC_SUMMARY_MARK in str(m.get("content") or "")[:2000]


def clean_text(content: str) -> str:
    """Drop context memento or the CLI injected around what the user actually typed."""
    return _NOISE_TAG_RE.sub("", _INJECTED_CONTEXT_RE.sub("", content)).strip()


def _clip(text: str, limit: int) -> str:
    """Keep head and tail: the ask and the conclusion."""
    text = text.strip()
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n…[省略 {len(text) - limit} 字]…\n{text[-half:]}"


def _stamp(ts: Any) -> str:
    if not ts:
        return ""
    try:
        dt = ts if isinstance(ts, datetime) else datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(_LOCAL_TZ).strftime("%m-%d %H:%M")
    except ValueError:
        return ""


def split_injected_context(content: str) -> tuple[str, str] | None:
    """A prompt that started a compacted continuation: (the context it carried over, without its header
    and rules; what the user asked). None for any other prompt."""
    if not _INJECTED_HEAD_RE.match(content):
        return None
    rules = content.find(_INJECTED_RULES_MARK)
    if rules >= 0:
        ask = _INJECTED_PROMPT_RE.search(content, rules)
        carried, prompt = content[:rules], (content[ask.end():] if ask else "")
    else:
        m = _INJECTED_CONTEXT_RE.match(content)
        if not m:
            return None
        carried, prompt = _INJECTED_PROMPT_RE.sub("", content[:m.end()]), content[m.end():]
    return _INJECTED_HEAD_RE.sub("", carried).strip(), prompt.strip()


def split_at_latest_summary(messages: list[dict[str, Any]]) -> tuple[str, str, list[dict[str, Any]]]:
    """Split at the latest summary of what came before: the one Claude Code wrote when it compacted the
    session, or the context a compacted continuation carried into the session's first prompt (so a chain
    of continuations keeps the history from before the previous one).

    Returns (summary, when it was written, messages after it); the summary covers everything before it.
    Without one: ("", "", messages).
    """
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if _is_cc_summary(m):
            text = str(m.get("content") or "")
            pos = text.find("Summary:")
            body = text[pos + len("Summary:"):] if pos >= 0 else text[text.find(_CC_SUMMARY_MARK):]
            return _CC_SUMMARY_TAIL_RE.sub("", body).strip(), _stamp(m.get("timestamp")), messages[i + 1:]
        if m.get("role") == "user":
            injected = split_injected_context(str(m.get("content") or ""))
            if injected and injected[0]:
                carried, prompt = injected
                rest = messages[i + 1:]
                return carried, _stamp(m.get("timestamp")), ([{**m, "content": prompt}, *rest] if prompt else rest)
    return "", "", messages


def split_sliding_window(
    messages: list[dict[str, Any]],
    recent_turns: int = 6,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split conversation messages into:

    - older_messages: everything before the recent turns.
    - recent_messages: the last recent_turns turns (a user prompt and the replies to it), kept verbatim.
    """
    users = [i for i, m in enumerate(messages) if m.get("role") == "user" and not _is_cc_summary(m)]
    if len(users) <= recent_turns:
        return [], list(messages)
    split_index = users[-recent_turns]
    return messages[:split_index], messages[split_index:]


def build_digest(
    messages: list[dict[str, Any]],
    detail_chars: int = DIGEST_DETAIL_CHARS,
    outline_chars: int = DIGEST_OUTLINE_CHARS,
) -> str:
    """Chronological digest of user/assistant messages that always reaches the newest one.

    Walking back from the newest, messages keep detail (each turn's final reply more than the progress
    notes before it) until detail_chars; earlier ones keep only the user's instructions until
    outline_chars; anything older is dropped and counted.
    """
    detail: list[str] = []
    outline: list[str] = []
    used = 0
    i = len(messages) - 1
    while i >= 0:
        m = messages[i]
        text = " ".join(clean_text(str(m.get("content") or "")).split())
        if text:
            if m.get("role") == "user":
                line = f"[{_stamp(m.get('timestamp'))}] 用户: {text[:600]}"
            else:
                final = i == len(messages) - 1 or messages[i + 1].get("role") == "user"
                line = f"[{_stamp(m.get('timestamp'))}] 助手: {text[:1200] if final else text[:240]}"
            if used + len(line) > detail_chars:
                break
            detail.append(line)
            used += len(line)
        i -= 1

    used = 0
    dropped = 0
    while i >= 0:
        m = messages[i]
        if m.get("role") == "user":
            text = " ".join(clean_text(str(m.get("content") or "")).split())
            if text:
                line = f"[{_stamp(m.get('timestamp'))}] 用户: {text[:160]}"
                if used + len(line) > outline_chars:
                    dropped = i + 1
                    break
                outline.append(line)
                used += len(line)
        i -= 1

    parts: list[str] = []
    if dropped:
        parts.append(f"…（更早的 {dropped} 条消息已省略）")
    if outline:
        parts.append("（较早阶段：只保留用户指令）")
        parts.extend(reversed(outline))
        parts.append("（最近阶段：用户与助手的对话）")
    parts.extend(reversed(detail))
    return "\n".join(parts)


def _recent_files(messages: list[dict[str, Any]], extra: str = "", limit: int = 15) -> list[str]:
    """File paths mentioned, most recent first."""
    found: dict[str, None] = {}
    for text in [str(m.get("content") or "") for m in reversed(messages)] + [extra]:
        for f in _FILE_PATH_RE.findall(text):
            if "/" in f and not f.startswith("http") and len(f) < 80:
                found.setdefault(f, None)
                if len(found) >= limit:
                    return list(found)
    return list(found)


async def generate_checkpoint_summary(
    messages: list[dict[str, Any]],
    session_title: str = "",
    tool_id: str = "",
    earlier_summary: str = "",
    earlier_until: str = "",
) -> str:
    """Generate a high-density structured Markdown checkpoint of the session.

    messages: the user/assistant messages to digest, oldest first. earlier_summary: the summary of what
    came before them, Claude Code's own or the context a previous continuation carried (see
    split_at_latest_summary). The digest is budgeted from the
    newest message back, so the checkpoint reflects where the session actually stands.
    """
    if not messages and not earlier_summary:
        return ""

    stamps = [s for s in (_stamp(m.get("timestamp")) for m in messages) if s]
    span = f"{stamps[0]} ~ {stamps[-1]}" if stamps else "未知"
    files = _recent_files(messages, earlier_summary)
    file_hints = ", ".join(files) if files else "未显式指定"

    if get_ai_providers():
        sections = []
        if earlier_summary:
            sections.append(
                f"【第一部分：截至 {earlier_until or '压缩时'} 的早期历史摘要】\n"
                f"{_clip(earlier_summary, EARLIER_SUMMARY_CHARS)}"
            )
        if messages:
            label = "第二部分：之后的对话流水" if earlier_summary else "对话流水"
            sections.append(f"【{label}（按时间先后排列，越往后越新）】\n{build_digest(messages)}")
        history = "\n\n".join(sections)
        prompt = f"""你是一个高级 AI 编程会话记忆提炼专家。
请把下面这个 AI 编程会话的历史提炼成一份高密度、结构化的「核心记忆快照（Context Checkpoint）」，交给接手的新会话继续工作。

会话主题：{session_title or '未知任务'}
工具环境：{tool_id or '通用 Agent'}
时间跨度：{span}（共 {len(messages)} 条对话消息{'，另有更早历史见第一部分' if earlier_summary else ''}）
最近涉及的文件：{file_hints}

{history}

【要求】
1) 以最新进展为准：后面的内容覆盖前面的；已经完成、已经上线的事项不要写成进行中或待办。
2) 「当前遗留状态与未决问题」只写会话最后阶段仍未完成的事、用户最后的指令和还没回答的问题。
3) 保留关键文件路径、提交号、版本号、命令和用户明确提出的要求；不要写入密钥、口令、Token 的具体值。
4) 用中文、Markdown，控制在 600-1000 字。

【输出格式】
### 核心记忆快照 (Context Checkpoint)
- 任务核心目标：整个会话要达成什么，最近一段在做什么。
- 已完成的关键工作与进展：按时间列出关键修复或开发及结果（提交号、上线版本）。
- 修改/涉及的关键文件：核心改动或关注的文件路径及主要修改内容。
- 关键决议与技术约定：架构方案、环境参数、避坑要点、用户定下的规矩。
- 当前遗留状态与未决问题：会话最后停在哪里，还有什么没做完。
"""
        try:
            summary = await call_plain_chat(
                [
                    {"role": "system", "content": "你擅长提炼高密度的技术上下文记忆快照，语言精炼准确，保留关键技术细节与文件名。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=2000,
                timeout=90.0,
            )
            if summary and summary.strip():
                return summary.strip()
        except Exception as e:
            logger.warning("LLM checkpoint generation failed, falling back to heuristic: %s", e)

    # Heuristic fallback if LLM is not configured or fails
    user_prompts = [
        " ".join(clean_text(str(m.get("content") or "")).split())[:200]
        for m in messages if m.get("role") == "user"
    ]
    user_prompts = [p for p in user_prompts if p]
    initial_goal = user_prompts[0] if user_prompts else "无明确初始目标"

    summary_md = f"""### 核心记忆快照 (Context Checkpoint)
- 任务核心目标：{initial_goal}
- 涉及核心文件：{file_hints}
- 前序轮次总结：该会话前序已交互 {len(messages)} 条对话消息（{span}）。"""
    if len(user_prompts) > 1:
        latest = "；".join(f"{n}) {p}" for n, p in enumerate(user_prompts[-3:], 1))
        summary_md += f"\n- 最近的用户指令：{latest}"
    if earlier_summary:
        summary_md += f"\n- 更早历史（截至 {earlier_until or '压缩时'} 的摘要）：\n{_clip(earlier_summary, 4000)}"

    return summary_md


def _render_recent(messages: list[dict[str, Any]]) -> list[str]:
    """Each recent turn as the user's prompt and the final reply to it; the progress notes in
    between are in the checkpoint."""
    dialogue = [m for m in messages if is_dialogue(m) and not _is_cc_summary(m)]
    kept = [
        m for i, m in enumerate(dialogue)
        if m.get("role") == "user" or i == len(dialogue) - 1 or dialogue[i + 1].get("role") == "user"
    ]
    lines = []
    for i, m in enumerate(kept):
        user = m.get("role") == "user"
        limit = RECENT_USER_CHARS if user else (RECENT_LAST_REPLY_CHARS if i == len(kept) - 1 else RECENT_REPLY_CHARS)
        text = _clip(clean_text(str(m.get("content") or "")), limit)
        if text:
            stamp = _stamp(m.get("timestamp"))
            lines.append(f"- {f'[{stamp}] ' if stamp else ''}{'用户' if user else '助手'}: {text}")
    return lines


def format_injected_context(
    checkpoint_summary: str,
    recent_messages: list[dict[str, Any]],
    original_session_id: str = "",
) -> str:
    """Format the compacted context into a structured block suitable for system prompt or agent injection."""
    parts = []
    sid_hint = f"（原会话 ID: {original_session_id[:8]}...）" if original_session_id else ""
    parts.append(f"【前序会话核心记忆快照{sid_hint}】")
    if checkpoint_summary:
        parts.append(checkpoint_summary.strip())
    else:
        parts.append("*(前序会话未生成快照)*")

    recent = _render_recent(recent_messages)
    if recent:
        parts.append("\n【承接前序会话的最近上下文（保持精确细节）】")
        parts.extend(recent)

    parts.append("\n【执行规则】")
    parts.append("你已完整继承以上前序会话的全部背景、修改记录和决议。请紧密结合前序上下文，直接执行用户的最新指令，无需重复提问已知背景。")

    return "\n".join(parts)


# Context a Claude Code session can still grow into before a resume risks running out of room
OVERFLOW_CONTEXT_TOKENS = 500_000


async def _claude_context(db: AsyncSession, doc: Document) -> dict[str, Any]:
    """The session's real context from its transcript; read once from the stored tail for sessions
    synced before ingest started recording it (ingest keeps it current from then on)."""
    from .claude_session import session_activity

    meta = dict(doc.metadata_ or {})
    if "context_tokens" not in meta:
        tail = (await db.execute(
            select(func.right(Document.content, 2_000_000)).where(Document.id == doc.id)
        )).scalar_one_or_none() or ""
        found = session_activity(tail)
        if found:
            meta.update(found)
            doc.metadata_ = meta
    return meta


async def _find_session(db: AsyncSession, session_id: str, machine_ids: list | None) -> Document | None:
    """The session's document by session / cascade id, else by document id. machine_ids limits the
    lookup to those devices' sessions (None: every session, for owner / admin)."""
    q = select(Document).where(
        (Document.metadata_.op("->>")("session_id") == session_id)
        | (Document.metadata_.op("->>")("cascade_id") == session_id)
    )
    if machine_ids is not None:
        q = q.where(Document.machine_id.in_(machine_ids))
    doc = (await db.execute(q.order_by(Document.synced_at.desc()).limit(1))).scalar_one_or_none()
    if doc:
        return doc
    try:
        doc_uuid = uuid.UUID(session_id)
    except ValueError:
        return None
    q = select(Document).where(Document.id == doc_uuid)
    if machine_ids is not None:
        q = q.where(Document.machine_id.in_(machine_ids))
    return (await db.execute(q)).scalar_one_or_none()


async def get_session_stats(db: AsyncSession, session_id: str, machine_ids: list | None = None) -> SessionStats:
    """Load session and calculate stats and health metrics. machine_ids limits the lookup to those
    devices' sessions (None: every session, for owner / admin)."""
    from .claude_session import HEAVY_CONTEXT_TOKENS, resume_cost

    doc = await _find_session(db, session_id, machine_ids)

    messages: list[dict[str, Any]] = []
    file_size_bytes = 0

    if doc and doc.tool_id == "claude_code":
        resume = resume_cost(await _claude_context(db, doc))
        if resume:
            tokens = resume["context_tokens"]
            status = "overflow_risk" if tokens > OVERFLOW_CONTEXT_TOKENS else ("heavy" if tokens > HEAVY_CONTEXT_TOKENS else "normal")
            count = (await db.execute(
                select(func.count()).select_from(ConversationMessage).where(ConversationMessage.document_id == doc.id)
            )).scalar_one()
            return SessionStats(
                session_id=session_id,
                message_count=count,
                char_count=0,
                estimated_tokens=tokens,
                file_size_bytes=doc.file_size_bytes or 0,
                base64_blobs_found=0,
                status=status,
                compact_recommended=status != "normal",
                resume=resume,
            )

    if doc:
        file_size_bytes = doc.file_size_bytes or 0
        c_msgs = (await db.execute(
            select(ConversationMessage)
            .where(ConversationMessage.document_id == doc.id)
            .order_by(ConversationMessage.line_number)
        )).scalars().all()

        if c_msgs:
            messages = [
                {
                    "role": m.role or "user",
                    "content": m.content,
                    "thinking": (m.metadata_ or {}).get("thinking") if m.metadata_ else None,
                }
                for m in c_msgs
                if m.content
            ]
        elif doc.content:
            parsed = parse_conversation(doc.content, doc.tool_id)
            messages = [{"role": p.role, "content": p.content, "thinking": p.thinking} for p in parsed if p.content]

    return calculate_session_stats(session_id, messages, file_size_bytes=file_size_bytes)


async def build_compacted_continuation(
    db: AsyncSession,
    session_id: str,
    new_user_prompt: str,
    recent_turns: int = 6,
    machine_ids: list | None = None,
) -> dict[str, Any]:
    """Load a session, perform hierarchical sliding-window compaction, and construct the continuation payload.

    machine_ids limits it to those devices' sessions (None: every session, for owner / admin). A session
    that isn't found gives an empty injected_context, so callers fall back to their normal path.
    """
    doc = await _find_session(db, session_id, machine_ids)
    if not doc:
        return {
            "session_id": session_id,
            "title": session_id[:8],
            "tool_id": "",
            "stats": calculate_session_stats(session_id, []).to_dict(),
            "checkpoint": "",
            "recent_messages": [],
            "injected_context": "",
            "new_prompt_with_context": new_user_prompt,
        }

    doc_title = doc.title or ""
    tool_id = doc.tool_id or "claude_code"
    # Only the dialogue: tool output is most of a long session and the replies already say what it showed
    rows = (await db.execute(
        select(
            ConversationMessage.role,
            ConversationMessage.content,
            ConversationMessage.timestamp,
            ConversationMessage.message_type,
        )
        .where(
            ConversationMessage.document_id == doc.id,
            ConversationMessage.role.in_(("user", "assistant")),
        )
        .order_by(ConversationMessage.line_number)
    )).all()

    if rows:
        messages = [
            {
                "role": r.role,
                "content": r.content,
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "raw_type": r.message_type or "",
            }
            for r in rows
        ]
    elif doc.content:
        messages = [
            {"role": p.role, "content": p.content, "timestamp": p.timestamp, "raw_type": p.raw_type}
            for p in parse_conversation(doc.content, doc.tool_id)
        ]
    else:
        messages = []
    messages = [m for m in messages if is_dialogue(m)]

    stats = calculate_session_stats(session_id, messages, file_size_bytes=doc.file_size_bytes or 0)
    pruned_msgs = prune_message_payloads(messages)
    earlier, earlier_until, after = split_at_latest_summary(pruned_msgs)
    older, recent = split_sliding_window(after, recent_turns=recent_turns)

    # Short sessions are all in the recent turns; otherwise the checkpoint covers the whole session up to
    # the newest message, so its "where things stand" is current
    checkpoint = ""
    if older or earlier:
        checkpoint = await generate_checkpoint_summary(
            after, session_title=doc_title, tool_id=tool_id,
            earlier_summary=earlier, earlier_until=earlier_until,
        )

    injected_context = format_injected_context(
        checkpoint_summary=checkpoint,
        recent_messages=recent,
        original_session_id=session_id,
    )

    return {
        "session_id": session_id,
        "title": doc_title or session_id[:8],
        "tool_id": tool_id,
        "stats": stats.to_dict(),
        "checkpoint": checkpoint,
        "recent_messages": recent,
        "injected_context": injected_context,
        "new_prompt_with_context": f"{injected_context}\n\n当前用户指令：\n{new_user_prompt}" if new_user_prompt else injected_context,
    }
