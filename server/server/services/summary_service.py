"""Summary service — generates AI summaries using Claude API."""

from __future__ import annotations

import anthropic

from ..config import settings

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    return _client


def generate_document_summary(title: str, content: str, tool_name: str, category: str) -> str:
    """Generate a concise summary for a single document."""
    if not settings.anthropic_api_key:
        return ""

    # Truncate very long content
    if len(content) > 50000:
        content = content[:50000] + "\n...[truncated]"

    client = _get_client()
    message = client.messages.create(
        model=settings.summary_model,
        max_tokens=500,
        messages=[{
            "role": "user",
            "content": (
                f"Summarize this {category} file from {tool_name} in 2-3 sentences. "
                f"Focus on what was done/discussed, not the format.\n\n"
                f"Title: {title}\n\n"
                f"Content:\n{content}"
            ),
        }],
    )
    return message.content[0].text


def generate_daily_summary(date_str: str, tool_summaries: dict[str, list[dict]]) -> str:
    """Generate a cross-tool daily summary."""
    if not settings.anthropic_api_key:
        return ""

    # Build context from tool summaries
    parts = [f"Date: {date_str}\n"]
    for tool, docs in tool_summaries.items():
        parts.append(f"\n## {tool} ({len(docs)} files changed)")
        for doc in docs[:20]:  # Limit per tool
            parts.append(f"- [{doc['category']}] {doc['title']}")
            if doc.get("ai_summary"):
                parts.append(f"  Summary: {doc['ai_summary']}")
            elif doc.get("content"):
                preview = doc["content"][:300].replace("\n", " ")
                parts.append(f"  Preview: {preview}")

    context = "\n".join(parts)
    if len(context) > 80000:
        context = context[:80000] + "\n...[truncated]"

    client = _get_client()
    message = client.messages.create(
        model=settings.summary_model,
        max_tokens=1000,
        messages=[{
            "role": "user",
            "content": (
                "Based on the following AI tool activity for today, write a concise daily work summary. "
                "Organize by themes/tasks (not by tool). Use bullet points. "
                "Write in the same language as the content (Chinese if the content is Chinese).\n\n"
                f"{context}"
            ),
        }],
    )
    return message.content[0].text
