"""JSONL parser — supports incremental/delta reading. Memory-efficient for large files."""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseParser, ParseResult

# No content size limit — DELTA mode only reads new lines (small).
# Full resync reads entire file, relying on chunked upload for large files.
MAX_CONTENT_SIZE = 0  # unlimited


class JsonlParser(BaseParser):

    def can_parse(self, path: Path) -> bool:
        return path.suffix.lower() == ".jsonl"

    def parse(self, path: Path, offset: int = 0) -> ParseResult:
        line_count = 0
        title = ""
        first_timestamp = ""
        last_timestamp = ""
        message_types: dict[str, int] = {}
        content_parts: list[str] = []
        content_size = 0

        file_size = path.stat().st_size
        is_partial = offset > 0

        if offset > file_size:
            offset = 0
            is_partial = False

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if offset > 0:
                f.seek(offset)

            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue

                # Accumulate all content (no size limit)
                if MAX_CONTENT_SIZE == 0 or content_size < MAX_CONTENT_SIZE:
                    content_parts.append(line)
                    content_size += len(line) + 1
                line_count += 1

                # Lightweight metadata extraction (only parse first 100 chars for type/timestamp)
                try:
                    obj = json.loads(line)
                    msg_type = obj.get("type", "unknown")
                    message_types[msg_type] = message_types.get(msg_type, 0) + 1

                    if msg_type == "ai-title" and not title:
                        title = obj.get("title", "")

                    ts = obj.get("timestamp", "")
                    if ts:
                        if not first_timestamp:
                            first_timestamp = ts
                        last_timestamp = ts
                except json.JSONDecodeError:
                    continue

        content = "\n".join(content_parts)
        new_offset = path.stat().st_size

        metadata: dict = {
            "message_types": message_types,
            "total_lines": line_count,
        }
        if first_timestamp:
            metadata["first_timestamp"] = first_timestamp
        if last_timestamp:
            metadata["last_timestamp"] = last_timestamp
        if content_size >= MAX_CONTENT_SIZE:
            metadata["truncated"] = True

        return ParseResult(
            content=content,
            title=title or path.stem,
            metadata=metadata,
            line_count=line_count,
            is_partial=is_partial,
            offset=new_offset,
        )
