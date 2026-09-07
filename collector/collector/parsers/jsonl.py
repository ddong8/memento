"""JSONL parser — supports incremental/delta reading. Memory-efficient for large files."""

from __future__ import annotations

import json
from pathlib import Path

from .base import BaseParser, ParseResult

# Limit each line and batch size to stay safely within SQLite and RAM limits.
# Huge tool dumps (e.g. minified bundles, base64 data) are truncated per line.
MAX_LINE_SIZE = 1 * 1024 * 1024       # 1 MB per line max
MAX_BATCH_SIZE = 6 * 1024 * 1024      # 6 MB per delta batch max


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

        new_offset = offset
        has_more = False

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            if offset > 0:
                f.seek(offset)

            while True:
                raw_line = f.readline()
                if not raw_line:
                    break
                current_tell = f.tell()
                line = raw_line.rstrip("\r\n")
                if not line:
                    new_offset = current_tell
                    continue

                if len(line) > MAX_LINE_SIZE:
                    # Truncate overly long lines (e.g. massive data/terminal dumps)
                    keep_head = line[:MAX_LINE_SIZE // 2]
                    keep_tail = line[-(MAX_LINE_SIZE // 4):]
                    line = f"{keep_head}\n...[TRUNCATED: line exceeded 1MB limit]...\n{keep_tail}"

                content_parts.append(line)
                content_size += len(line) + 1
                line_count += 1
                new_offset = current_tell

                # Lightweight metadata extraction
                try:
                    meta_slice = line[:500] if len(line) > 500 else line
                    if '"type"' in meta_slice or '"title"' in meta_slice or '"timestamp"' in meta_slice:
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
                except Exception:
                    pass

                # Stop this batch if we reached MAX_BATCH_SIZE to avoid huge blobs
                if content_size >= MAX_BATCH_SIZE:
                    has_more = current_tell < file_size
                    break

        content = "\n".join(content_parts)

        metadata: dict = {
            "message_types": message_types,
            "total_lines": line_count,
        }
        if first_timestamp:
            metadata["first_timestamp"] = first_timestamp
        if last_timestamp:
            metadata["last_timestamp"] = last_timestamp
        if has_more:
            metadata["has_more"] = True

        return ParseResult(
            content=content,
            title=title or path.stem,
            metadata=metadata,
            line_count=line_count,
            is_partial=is_partial or has_more,
            offset=new_offset,
        )
