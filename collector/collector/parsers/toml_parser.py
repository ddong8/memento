"""TOML parser — reads TOML config files."""

from __future__ import annotations

import json
from pathlib import Path

import tomli

from .base import BaseParser, ParseResult


class TomlParser(BaseParser):

    def can_parse(self, path: Path) -> bool:
        return path.suffix.lower() == ".toml"

    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        raw = path.read_bytes()
        raw_text = raw.decode("utf-8", errors="replace")

        try:
            data = tomli.loads(raw_text)
        except tomli.TOMLDecodeError:
            return ParseResult(
                content=raw_text,
                title=path.stem,
                metadata={"parse_error": True},
                line_count=raw_text.count("\n") + 1,
            )

        metadata: dict = {"top_level_keys": list(data.keys())[:20]}

        # Store both original TOML and parsed JSON representation
        content = raw_text

        return ParseResult(
            content=content,
            title=path.stem,
            metadata={**metadata, "parsed": data},
            line_count=content.count("\n") + 1,
        )
