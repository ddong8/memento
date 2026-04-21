"""Antigravity vscdb parser — extracts session titles from globalStorage state.vscdb.

Used only to populate conversation titles when the .pb AES-decryption pipeline
cannot derive one from the first user message. Protobuf parsing is pure Python.

Based on antigravity-trajectory-extractor (MIT):
https://github.com/jijiamoer/antigravity-trajectory-extractor
"""

from __future__ import annotations

import base64
import json
import platform
import re
import sqlite3
import struct
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote


# ---------------------------------------------------------------------------
# Protobuf wire format parser (pure Python, zero deps)
# ---------------------------------------------------------------------------

def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        value = data[pos]
        result |= (value & 0x7F) << shift
        pos += 1
        if not (value & 0x80):
            return result, pos
        shift += 7
    return result, pos


def _parse_fields(data: bytes, start: int, end: int) -> list[dict]:
    fields: list[dict] = []
    cursor = start
    while cursor < end:
        try:
            tag, next_pos = _decode_varint(data, cursor)
            if tag == 0:
                cursor = next_pos
                continue
            field_number, wire_type = tag >> 3, tag & 7
            if wire_type == 0:  # varint
                value, cursor = _decode_varint(data, next_pos)
                fields.append({"fn": field_number, "type": "varint", "value": value})
            elif wire_type == 2:  # length-delimited
                size, start_pos = _decode_varint(data, next_pos)
                if size < 0 or size > end - start_pos:
                    break
                cursor = start_pos + size
                fields.append({"fn": field_number, "type": "bytes", "start": start_pos, "end": cursor})
            elif wire_type == 1:  # fixed64
                fields.append({"fn": field_number, "type": "fixed64",
                               "value": struct.unpack_from("<Q", data, next_pos)[0]})
                cursor = next_pos + 8
            elif wire_type == 5:  # fixed32
                fields.append({"fn": field_number, "type": "fixed32",
                               "value": struct.unpack_from("<I", data, next_pos)[0]})
                cursor = next_pos + 4
            else:
                break
        except Exception:
            break
    return fields


_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def _try_decode_str(data: bytes, start: int, end: int) -> str | None:
    try:
        return data[start:end].decode("utf-8")
    except Exception:
        return None


def _file_uri_to_path(uri: str) -> str:
    decoded = unquote(uri)
    if decoded.startswith("file:///"):
        path_part = decoded[8:]
        if len(path_part) > 1 and path_part[1] == ":":
            return path_part  # Windows: C:/Users/...
        return "/" + path_part  # Unix: /Users/...
    return decoded


def _decode_text_bytes(data: bytes) -> str:
    try:
        return data.decode("utf-8").strip()
    except Exception:
        return ""


def _extract_text_field(data: bytes, field_number: int) -> str:
    for field in _parse_fields(data, 0, len(data)):
        if field["fn"] == field_number and field["type"] == "bytes":
            text = _decode_text_bytes(data[field["start"]:field["end"]])
            if text:
                return text
    return ""


def _extract_timestamp_field(data: bytes, field_number: int) -> str:
    for field in _parse_fields(data, 0, len(data)):
        if field["fn"] != field_number or field["type"] != "bytes":
            continue
        ts = _decode_timestamp(data[field["start"]:field["end"]])
        if ts:
            return ts
    return ""


def _decode_timestamp(data: bytes) -> str:
    seconds = None
    nanos = 0
    for field in _parse_fields(data, 0, len(data)):
        if field["fn"] == 1 and field["type"] == "varint":
            seconds = field["value"]
        elif field["fn"] == 2 and field["type"] == "varint":
            nanos = field["value"]
    if seconds is None:
        return ""
    try:
        stamp = seconds + (nanos / 1_000_000_000)
        return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return ""


def _parse_workspace_uri(session_blob: bytes) -> str:
    for field in _parse_fields(session_blob, 0, len(session_blob)):
        if field["fn"] != 9 or field["type"] != "bytes":
            continue
        chunk = session_blob[field["start"]:field["end"]]
        for sub in _parse_fields(chunk, 0, len(chunk)):
            if sub["type"] != "bytes":
                continue
            text = _decode_text_bytes(chunk[sub["start"]:sub["end"]])
            if text.startswith("file://") and text != "file:///":
                return text
    return ""


