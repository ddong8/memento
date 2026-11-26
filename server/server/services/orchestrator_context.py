"""Context Compression & Token Budget Management for AI 编排 (`execution_mode == "ai"`).

Implements a 2-layer recency-first compaction architecture adhering to Memento's
compaction contract:
1. Cross-turn rolling history compaction (`prepare_ai_history` & `compact_ai_conversation`):
   - Works on full `AskConversation.turns`, not just a fixed 6-turn hard cutoff.
   - Persists an incremental rolling checkpoint inside `AskConversation.config["ai_context_checkpoint"]`
     so already-compacted older turns are never re-summarized.
   - Supports both automatic compaction (when turn count or estimated tokens exceed soft limits)
     and manual one-click compaction (`POST /api/ask/conversations/{conv_id}/compact` or `compact_mode=True`).
   - Recency-first digest: newest turns keep verbatim high-fidelity detail; older turns are condensed
     on top of any earlier checkpoint summary; noisy raw tool dumps and base64 blobs are pruned.
   - Checkpoint is injected ONCE cleanly into the conversation history (never duplicated in system + user).
2. In-loop multi-round tool-call compaction (`compact_loop_messages`):
   - Monitors live token consumption before each LLM call in `run_agent_loop`.
   - Stage A (zero-latency micro-compaction): compresses older rounds' bulky `role == "tool"` payloads
     into concise structured digests while preserving the newest rounds verbatim.
   - Stage B (rolling LLM summary): when Stage A is still over budget (or on HTTP context-length
     overflow recovery), summarizes older intermediate rounds into a single compact memory note
     while keeping valid `assistant(tool_calls) -> tool` message pairing intact.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AskConversation, User
from ..db.session import async_session_factory
from .ai_provider import call_plain_chat, get_ai_providers
from .session_compactor import estimate_tokens

logger = logging.getLogger("server.orchestrator_context")

# Configurable defaults (tunable via environment variables without code changes)
AI_CONTEXT_BUDGET_TOKENS = int(os.environ.get("MEMENTO_AI_CONTEXT_BUDGET_TOKENS", "64000"))
AI_HISTORY_SOFT_TOKENS = int(os.environ.get("MEMENTO_AI_HISTORY_SOFT_TOKENS", "14000"))
AI_MAX_RAW_TURNS = int(os.environ.get("MEMENTO_AI_MAX_RAW_TURNS", "12"))
AI_RECENT_TURNS_KEEP = int(os.environ.get("MEMENTO_AI_RECENT_TURNS_KEEP", "6"))
AI_IN_LOOP_COMPACT_RATIO = float(os.environ.get("MEMENTO_AI_IN_LOOP_COMPACT_RATIO", "0.75"))

_BASE64_RE = re.compile(r"data:image/[a-zA-Z0-9\+\.\-]+;base64,[A-Za-z0-9+/=]{60,}", re.IGNORECASE)
_CONTEXT_OVERFLOW_PATTERNS = (
    "context_length_exceeded",
    "maximum context length",
    "context window",
    "too many tokens",
    "prompt is too long",
    "input length",
    "max_context_length",
    "exceeds the maximum",
)

CHECKPOINT_CONFIG_KEY = "ai_context_checkpoint"


@dataclass
class CompactionEvent:
    scope: str  # "history" | "in_loop"
    mode: str  # "auto" | "manual" | "overflow_recovery"
    before_tokens: int
    after_tokens: int
    compacted_turns: int
    kept_turns: int
    summary: str

    def to_sse(self) -> dict[str, Any]:
        return {
            "type": "context_compacted",
            **asdict(self),
            "saved_tokens": max(0, self.before_tokens - self.after_tokens),
        }


def is_context_overflow_error(err: Exception | str) -> bool:
    """Detect upstream LLM context-window overflow errors for automatic recovery."""
    msg = str(err).lower()
    return any(p in msg for p in _CONTEXT_OVERFLOW_PATTERNS)


def estimate_message_tokens(msg: dict[str, Any]) -> int:
    """Estimate tokens of one OpenAI-format message or stored AskConversation turn."""
    tokens = 6  # structural framing overhead
    content = msg.get("content")
    if isinstance(content, str):
        cleaned = _BASE64_RE.sub("[image]", content)
        tokens += estimate_tokens(cleaned)
    elif isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            ptype = part.get("type")
            if ptype == "text":
                tokens += estimate_tokens(str(part.get("text") or ""))
            elif ptype == "image_url":
                tokens += 765

    tool_calls = msg.get("tool_calls") or msg.get("toolCalls")
    if isinstance(tool_calls, list) and tool_calls:
        for tc in tool_calls:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
            if fn:
                tokens += estimate_tokens(str(fn.get("name") or ""))
                tokens += estimate_tokens(str(fn.get("arguments") or "")) + 8
            else:
                tokens += estimate_tokens(str(tc.get("name") or ""))
                args = tc.get("args")
                if args:
                    try:
                        tokens += estimate_tokens(json.dumps(args, ensure_ascii=False)[:1200])
                    except Exception:
                        pass
                res = tc.get("result")
                if isinstance(res, dict):
                    res_preview = str(res.get("stdout") or res.get("markdown") or res.get("error") or "")[:1200]
                    tokens += estimate_tokens(res_preview)
    return tokens


def estimate_messages_tokens(messages: list[dict[str, Any]] | None) -> int:
    if not messages:
        return 0
    return sum(estimate_message_tokens(m) for m in messages if isinstance(m, dict))


def _summarize_tool_calls_brief(tool_calls: list[dict[str, Any]] | None) -> str:
    """One-line per tool call digest for older turns (filters noisy stdout dumps)."""
    if not tool_calls:
        return ""
    bits: list[str] = []
    for tc in tool_calls[:8]:
        if not isinstance(tc, dict):
            continue
        name = str(tc.get("name") or "tool")
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        res = tc.get("result") if isinstance(tc.get("result"), dict) else {}
        dev = tc.get("device_name") or res.get("device_name") or args.get("device_id") or ""
        target = (
            args.get("query")
            or args.get("project_name")
            or args.get("entity_name")
            or args.get("doc_id")
            or args.get("url")
            or args.get("command")
            or args.get("prompt")
            or args.get("action")
            or args.get("title")
            or ""
        )
        target_s = str(target).replace("\n", " ").strip()[:80]
        status = "失败" if res.get("error") or res.get("status") == "failed" else "成功"
        dev_s = f"@{dev}" if dev else ""
        bits.append(f"{name}{dev_s}({target_s})→{status}")
    return "；".join(bits)


def _build_recency_digest(
    turns: list[dict[str, Any]],
    earlier_summary: str = "",
    detail_chars: int = 16000,
    outline_chars: int = 4000,
) -> str:
    """Walk backwards from newest turn so latest conclusions & user intent are never dropped."""
    detail: list[str] = []
    outline: list[str] = []
    used = 0
    i = len(turns) - 1

    while i >= 0:
        t = turns[i]
        role = t.get("role")
        raw_content = _BASE64_RE.sub("[图片]", str(t.get("content") or "")).strip()
        tc_brief = _summarize_tool_calls_brief(t.get("tool_calls") or t.get("toolCalls"))
        if role == "user" and raw_content:
            line = f"用户: {raw_content[:700]}"
        elif role == "assistant":
            pieces = []
            if tc_brief:
                pieces.append(f"[调用工具: {tc_brief}]")
            if raw_content:
                pieces.append(raw_content[:1100])
            line = f"助手: {' '.join(pieces)}" if pieces else ""
        else:
            line = ""

        if line:
            if used + len(line) > detail_chars:
                break
            detail.append(line)
            used += len(line)
        i -= 1

    used = 0
    dropped = 0
    while i >= 0:
        t = turns[i]
        if t.get("role") == "user":
            txt = _BASE64_RE.sub("[图片]", str(t.get("content") or "")).strip()
            if txt:
                line = f"用户: {txt[:180]}"
                if used + len(line) > outline_chars:
                    dropped = i + 1
                    break
                outline.append(line)
                used += len(line)
        i -= 1

    sections: list[str] = []
    if earlier_summary.strip():
        sections.append(f"【更早阶段已压缩摘要】\n{earlier_summary.strip()[:6000]}")
    if dropped:
        sections.append(f"…（更早 {dropped} 条消息已纳入摘要或省略）")
    if outline:
        sections.append("【较早轮次用户指令】\n" + "\n".join(reversed(outline)))
    if detail:
        sections.append("【较近轮次完整对话流水（按时间先后，越靠后越新）】\n" + "\n".join(reversed(detail)))
    return "\n\n".join(sections)


async def summarize_turns_checkpoint(
    older_turns: list[dict[str, Any]],
    earlier_summary: str = "",
    user: User | None = None,
    max_summary_tokens: int = 1200,
) -> str:
    """Produce a concise, recency-first structured checkpoint of older AI 编排 turns."""
    if not older_turns and not earlier_summary.strip():
        return ""

    digest = _build_recency_digest(older_turns, earlier_summary=earlier_summary)
    if get_ai_providers(background=True, user=user):
        prompt = (
            "你是 Memento AI 编排器的上下文压缩专家。请将以下前序多轮对话与工具调用记录，"
            "压缩提炼为一份高密度、结构化的「上下文记忆快照」，供后续编排轮次无缝接续。\n\n"
            f"{digest}\n\n"
            "【严格压缩要求】\n"
            "1) 以最新状态为准：后发生的结论、修改、状态覆盖早期内容，已完成的事明确标为已完成。\n"
            "2) 务必保留：目标设备名/device_id、关键目录路径/文件名、进程 PID/端口、检索到的 doc_id/plan_id、已查明的根因与用户明确约束。\n"
            "3) 去除冗余：不要抄录大段终端日志，不要写入密钥/Token 具体值。\n"
            "4) 中文输出，结构简洁清晰，控制在 400-800 字。\n\n"
            "【输出格式】\n"
            "### 对话核心目标与用户约束\n"
            "- ...\n"
            "### 已查明事实与关键产出\n"
            "- ...\n"
            "### 涉及设备 / 路径 / 关键标识\n"
            "- ...\n"
            "### 当前进展与待处理事项\n"
            "- ..."
        )
        try:
            summary = await call_plain_chat(
                [
                    {"role": "system", "content": "你擅长提炼高密度的多设备编排上下文记忆快照，准确保留技术事实、路径、设备与最新状态。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.2,
                max_tokens=max_summary_tokens,
                timeout=60.0,
                user=user,
                background=True,
            )
            if summary and summary.strip():
                return summary.strip()
        except Exception as e:
            logger.warning("AI orchestration history checkpoint LLM failed, using heuristic fallback: %s", e)

    # Heuristic fallback (recency-first)
    user_msgs = [
        _BASE64_RE.sub("[图片]", str(t.get("content") or "")).strip()[:180]
        for t in older_turns
        if t.get("role") == "user" and str(t.get("content") or "").strip()
    ]
    asst_msgs = [
        _BASE64_RE.sub("[图片]", str(t.get("content") or "")).strip()[:240]
        for t in older_turns
        if t.get("role") == "assistant" and str(t.get("content") or "").strip()
    ]
    tool_notes = [
        b for b in (_summarize_tool_calls_brief(t.get("tool_calls") or t.get("toolCalls")) for t in older_turns) if b
    ]
    lines = ["### 上下文记忆快照（自动提炼）"]
    if earlier_summary.strip():
        lines.append(f"- 早期摘要：{earlier_summary.strip()[:800]}")
    if user_msgs:
        lines.append(f"- 初始意图：{user_msgs[0]}")
        if len(user_msgs) > 1:
            lines.append("- 近期用户指令：" + "；".join(user_msgs[-3:]))
    if tool_notes:
        lines.append("- 已执行工具：" + "；".join(tool_notes[-4:]))
    if asst_msgs:
        lines.append(f"- 最新阶段结论：{asst_msgs[-1]}")
    return "\n".join(lines)


async def _load_conversation_turns_and_checkpoint(
    conv_id: uuid.UUID | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if not conv_id:
        return [], {}
    try:
        async with async_session_factory() as session:
            conv = (await session.execute(
                select(AskConversation).where(AskConversation.id == conv_id)
            )).scalars().first()
            if not conv:
                return [], {}
            turns = list(conv.turns or [])
            ckpt = dict((conv.config or {}).get(CHECKPOINT_CONFIG_KEY) or {})
            return turns, ckpt
    except Exception as e:
        logger.debug("Failed to load conversation turns for AI compaction: %s", e)
        return [], {}


async def _persist_checkpoint(
    conv_id: uuid.UUID | None,
    checkpoint_payload: dict[str, Any],
) -> None:
    if not conv_id:
        return
    try:
        async with async_session_factory() as session:
            conv = (await session.execute(
                select(AskConversation).where(AskConversation.id == conv_id).with_for_update()
            )).scalars().first()
            if not conv:
                return
            cfg = dict(conv.config or {})
            cfg[CHECKPOINT_CONFIG_KEY] = checkpoint_payload
            conv.config = cfg
            conv.updated_at = datetime.now(timezone.utc)
            await session.commit()
    except Exception as e:
        logger.warning("Failed to persist AI context checkpoint for %s: %s", conv_id, e)


def build_ai_context_stats(
    turns: list[dict[str, Any]],
    checkpoint: dict[str, Any] | None = None,
    budget_tokens: int = AI_CONTEXT_BUDGET_TOKENS,
) -> dict[str, Any]:
    """Compute lightweight live context statistics for UI display."""
    ckpt = checkpoint or {}
    compacted_turns = int(ckpt.get("compacted_turn_count") or 0)
    summary = str(ckpt.get("summary") or "")
    if compacted_turns > len(turns):
        compacted_turns = 0
        summary = ""
    active_turns = turns[compacted_turns:]
    active_tokens = estimate_messages_tokens(active_turns) + (estimate_tokens(summary) if summary else 0)
    raw_total_tokens = estimate_messages_tokens(turns)
    return {
        "estimated_tokens": active_tokens,
        "raw_tokens": raw_total_tokens,
        "budget_tokens": budget_tokens,
        "total_turns": len(turns),
        "active_turns": len(active_turns),
        "compacted_turns": compacted_turns,
        "has_checkpoint": bool(summary),
        "checkpoint_summary": summary,
        "updated_at": ckpt.get("updated_at"),
        "compact_recommended": active_tokens >= int(AI_HISTORY_SOFT_TOKENS * 0.85) or len(active_turns) >= AI_MAX_RAW_TURNS,
    }


async def prepare_ai_history(
    *,
    conv_id: uuid.UUID | None,
    client_history: list[dict[str, Any]] | None,
    user: User | None,
    force_compact: bool = False,
    budget_tokens: int = AI_CONTEXT_BUDGET_TOKENS,
    soft_history_tokens: int = AI_HISTORY_SOFT_TOKENS,
    max_raw_turns: int = AI_MAX_RAW_TURNS,
    keep_recent_turns: int = AI_RECENT_TURNS_KEEP,
) -> tuple[str, list[dict[str, Any]], dict[str, Any], CompactionEvent | None]:
    """Prepare history for an AI 编排 turn with incremental rolling compression.

    Returns:
      (checkpoint_summary, active_recent_turns, context_stats, compaction_event_or_None)
    """
    db_turns, existing_ckpt = await _load_conversation_turns_and_checkpoint(conv_id)
    # Use DB turns when fuller than client-sent history (client may only send truncated slice)
    full_turns = db_turns if len(db_turns) >= len(client_history or []) else list(client_history or [])
    if not full_turns:
        stats = build_ai_context_stats([], None, budget_tokens=budget_tokens)
        return "", [], stats, None

    compacted_count = int(existing_ckpt.get("compacted_turn_count") or 0)
    earlier_summary = str(existing_ckpt.get("summary") or "")
    if compacted_count > len(full_turns) or compacted_count < 0:
        compacted_count = 0
        earlier_summary = ""

    uncovered = full_turns[compacted_count:]
    active_tokens = estimate_messages_tokens(uncovered) + (estimate_tokens(earlier_summary) if earlier_summary else 0)

    # Decide how many recent turns to keep verbatim
    target_keep = min(keep_recent_turns, 4) if force_compact else keep_recent_turns
    needs_compact = (
        (force_compact and len(uncovered) > 2)
        or (active_tokens > soft_history_tokens and len(uncovered) > target_keep)
        or (len(uncovered) > max_raw_turns)
    )

    compaction_event: CompactionEvent | None = None
    if needs_compact:
        keep_n = min(target_keep, max(2, len(uncovered) - 2)) if force_compact else target_keep
        # Ensure we split cleanly on a user boundary when possible
        split_idx = max(1, len(uncovered) - keep_n)
        while split_idx > 1 and uncovered[split_idx].get("role") != "user":
            split_idx -= 1
        older_slice = uncovered[:split_idx]
        recent_slice = uncovered[split_idx:]

        if older_slice:
            new_summary = await summarize_turns_checkpoint(
                older_slice,
                earlier_summary=earlier_summary,
                user=user,
            )
            new_compacted_count = compacted_count + len(older_slice)
            after_tokens = estimate_messages_tokens(recent_slice) + estimate_tokens(new_summary)
            now_iso = datetime.now(timezone.utc).isoformat()
            ckpt_payload = {
                "summary": new_summary,
                "compacted_turn_count": new_compacted_count,
                "updated_at": now_iso,
                "before_tokens": active_tokens,
                "after_tokens": after_tokens,
                "mode": "manual" if force_compact else "auto",
            }
            await _persist_checkpoint(conv_id, ckpt_payload)
            compaction_event = CompactionEvent(
                scope="history",
                mode="manual" if force_compact else "auto",
                before_tokens=active_tokens,
                after_tokens=after_tokens,
                compacted_turns=new_compacted_count,
                kept_turns=len(recent_slice),
                summary=new_summary,
            )
            stats = build_ai_context_stats(full_turns, ckpt_payload, budget_tokens=budget_tokens)
            return new_summary, recent_slice, stats, compaction_event

    stats = build_ai_context_stats(full_turns, existing_ckpt, budget_tokens=budget_tokens)
    return earlier_summary, uncovered, stats, None


async def compact_ai_conversation(
    db: AsyncSession,
    user: User,
    conv_id: uuid.UUID,
    keep_recent: int = 4,
) -> dict[str, Any]:
    """Explicit manual compaction endpoint logic for `POST /api/ask/conversations/{conv_id}/compact`."""
    conv = (await db.execute(
        select(AskConversation).where(
            AskConversation.id == conv_id,
            (AskConversation.user_id == user.id) | (AskConversation.user_id.is_(None)),
        ).with_for_update()
    )).scalars().first()
    if not conv:
        raise KeyError("Conversation not found")

    turns = list(conv.turns or [])
    cfg = dict(conv.config or {})
    existing_ckpt = dict(cfg.get(CHECKPOINT_CONFIG_KEY) or {})
    compacted_count = int(existing_ckpt.get("compacted_turn_count") or 0)
    earlier_summary = str(existing_ckpt.get("summary") or "")
    if compacted_count > len(turns) or compacted_count < 0:
        compacted_count = 0
        earlier_summary = ""

    uncovered = turns[compacted_count:]
    before_tokens = estimate_messages_tokens(uncovered) + (estimate_tokens(earlier_summary) if earlier_summary else 0)

    if len(uncovered) <= 2:
        stats = build_ai_context_stats(turns, existing_ckpt)
        return {
            "ok": True,
            "compacted": False,
            "reason": "当前对话轮次较少，无需压缩",
            "before_tokens": before_tokens,
            "after_tokens": before_tokens,
            "saved_tokens": 0,
            "summary": earlier_summary,
            "stats": stats,
        }

    keep_n = max(2, min(keep_recent, len(uncovered) - 2))
    split_idx = max(1, len(uncovered) - keep_n)
    while split_idx > 1 and uncovered[split_idx].get("role") != "user":
        split_idx -= 1

    older_slice = uncovered[:split_idx]
    recent_slice = uncovered[split_idx:]
    new_summary = await summarize_turns_checkpoint(older_slice, earlier_summary=earlier_summary, user=user)
    new_compacted_count = compacted_count + len(older_slice)
    after_tokens = estimate_messages_tokens(recent_slice) + estimate_tokens(new_summary)
    now_iso = datetime.now(timezone.utc).isoformat()

    ckpt_payload = {
        "summary": new_summary,
        "compacted_turn_count": new_compacted_count,
        "updated_at": now_iso,
        "before_tokens": before_tokens,
        "after_tokens": after_tokens,
        "mode": "manual",
    }
    cfg[CHECKPOINT_CONFIG_KEY] = ckpt_payload
    conv.config = cfg
    conv.updated_at = datetime.now(timezone.utc)
    await db.commit()

    stats = build_ai_context_stats(turns, ckpt_payload)
    return {
        "ok": True,
        "compacted": True,
        "before_tokens": before_tokens,
        "after_tokens": after_tokens,
        "saved_tokens": max(0, before_tokens - after_tokens),
        "compacted_turns": new_compacted_count,
        "kept_turns": len(recent_slice),
        "summary": new_summary,
        "stats": stats,
    }


# ---------------------------------------------------------------------------
# Tier 2: In-Loop Multi-Round Compaction inside `run_agent_loop`
# ---------------------------------------------------------------------------

def _micro_compact_tool_payload(raw_content: str, max_chars: int = 420) -> str:
    """Shrink an older round's JSON tool output into a compact, high-signal digest."""
    if len(raw_content) <= max_chars:
        return raw_content
    try:
        obj = json.loads(raw_content)
        if isinstance(obj, dict):
            compact: dict[str, Any] = {}
            for key in ("status", "device_name", "action", "exit_code", "saved", "created", "updated", "plan_id", "doc_id", "project", "query", "url", "error"):
                if key in obj and obj[key] is not None:
                    compact[key] = obj[key]
            # Preserve short preview of the main payload
            for text_key in ("markdown", "stdout", "guidance", "skill", "resonance", "content", "note"):
                val = obj.get(text_key)
                if isinstance(val, str) and val.strip():
                    compact[f"{text_key}_preview"] = val.strip()[:260] + ("…" if len(val.strip()) > 260 else "")
                    break
            if isinstance(obj.get("results"), list):
                compact["results_count"] = len(obj["results"])
                compact["top_hits"] = [
                    {"doc_id": r.get("doc_id"), "title": str(r.get("title") or "")[:50]}
                    for r in obj["results"][:4]
                    if isinstance(r, dict)
                ]
            if isinstance(obj.get("todos"), list):
                compact["todos_count"] = len(obj["todos"])
            compact["_compacted"] = True
            return json.dumps(compact, ensure_ascii=False)
    except Exception:
        pass
    head = raw_content[:200]
    tail = raw_content[-160:]
    return f"{head}\n…[已压缩省略 {len(raw_content) - 360} 字符]…\n{tail}"


