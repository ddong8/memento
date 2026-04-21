"""Markdown parser — extracts frontmatter and body, with error tolerance."""

from __future__ import annotations

from pathlib import Path

import frontmatter

from .base import BaseParser, ParseResult


class MarkdownParser(BaseParser):

    def can_parse(self, path: Path) -> bool:
        return path.suffix.lower() == ".md"

    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        raw = path.read_text(encoding="utf-8", errors="replace")

        # frontmatter.loads can crash on malformed YAML — catch and fallback
        title = ""
        metadata: dict = {}
        content = raw

        try:
            post = frontmatter.loads(raw)
            content = post.content
            metadata = dict(post.metadata) if post.metadata else {}
        except Exception:
            pass  # Use raw content as-is

        # Try to extract title from frontmatter or first heading
        if "title" in metadata:
            title = str(metadata["title"])
        else:
            for line in content.splitlines():
                stripped = line.strip()
                if stripped.startswith("# "):
                    title = stripped[2:].strip()
                    break

        if not title:
            title = path.stem

        return ParseResult(
            content=content,
            title=title,
            metadata=metadata,
            line_count=content.count("\n") + 1,
        )
