"""AI summary service — two-pass daily summary: per-conversation digest → merged daily report."""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import date

import httpx

from .conversation_parser import parse_conversation

logger = logging.getLogger("server.ai_summary")

AI_BASE_URL = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
AI_API_KEY = os.environ.get("MEMENTO_AI_API_KEY", "")
AI_MODEL = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5")

# Concurrency limit for parallel API calls
_CONCURRENCY = 5


async def _call_ai(messages: list[dict], temperature: float = 0.3, max_tokens: int = 1000) -> str | None:
    """Make a single AI API call."""
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                f"{AI_BASE_URL}/chat/completions",
                headers={
                    "Authorization": f"Bearer {AI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": AI_MODEL,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
            )
            if resp.status_code != 200:
                logger.warning("AI API %d: %s", resp.status_code, resp.text[:300])
                return None
            return resp.json().get("choices", [{}])[0].get("message", {}).get("content")
    except Exception as e:
        logger.exception("AI call failed: %s", e)
        return None


async def _summarize_conversation(tool_id: str, title: str, digest: str, sem: asyncio.Semaphore) -> dict:
    """Pass 1: Summarize a single conversation."""
    async with sem:
        # For short conversations, no need to call AI
        if len(digest) < 200:
            return {"tool_id": tool_id, "title": title, "summary": digest}

        # Truncate very long digests to fit in context
        if len(digest) > 8000:
            digest = digest[:8000] + "\n\n...(内容已截断)"

        prompt = f"""请用 2-5 句话简要总结以下 AI 编程对话的内容。重点说明：用户想做什么、最终结果如何、解决了什么问题。

对话标题：{title}
工具：{tool_id}

对话内容：
{digest}"""

        result = await _call_ai([
            {"role": "system", "content": "你是一个技术对话摘要助手，擅长从 AI 编程对话中提炼关键信息。输出简洁的中文摘要。"},
            {"role": "user", "content": prompt},
        ], max_tokens=500)

        return {
            "tool_id": tool_id,
            "title": title,
            "summary": result or digest[:300],
        }


async def generate_daily_summary_from_digests(
    summary_date: date,
    conversations: list[dict],
) -> str | None:
    """Two-pass daily summary generation.

    Pass 1: Summarize each conversation in parallel (with concurrency limit).
    Pass 2: Merge all conversation summaries into a single daily report.

    Args:
        conversations: [{tool_id, title, digest}, ...]
    """
    if not AI_API_KEY:
        logger.warning("MEMENTO_AI_API_KEY not set")
        return None

    # Filter out empty conversations
    valid_convs = [c for c in conversations if c.get("digest", "").strip()]
    if not valid_convs:
        return None

    logger.info("Pass 1: summarizing %d conversations for %s", len(valid_convs), summary_date)

    # --- Pass 1: Per-conversation summaries (parallel with semaphore) ---
    sem = asyncio.Semaphore(_CONCURRENCY)
    tasks = [
        _summarize_conversation(c["tool_id"], c["title"], c["digest"], sem)
        for c in valid_convs
    ]
    conv_summaries = await asyncio.gather(*tasks)

    # --- Pass 2: Merge into daily report ---
    logger.info("Pass 2: merging %d conversation summaries into daily report", len(conv_summaries))

    # Group by tool
    by_tool: dict[str, list[dict]] = {}
    for cs in conv_summaries:
        by_tool.setdefault(cs["tool_id"], []).append(cs)

    lines = []
    for tool_id, items in by_tool.items():
        lines.append(f"## {tool_id} ({len(items)} 个对话)")
        for item in items:
            lines.append(f"### {item['title']}")
            lines.append(item["summary"])
            lines.append("")

    summaries_text = "\n".join(lines)
    if len(summaries_text) > 15000:
        summaries_text = summaries_text[:15000] + "\n\n...(已截断)"

    prompt = f"""你是 AI 编码日报助手。以下是 {summary_date.isoformat()} 每个对话的摘要，请合并生成一份日报。

要求：
1. Markdown 格式
2. 先写「今日概要」（2-3 句话概括今天的工作重点和成果）
3. 按**项目**分组（不是按工具分组），列出每个项目的关键进展
4. 突出关键成果：修了什么 bug、实现了什么功能、解决了什么问题
5. 如果有多个对话围绕同一个项目，合并总结
6. 最后简要提及今天使用了哪些 AI 工具
7. 控制在 800 字以内

各对话摘要：
{summaries_text}"""

    result = await _call_ai([
        {"role": "system", "content": "你是专业的 AI 编码日报助手，擅长将多个对话摘要合并成结构清晰、重点突出的日报。"},
        {"role": "user", "content": prompt},
    ], max_tokens=2000)

    if result:
        logger.info("Generated daily summary for %s (%d chars)", summary_date, len(result))
    return result


def _extract_conversation_digest(
    content: str, tool_id: str, target_date: str = "", max_chars: int = 3000,
) -> str:
    """Extract user questions and assistant replies, filtered to target date if possible."""
    messages = parse_conversation(content, tool_id)
    parts = []
    total = 0
    for m in messages:
        if m.role not in ("user", "assistant"):
            continue
        if m.content.startswith("[Result]") or m.content.startswith("[Tool:"):
            continue
        if target_date and m.timestamp:
            msg_date = m.timestamp[:10]
            if msg_date != target_date:
                continue
        prefix = "👤 用户" if m.role == "user" else "🤖 AI"
        text = m.content[:500]
        line = f"{prefix}: {text}"
        if total + len(line) > max_chars:
            parts.append("...(对话内容过长，已截断)")
            break
        parts.append(line)
        total += len(line)
    return "\n".join(parts)


async def generate_daily_summary(
    summary_date: date,
    conversations: list[dict],
) -> str | None:
    """Legacy: generate summary from raw conversation content (single-pass)."""
    if not AI_API_KEY:
        return None

    conv_data = []
    for conv in conversations:
        tool_id = conv.get("tool_id", "unknown")
        title = conv.get("title", "")
        content = conv.get("content", "")
        content_type = conv.get("content_type", "")
        if not content:
            continue
        if content_type == "jsonl":
            digest = _extract_conversation_digest(
                content, tool_id, target_date=summary_date.isoformat(), max_chars=2000,
            )
        else:
            digest = content[:1000]
        if digest.strip():
            conv_data.append({"tool_id": tool_id, "title": title, "digest": digest})

    return await generate_daily_summary_from_digests(summary_date, conv_data)