def _extract_project_name_from_uri(uri: str) -> str:
    path = _file_uri_to_path(uri).replace("\\", "/").rstrip("/")
    if not path:
        return ""
    return path.split("/")[-1]


def _parse_action_payload_text(action_name: str, payload_json: str) -> tuple[str, str]:
    if not payload_json:
        return "", ""
    try:
        payload = json.loads(payload_json)
    except Exception:
        return "", ""
    if not isinstance(payload, dict):
        return "", ""

    if action_name == "notify_user":
        message = str(payload.get("Message") or payload.get("message") or "").strip()
        thinking = str(
            payload.get("ConfidenceJustification")
            or payload.get("confidenceJustification")
            or ""
        ).strip()
        return message, thinking

    if action_name == "task_boundary":
        parts = [
            str(payload.get("TaskName") or "").strip(),
            str(payload.get("TaskStatus") or "").strip(),
            str(payload.get("TaskSummary") or "").strip(),
        ]
        return "\n".join(part for part in parts if part), ""

    return "", ""


def _extract_event_context(main_blob: bytes) -> tuple[str, str, str]:
    for field in _parse_fields(main_blob, 0, len(main_blob)):
        if field["fn"] != 5 or field["type"] != "bytes":
            continue
        event_blob = main_blob[field["start"]:field["end"]]
        event_fields = _parse_fields(event_blob, 0, len(event_blob))

        timestamp = ""
        for candidate in (8, 7, 6, 22, 1):
            timestamp = _extract_timestamp_field(event_blob, candidate)
            if timestamp:
                break

        action_name = ""
        payload_json = ""
        for event_field in event_fields:
            if event_field["fn"] != 4 or event_field["type"] != "bytes":
                continue
            meta_blob = event_blob[event_field["start"]:event_field["end"]]
            action_name = _extract_text_field(meta_blob, 2)
            payload_json = _extract_text_field(meta_blob, 3)
            break

        return timestamp, action_name, payload_json

    return "", "", ""


def _build_notify_user_message(main_blob: bytes, timestamp: str, payload_json: str) -> dict | None:
    visible = ""
    thinking = ""
    for field in _parse_fields(main_blob, 0, len(main_blob)):
        if field["fn"] != 94 or field["type"] != "bytes":
            continue
        display_blob = main_blob[field["start"]:field["end"]]
        visible = _extract_text_field(display_blob, 2)
        thinking = _extract_text_field(display_blob, 5)
        break

    payload_visible, payload_thinking = _parse_action_payload_text("notify_user", payload_json)
    visible = visible or payload_visible
    thinking = thinking or payload_thinking
    if not visible and not thinking:
        return None

    content = visible or thinking
    return {
        "type": "assistant",
        "message": {"role": "assistant", "content": [{"type": "text", "text": content}]},
        "timestamp": timestamp,
        "response_text": visible,
        "thinking_text": thinking,
        "fallback_source": "offline_vscdb",
        "content_source": "offline_vscdb",
    }


def _build_task_boundary_message(main_blob: bytes, timestamp: str, payload_json: str) -> dict | None:
    content = ""
    for field in _parse_fields(main_blob, 0, len(main_blob)):
        if field["fn"] != 93 or field["type"] != "bytes":
            continue
        display_blob = main_blob[field["start"]:field["end"]]
        rendered = _extract_text_field(display_blob, 4)
        if rendered:
            content = rendered
            break
        parts = [
            _extract_text_field(display_blob, 1),
            _extract_text_field(display_blob, 2),
            _extract_text_field(display_blob, 3),
        ]
        content = "\n".join(part for part in parts if part)
        if content:
            break

    payload_content, _ = _parse_action_payload_text("task_boundary", payload_json)
    content = content or payload_content
    if not content:
        return None

    return {
        "type": "system",
        "message": {"role": "system", "content": content},
        "timestamp": timestamp,
        "fallback_source": "offline_vscdb",
        "content_source": "offline_vscdb",
    }


