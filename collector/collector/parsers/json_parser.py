"""JSON parser — reads and re-serializes JSON files."""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseParser, ParseResult


class JsonParser(BaseParser):

    def can_parse(self, path: Path) -> bool:
        return path.suffix.lower() == ".json"

    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        raw = path.read_text(encoding="utf-8", errors="replace")

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return ParseResult(
                content=raw,
                title=path.stem,
                metadata={"parse_error": True},
                line_count=raw.count("\n") + 1,
            )

        # Pretty-print for readability
        content = json.dumps(data, indent=2, ensure_ascii=False)

        # Extract useful metadata
        metadata: dict = {}
        if isinstance(data, dict):
            metadata["top_level_keys"] = list(data.keys())[:20]

        return ParseResult(
            content=content,
            title=path.stem,
            metadata=metadata,
            line_count=content.count("\n") + 1,
        )
