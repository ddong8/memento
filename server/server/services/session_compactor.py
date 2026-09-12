"""Session Compactor Service — Hierarchical Sliding-Window Context Compression.

Provides 3-tier memory management for agent sessions:
1. Working Memory (Short-Term): High-fidelity recent turns (last K messages).
2. Episodic Memory (Mid-Term): Older turns pruned (base64/huge tool logs removed)
   and summarized into a high-density structured Markdown checkpoint (<2k tokens).
3. Long-Term Memory (Persistent): Integrated with Memento Knowledge Graph / MCP.

Enables seamless continuation without triggering CLI / model token overflow
("Prompt is too long" / 429 credit errors).
"""

from __future__ import annotations

import logging
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
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

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def estimate_tokens(text: str) -> int:
    """Fast estimation of token count across multilingual text (CJK + Latin)."""
    if not text:
        return 0
    cjk_count = len(re.findall(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]", text))
    other_chars = len(text) - cjk_count
    return int(cjk_count * 1.5 + (other_chars / 3.5))


def calculate_session_stats(
    session_id: str,
    messages: list[dict[str, Any]],
    file_size_bytes: int = 0,
) -> SessionStats:
    """Analyze session messages to estimate token footprint, bloat, and health status."""
    total_chars = 0
    base64_blobs = 0

    for m in messages:
        content = str(m.get("content") or "")
        thinking = str(m.get("thinking") or "")
        combined = content + "\n" + thinking
        total_chars += len(combined)

        blobs = _BASE64_DATA_RE.findall(combined)
        if blobs:
            base64_blobs += len(blobs)
        elif len(combined) > 5000:
            raw_blobs = _RAW_BASE64_BLOB_RE.findall(combined)
            base64_blobs += len(raw_blobs)

    est_tokens = estimate_tokens("x" * total_chars)

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


def split_sliding_window(
    messages: list[dict[str, Any]],
    recent_turns: int = 6,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split conversation messages into:

    - older_messages: messages to be compressed into a checkpoint.
    - recent_messages: recent working memory (up to recent_turns user/assistant pairs) kept verbatim.
    """
    if len(messages) <= recent_turns * 2:
        return [], list(messages)

    split_index = max(0, len(messages) - (recent_turns * 2))
    older = messages[:split_index]
    recent = messages[split_index:]
    return older, recent


async def generate_checkpoint_summary(
    older_messages: list[dict[str, Any]],
    session_title: str = "",
    tool_id: str = "",
) -> str:
    """Generate a high-density structured Markdown checkpoint from older messages.

    Extracts: Core goal, Key milestones/changes, Touched files, Architectural decisions, Pending tasks.
    """
    if not older_messages:
        return ""

    digest_lines: list[str] = []
    files_touched: set[str] = set()

    for m in older_messages:
        role = m.get("role", "user")
        content = str(m.get("content") or "").strip()
        if not content:
            continue

        for f in _FILE_PATH_RE.findall(content):
            if "/" in f and not f.startswith("http") and len(f) < 80:
                files_touched.add(f)

        prefix = "👤 用户" if role == "user" else ("🤖 助手" if role == "assistant" else "⚙️ 系统/工具")
        snippet = content[:600].replace("\n", " ")
        digest_lines.append(f"{prefix}: {snippet}")

    digest_text = "\n".join(digest_lines)
    if len(digest_text) > 12_000:
        digest_text = digest_text[:12_000] + "\n...(更早历史已截断)"

    file_hints = ", ".join(list(files_touched)[:15]) if files_touched else "未显式指定"

    if get_ai_providers():
        prompt = f"""你是一个高级 AI 编程会话记忆提炼专家。
请将以下 AI 编程会话的前序历史记录，提炼为一份高密度、结构化的「核心记忆快照（Context Checkpoint）」，供后续对话继承使用。

会话主题：{session_title or '未知任务'}
工具环境：{tool_id or '通用 Agent'}
涉及文件参考：{file_hints}

前序对话流水：
{digest_text}

【输出格式要求（请用 Markdown，控制在 500-800 字以内）】：
### 核心记忆快照 (Context Checkpoint)
- **任务核心目标**：用户最初要解决什么核心问题或达成什么目标？
- **已完成的关键工作与进展**：执行了哪些关键修复或开发？
- **修改/涉及的关键文件**：列出核心改动或关注的文件路径及主要修改内容。
- **关键决议与技术约定**：约定了什么架构方案、环境参数或避坑要点？
- **当前遗留状态与未决问题**：会话进行到此处时，遗留了什么未解决的报错、待办任务或当前上下文？
"""
        try:
            summary = await call_plain_chat(
                [
                    {"role": "system", "content": "你擅长提炼高密度的技术上下文记忆快照，语言精炼准确，保留关键技术细节与文件名。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=1000,
                timeout=45.0,
            )
            if summary and summary.strip():
                return summary.strip()
        except Exception as e:
            logger.warning("LLM checkpoint generation failed, falling back to heuristic: %s", e)

    # Heuristic fallback if LLM is not configured or fails
    first_user_prompts = [
        str(m.get("content") or "")[:200] for m in older_messages if m.get("role") == "user"
    ]
    initial_goal = first_user_prompts[0] if first_user_prompts else "无明确初始目标"
    last_user_prompt = first_user_prompts[-1] if len(first_user_prompts) > 1 else ""

    summary_md = f"""### 核心记忆快照 (Context Checkpoint)
- **任务核心目标**：{initial_goal}
- **涉及核心文件**：{file_hints}
- **前序轮次总结**：该会话前序已交互 {len(older_messages)} 条记录。"""

    if last_user_prompt:
        summary_md += f"\n- **前序阶段最后指令**：{last_user_prompt}"

    return summary_md


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

    if recent_messages:
        parts.append("\n【承接前序会话的最近上下文（保持精确细节）】")
        for m in recent_messages[-6:]:
            role = m.get("role", "user")
            prefix = "用户" if role == "user" else "助手"
            c = str(m.get("content") or "").strip()
            if len(c) > 400:
                c = c[:400] + "..."
            parts.append(f"- {prefix}: {c}")

    parts.append("\n【执行规则】")
    parts.append("你已完整继承以上前序会话的全部背景、修改记录和决议。请紧密结合前序上下文，直接执行用户的最新指令，无需重复提问已知背景。")

    return "\n".join(parts)


async def get_session_stats(db: AsyncSession, session_id: str) -> SessionStats:
    """Load session and calculate stats and health metrics."""
    doc = (await db.execute(
        select(Document).where(
            (Document.metadata_.op("->>")("session_id") == session_id)
            | (Document.metadata_.op("->>")("cascade_id") == session_id)
        ).limit(1)
    )).scalar_one_or_none()

    if not doc:
        try:
            doc_uuid = uuid.UUID(session_id)
            doc = (await db.execute(select(Document).where(Document.id == doc_uuid))).scalar_one_or_none()
        except Exception:
            pass

    messages: list[dict[str, Any]] = []
    file_size_bytes = 0

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
) -> dict[str, Any]:
    """Load a session, perform hierarchical sliding-window compaction, and construct the continuation payload."""
    doc = (await db.execute(
        select(Document).where(
            (Document.metadata_.op("->>")("session_id") == session_id)
            | (Document.metadata_.op("->>")("cascade_id") == session_id)
        ).limit(1)
    )).scalar_one_or_none()

    if not doc:
        try:
            doc_uuid = uuid.UUID(session_id)
            doc = (await db.execute(select(Document).where(Document.id == doc_uuid))).scalar_one_or_none()
        except Exception:
            pass

    messages: list[dict[str, Any]] = []
    doc_title = ""
    tool_id = "claude_code"
    file_size_bytes = 0

    if doc:
        doc_title = doc.title or ""
        tool_id = doc.tool_id or "claude_code"
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
                    "timestamp": m.timestamp.isoformat() if m.timestamp else None,
                    "raw_type": m.message_type or "",
                }
                for m in c_msgs
                if m.content and not m.content.startswith("[Tool:") and not m.content.startswith("[Result]")
            ]
        elif doc.content:
            parsed = parse_conversation(doc.content, doc.tool_id)
            messages = [
                {
                    "role": p.role,
                    "content": p.content,
                    "thinking": p.thinking,
                    "timestamp": p.timestamp,
                    "raw_type": p.raw_type,
                }
                for p in parsed
                if p.content
            ]

    stats = calculate_session_stats(session_id, messages, file_size_bytes=file_size_bytes)
    pruned_msgs = prune_message_payloads(messages)
    older, recent = split_sliding_window(pruned_msgs, recent_turns=recent_turns)

    checkpoint = await generate_checkpoint_summary(
        older, session_title=doc_title, tool_id=tool_id,
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
