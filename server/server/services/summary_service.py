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
