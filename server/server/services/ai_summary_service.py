"""AI summary service — two-pass daily summary: per-conversation digest → merged daily report."""

from __future__ import annotations

import asyncio
import logging
from datetime import date

from .ai_provider import call_plain_chat, get_ai_providers

logger = logging.getLogger("server.ai_summary")

# Concurrency limit for parallel API calls
_CONCURRENCY = 5


async def _call_ai(messages: list[dict], temperature: float = 0.3, max_tokens: int = 1000) -> str | None:
    """Make a single AI API call with multi-provider fallback."""
    return await call_plain_chat(messages, temperature=temperature, max_tokens=max_tokens, timeout=90.0)


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
    if not get_ai_providers():
        logger.warning("No AI providers configured")
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

    prompt = f"""你是 AI 工作日报助手。以下是 {summary_date.isoformat()} 每个对话的摘要，请合并生成一份工作日报。

要求：
1) 使用通俗易懂的语言，只陈述已完成的工作成果，不要提问题、风险、报错或未完成事项，突出业务内容与实际价值
2) 先写「今日概要」（2-3 句话概括今天完成的核心业务内容与工作成果）
3) 按项目分组（不是按工具分组），列出每个项目已完成的工作进展，编号统一使用 1), 2), 3) 形式，不要用角标
4) 如果有多个对话围绕同一个项目，合并总结已完成事项
5) 全文严禁使用 ** 这类 Markdown 加粗符号
6) 控制在 800 字以内

各对话摘要：
{summaries_text}"""

    result = await _call_ai([
        {"role": "system", "content": "你是专业的工作日报助手，擅长用通俗语言将技术工作提炼为突出业务内容、只陈述已完成工作的精炼日报，且不使用 ** 加粗符号。"},
        {"role": "user", "content": prompt},
    ], max_tokens=2000)

    if result:
        logger.info("Generated daily summary for %s (%d chars)", summary_date, len(result))
    return result
