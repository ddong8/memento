"""Antigravity conversation exporter — decrypts .pb files locally.

Completely offline: scans `~/.gemini/antigravity/conversations/*.pb`,
decrypts them with AES-256-GCM, and parses the trajectory protobuf to extract
all user/assistant messages. No dependency on antigravity-history or a
running Antigravity language server.

Workspace metadata is taken from the .pb file itself (field 7). Titles are
recovered from vscdb trajectorySummaries when available.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

from .antigravity_pb_decoder import decode_pb_conversation

logger = logging.getLogger("collector.antigravity_export")

# Cache: cascade_id → content_hash (per-conversation change detection)
_last_hashes: dict[str, str] = {}

# Cache: cascade_id → title (loaded once from vscdb, avoids re-parsing)
_title_map_cache: dict[str, str] | None = None

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I,
)


def _gemini_root() -> Path:
    home = Path.home()
    if platform.system() == "Windows":
        appdata = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        root = appdata / ".gemini"
        if not root.exists():
            root = home / ".gemini"
    else:
        root = home / ".gemini"
    return root


def _workspace_to_cwd(workspace: str) -> str:
    """Convert file:// URI to a plain filesystem path."""
    if not workspace:
        return ""
    cwd = unquote(workspace).replace("\\", "/")
    if cwd.startswith("file:///"):
        # file:///Users/... → /Users/...
        # file:///C:/... → C:/...
        cwd = cwd[7:] if cwd[8:9] != ":" else cwd[8:]
    return cwd


def _load_title_map(force_refresh: bool = False) -> dict[str, str]:
    """Load cascade_id → title from vscdb trajectorySummaries (cached).

    vscdb parsing is expensive — cache the result at module level and only
    refresh on explicit request (e.g. server resync command clears cache).
    """
    global _title_map_cache
    if _title_map_cache is not None and not force_refresh:
        return _title_map_cache
    try:
        from .antigravity_vscdb import extract_agent_manager_sessions
        sessions = extract_agent_manager_sessions()
    except Exception:
        _title_map_cache = {}
        return _title_map_cache
    _title_map_cache = {
        cid: str(s.get("title", ""))
        for cid, s in sessions.items()
        if s.get("title")
    }
    return _title_map_cache


def _build_title_from_messages(messages: list[dict]) -> str:
    """Fallback title: first user message, first line, truncated."""
    for m in messages:
        if m.get("type") != "user":
            continue
        content = m.get("message", {}).get("content", "")
        if isinstance(content, str) and content.strip():
            first_line = content.strip().split("\n", 1)[0]
            return first_line[:80]
    return ""


def export_conversations(pb_files: list[Path] | None = None) -> list[dict]:
    """Export Antigravity conversations by decrypting local .pb files.

    Args:
        pb_files: Optional list of specific .pb files to export. If None,
            scans the entire ~/.gemini/antigravity/conversations directory.

    Returns list of changed conversations (content_hash delta from last scan).
    Each entry: {title, cascade_id, workspace, project_name, size, content,
                 content_hash, created_time, last_modified, metadata}
    """
    gemini_root = _gemini_root()
    conv_root = gemini_root / "antigravity" / "conversations"
    if not conv_root.exists():
        return []

    title_map = _load_title_map()
    conversations: list[dict] = []

    if pb_files is None:
        pb_files = sorted(conv_root.glob("*.pb"))
        if pb_files:
            logger.info("Scanning %d Antigravity .pb files", len(pb_files))

    for pb_path in pb_files:
        cascade_id = pb_path.stem
        if not _UUID_RE.match(cascade_id):
            continue

        try:
            stat = pb_path.stat()
        except OSError:
            continue
        mtime_iso = datetime.fromtimestamp(
            stat.st_mtime, tz=timezone.utc,
        ).isoformat().replace("+00:00", "Z")

        # Quick hash check to skip unchanged conversations
        cache_key = f"v26:{cascade_id}:{stat.st_size}:{stat.st_mtime_ns}"
        content_hash = hashlib.sha256(cache_key.encode()).hexdigest()[:16]
        if _last_hashes.get(cascade_id) == content_hash:
            continue

        # Decrypt + parse the full trajectory
        decoded = decode_pb_conversation(pb_path, base_timestamp=mtime_iso)
        messages = decoded.get("messages", [])
        if not messages:
            # Skip conversations we couldn't decode
            _last_hashes[cascade_id] = content_hash
            continue

        workspace = decoded.get("workspace", "")
        cwd = _workspace_to_cwd(workspace)
        project_name = cwd.rstrip("/").split("/")[-1] if cwd else None

        title = title_map.get(cascade_id) or _build_title_from_messages(messages)

        user_count = sum(1 for m in messages if m["type"] == "user")
        assistant_count = sum(1 for m in messages if m["type"] == "assistant")

        # Build JSONL content
        jsonl_lines = [json.dumps({
            "type": "session_meta",
            "timestamp": mtime_iso,
            "payload": {
                "id": cascade_id,
                "timestamp": mtime_iso,
                "cwd": cwd,
                "originator": "Antigravity",
                "model_provider": "google",
                "title": title,
                "step_count": len(messages),
            },
        }, ensure_ascii=False)]

        for msg in messages:
            if msg.get("type") == "user" and cwd and not msg.get("cwd"):
                msg["cwd"] = cwd
            jsonl_lines.append(json.dumps(msg, ensure_ascii=False))

        content = "\n".join(jsonl_lines)

        logger.info(
            "Antigravity %s: %d users + %d assistants (%d messages total) — %s",
            cascade_id[:8], user_count, assistant_count, len(messages),
            title[:50] if title else "(untitled)",
        )

        meta: dict = {
            "source": "pb_decrypted",
            "doc_type": "full_conversation",
            "session_id": cascade_id,
        }
        if title:
            meta["title"] = title
        if cwd:
            meta["project_path"] = cwd
        if project_name:
            meta["project_hash"] = project_name
        meta["export_diagnostics"] = {
            "user_message_count": user_count,
            "assistant_message_count": assistant_count,
            "total_messages": len(messages),
            "pb_size_bytes": stat.st_size,
        }

        conversations.append({
            "title": title or cascade_id[:8],
            "cascade_id": cascade_id,
            "workspace": workspace,
            "project_name": project_name,
            "size": len(content),
            "content": content,
            "content_hash": content_hash,
            "created_time": "",
            "last_modified": mtime_iso,
            "metadata": meta,
            "export_diagnostics": meta["export_diagnostics"],
        })

        _last_hashes[cascade_id] = content_hash

    return conversations
