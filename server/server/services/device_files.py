"""Device file path normalization, RFC 9110 byte-range parsing, and scoped cache helpers."""

from __future__ import annotations

import hashlib
import os
import urllib.parse
from typing import Any

from fastapi import HTTPException

# Executable/active document extensions that must be sandboxed if served inline
SANDBOXED_INLINE_EXTS = frozenset({".html", ".htm", ".svg", ".xhtml", ".xml", ".mhtml"})


def user_cache_scope(user: Any) -> str:
    uid = getattr(user, "id", None)
    return str(uid) if uid is not None else "anon"


def disk_cache_key(user_scope: str, dev_token: str, clean_path: str, total_size: int) -> str:
    return hashlib.sha256(f"{user_scope}:{dev_token}:{clean_path}:{total_size}".encode()).hexdigest()


def parse_byte_range(range_header: str | None, total_size: int) -> tuple[int, int, int]:
    """Parse HTTP Range header per RFC 9110. Returns (start, end, status_code).

    Raises HTTPException(400) on malformed syntax or HTTPException(416) on unsatisfiable ranges.
    """
    if not range_header or not range_header.startswith("bytes="):
        return 0, (total_size - 1) if total_size > 0 else 0, 200
    spec = range_header[6:].strip()
    if "," in spec or "-" not in spec:
        raise HTTPException(status_code=400, detail="Unsupported Range header")
    start_s, end_s = spec.split("-", 1)
    start_s, end_s = start_s.strip(), end_s.strip()
    if not start_s and not end_s:
        raise HTTPException(status_code=400, detail="Empty Range header")
    if total_size <= 0:
        raise HTTPException(status_code=416, detail="Range not satisfiable", headers={"Content-Range": "bytes */0"})
    try:
        if not start_s:
            suffix = int(end_s)
            if suffix <= 0:
                raise HTTPException(
                    status_code=416,
                    detail="Range not satisfiable",
                    headers={"Content-Range": f"bytes */{total_size}"},
                )
            start = max(0, total_size - suffix)
            end = total_size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else (total_size - 1)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Range header")
    if start < 0 or end < 0 or start >= total_size or start > end:
        raise HTTPException(
            status_code=416,
            detail="Range not satisfiable",
            headers={"Content-Range": f"bytes */{total_size}"},
        )
    end = min(end, total_size - 1)
    return start, end, 206


def file_matches_size(path: str, expected_size: int) -> bool:
    try:
        return os.path.exists(path) and os.path.getsize(path) == expected_size
    except OSError:
        return False


def read_local_slice(path: str, offset: int, length: int) -> bytes:
    with open(path, "rb") as f:
        f.seek(offset)
        return f.read(length)


def append_part_chunk(part_path: str, chunk: bytes, mode: str) -> None:
    with open(part_path, mode) as f:
        f.write(chunk)


def clean_device_path(path: str) -> str:
    """The absolute path the client meant: unquoted (also when double-encoded), forward slashes, no file://."""
    clean_path = path.strip()
    for _ in range(3):
        unquoted = urllib.parse.unquote(clean_path)
        if unquoted == clean_path:
            break
        clean_path = unquoted
    clean_path = clean_path.replace("\\", "/")
    if clean_path.startswith("file://"):
        clean_path = clean_path.replace("file://", "")
        if clean_path.startswith("/") and len(clean_path) > 3 and clean_path[2] == ":":
            clean_path = clean_path[1:]
    if any(p == ".." for p in clean_path.split("/")):
        raise HTTPException(status_code=400, detail="Path traversal forbidden")
    return clean_path