def _find_round_boundaries(convo: list[dict[str, Any]]) -> list[int]:
    """Return start indices of assistant tool-calling turns inside convo (after initial system+user)."""
    starts: list[int] = []
    for idx, msg in enumerate(convo):
        if idx >= 2 and msg.get("role") == "assistant" and msg.get("tool_calls"):
            starts.append(idx)
    return starts


async def compact_loop_messages(
    convo: list[dict[str, Any]],
    *,
    budget_tokens: int = AI_CONTEXT_BUDGET_TOKENS,
    trigger_ratio: float = AI_IN_LOOP_COMPACT_RATIO,
    aggressive: bool = False,
    user: User | None = None,
) -> tuple[list[dict[str, Any]], CompactionEvent | None]:
    """Keep `run_agent_loop` messages safely inside the model's context budget.

    Never breaks `assistant(tool_calls) -> tool` pairing required by OpenAI/Anthropic/DashScope APIs.
    """
    before_tokens = estimate_messages_tokens(convo)
    threshold = int(budget_tokens * (0.55 if aggressive else trigger_ratio))
    if before_tokens <= threshold:
        return convo, None

    round_starts = _find_round_boundaries(convo)
    if not round_starts:
        return convo, None

    # Keep the latest 2 tool rounds verbatim (or 1 round in aggressive overflow recovery)
    keep_rounds = 1 if aggressive else 2
    protected_from = round_starts[-keep_rounds] if len(round_starts) >= keep_rounds else round_starts[0]

    # Stage A: Zero-latency micro-compaction of older `role == "tool"` outputs
    next_convo = [dict(m) for m in convo]
    micro_changed = False
    for idx in range(protected_from):
        m = next_convo[idx]
        if m.get("role") == "tool":
            old_c = str(m.get("content") or "")
            new_c = _micro_compact_tool_payload(old_c, max_chars=240 if aggressive else 420)
            if len(new_c) < len(old_c):
                m["content"] = new_c
                micro_changed = True

    after_micro = estimate_messages_tokens(next_convo)
    if after_micro <= threshold and micro_changed:
        evt = CompactionEvent(
            scope="in_loop",
            mode="overflow_recovery" if aggressive else "auto",
            before_tokens=before_tokens,
            after_tokens=after_micro,
            compacted_turns=max(1, len(round_starts) - keep_rounds),
            kept_turns=min(keep_rounds, len(round_starts)),
            summary="已自动精简较早编排轮次的冗长工具输出，完整保留最近步骤与关键线索。",
        )
        return next_convo, evt

    # Stage B: Collapse older intermediate tool rounds into a single concise rolling summary
    if len(round_starts) > keep_rounds:
        first_round_idx = round_starts[0]
        middle_slice = next_convo[first_round_idx:protected_from]
        if middle_slice:
            middle_lines: list[str] = []
            for m in middle_slice:
                role = m.get("role")
                if role == "assistant" and m.get("tool_calls"):
                    names = [str((tc.get("function") or {}).get("name") or "") for tc in m["tool_calls"]]
                    middle_lines.append(f"调用工具: {', '.join(names)}")
                elif role == "tool":
                    middle_lines.append(f"工具结果: {str(m.get('content') or '')[:450]}")
                elif role in ("user", "assistant") and str(m.get("content") or "").strip():
                    middle_lines.append(f"{role}: {str(m.get('content') or '')[:350]}")

            middle_text = "\n".join(middle_lines)
            rolled_summary = ""
            if get_ai_providers(background=True, user=user):
                try:
                    rolled_summary = await call_plain_chat(
                        [
                            {"role": "system", "content": "请将多步工具调用的中间过程压缩为 250-500 字的精炼中文事实摘要，保留设备名、路径、doc_id、错误信息和已查明结论。"},
                            {"role": "user", "content": middle_text[:12000]},
                        ],
                        temperature=0.1,
                        max_tokens=700,
                        timeout=45.0,
                        user=user,
                        background=True,
                    ) or ""
                except Exception as e:
                    logger.debug("In-loop Stage B LLM summary failed: %s", e)

            if not rolled_summary.strip():
                rolled_summary = "\n".join(middle_lines[-10:])[:1800]

            collapsed_msg = {
                "role": "assistant",
                "content": f"【较早编排轮次压缩摘要（前 {len(round_starts) - keep_rounds} 轮）】\n{rolled_summary.strip()}",
            }
            next_convo = next_convo[:first_round_idx] + [collapsed_msg] + next_convo[protected_from:]
            after_stage_b = estimate_messages_tokens(next_convo)
            evt = CompactionEvent(
                scope="in_loop",
                mode="overflow_recovery" if aggressive else "auto",
                before_tokens=before_tokens,
                after_tokens=after_stage_b,
                compacted_turns=len(round_starts) - keep_rounds,
                kept_turns=keep_rounds,
                summary=rolled_summary.strip()[:500],
            )
            return next_convo, evt

    if micro_changed:
        evt = CompactionEvent(
            scope="in_loop",
            mode="overflow_recovery" if aggressive else "auto",
            before_tokens=before_tokens,
            after_tokens=after_micro,
            compacted_turns=max(1, len(round_starts) - keep_rounds),
            kept_turns=min(keep_rounds, len(round_starts)),
            summary="已精简历史工具输出以控制上下文预算。",
        )
        return next_convo, evt

    return convo, None