def _extract_session_messages(session_blob: bytes) -> list[dict]:
    messages: list[dict] = []
    for field in _parse_fields(session_blob, 0, len(session_blob)):
        if field["type"] != "bytes" or field["fn"] in {1, 3, 7, 9, 10, 15}:
            continue
        slot_blob = session_blob[field["start"]:field["end"]]
        for slot_field in _parse_fields(slot_blob, 0, len(slot_blob)):
            if slot_field["fn"] != 1 or slot_field["type"] != "bytes":
                continue
            main_blob = slot_blob[slot_field["start"]:slot_field["end"]]
            timestamp, action_name, payload_json = _extract_event_context(main_blob)
            if action_name == "notify_user":
                msg = _build_notify_user_message(main_blob, timestamp, payload_json)
            elif action_name == "task_boundary":
                msg = _build_task_boundary_message(main_blob, timestamp, payload_json)
            else:
                msg = None
            if msg:
                messages.append(msg)

    messages.sort(key=lambda item: item.get("timestamp", ""))
    return messages


def extract_agent_manager_sessions_from_blob(blob: bytes) -> dict[str, dict]:
    """Extract offline session summaries and readable messages from jetski state."""
    sessions: dict[str, dict] = {}
    root_fields = _parse_fields(blob, 0, len(blob))
    container_field = next(
        (field for field in root_fields if field["fn"] == 1 and field["type"] == "bytes"),
        None,
    )
    if not container_field:
        return sessions

    container = blob[container_field["start"]:container_field["end"]]
    for field in _parse_fields(container, 0, len(container)):
        if field["fn"] != 1 or field["type"] != "bytes":
            continue
        entry_blob = container[field["start"]:field["end"]]
        entry_fields = _parse_fields(entry_blob, 0, len(entry_blob))
        session_id = _extract_text_field(entry_blob, 1)
        session_field = next(
            (entry_field for entry_field in entry_fields if entry_field["fn"] == 2 and entry_field["type"] == "bytes"),
            None,
        )
        if not session_id or not session_field:
            continue

        session_blob = entry_blob[session_field["start"]:session_field["end"]]
        workspace_uri = _parse_workspace_uri(session_blob)
        timestamps = [
            _extract_timestamp_field(session_blob, candidate)
            for candidate in (3, 7, 10)
        ]
        valid_timestamps = [ts for ts in timestamps if ts]
        sessions[session_id] = {
            "session_id": session_id,
            "title": _extract_text_field(session_blob, 1),
            "workspace": workspace_uri,
            "project_name": _extract_project_name_from_uri(workspace_uri),
            "createdTime": min(valid_timestamps) if valid_timestamps else "",
            "lastModifiedTime": max(valid_timestamps) if valid_timestamps else "",
            "messages": _extract_session_messages(session_blob),
            "source_key": "jetskiStateSync.agentManagerInitState",
        }

    return sessions


def extract_agent_manager_sessions(vscdb_path: Path | None = None) -> dict[str, dict]:
    """Extract per-session offline messages from Antigravity's state.vscdb."""
    if vscdb_path is None:
        vscdb_path = _get_vscdb_path()
    if vscdb_path is None:
        return {}

    try:
        conn = sqlite3.connect(f"file:{vscdb_path}?mode=ro", uri=True, timeout=5)
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = ?",
            ("jetskiStateSync.agentManagerInitState",),
        ).fetchone()
        conn.close()
    except Exception:
        return {}

    if not row:
        return {}

    try:
        blob = base64.b64decode(row[0])
    except Exception:
        return {}

    return extract_agent_manager_sessions_from_blob(blob)


# ---------------------------------------------------------------------------
# Session → Workspace mapping
# ---------------------------------------------------------------------------

def _get_vscdb_path() -> Path | None:
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        p = home / "Library" / "Application Support" / "Antigravity" / "User" / "globalStorage" / "state.vscdb"
    elif system == "Windows":
        import os
        appdata = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        p = appdata / "Antigravity" / "User" / "globalStorage" / "state.vscdb"
    else:
        p = home / ".config" / "Antigravity" / "User" / "globalStorage" / "state.vscdb"
    return p if p.exists() else None


