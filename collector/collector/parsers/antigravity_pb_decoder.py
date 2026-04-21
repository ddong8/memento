"""Antigravity .pb file decoder — AES-256-GCM decryption + protobuf parsing.

The .pb files are encrypted with AES-256-GCM using a hardcoded key from the
language server binary. File layout: nonce(12) || ciphertext || tag(16).

Plaintext is a Trajectory protobuf with the following structure:
- field 1: latest cascade ID reference
- field 2 (repeated): Step — the complete trajectory events (USER_INPUT,
  NOTIFY_USER, PLANNER_RESPONSE, tool calls, etc.). Each step has:
    - field 1 (varint): step type (14=USER_INPUT, 15=PLANNER_RESPONSE,
      82=NOTIFY_USER, 81=TASK_BOUNDARY, others=tool calls)
    - field 4 (varint): status
    - field 5 (bytes): metadata (timestamps)
    - field 19/20/94 (bytes): type-specific payload
- field 3 (repeated): LLMSnapshot — conversation history sent to LLM (subset)
- field 6 (bytes): cascade_id of this file
- field 7 (bytes): workspace metadata with file:// URIs

Step payload field numbers (discovered by inspection):
- Type 14 USER_INPUT:       field 19 → {field 2: text}
- Type 15 PLANNER_RESPONSE: field 20 → {field 1: response text, field 3: thinking}
- Type 82 NOTIFY_USER:      field 94 → {field 2: notificationContent}

Parsing field 2 steps directly gives the complete conversation, bypassing
both the gRPC 4MB limit and the LLM snapshot's context window truncation.
"""

from __future__ import annotations

import logging
import re
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("collector.antigravity_pb_decoder")

# AES-256-GCM key hardcoded in the Antigravity language server binary
_AES_KEY = b"safeCodeiumworldKeYsecretBalloon"

# Step type constants (from field 1 of each Step entry)
STEP_USER_INPUT = 14
STEP_PLANNER_RESPONSE = 15
STEP_NOTIFY_USER = 82

_USER_REQUEST_RE = re.compile(r"<USER_REQUEST>(.*?)</USER_REQUEST>", re.DOTALL)


def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift >= 64:
            raise ValueError("varint too long")
    raise ValueError("truncated varint")


def _parse_message(data: bytes) -> list[tuple[int, int, object]]:
    """Parse protobuf wire format. Returns list of (field_num, wire_type, value)."""
    fields: list[tuple[int, int, object]] = []
    pos = 0
    while pos < len(data):
        try:
            tag, pos = _decode_varint(data, pos)
        except Exception:
            break
        fn = tag >> 3
        wt = tag & 7
        try:
            if wt == 0:
                v, pos = _decode_varint(data, pos)
                fields.append((fn, 0, v))
            elif wt == 1:
                v = struct.unpack("<Q", data[pos:pos + 8])[0]
                pos += 8
                fields.append((fn, 1, v))
            elif wt == 2:
                length, pos = _decode_varint(data, pos)
                v = data[pos:pos + length]
                pos += length
                fields.append((fn, 2, v))
            elif wt == 5:
                v = struct.unpack("<I", data[pos:pos + 4])[0]
                pos += 4
                fields.append((fn, 5, v))
            else:
                break
        except Exception:
            break
    return fields


def _get_field(fields, fn: int, wt: int | None = None):
    for f, w, v in fields:
        if f == fn and (wt is None or w == wt):
            return v
    return None


def _get_fields(fields, fn: int, wt: int | None = None) -> list:
    return [v for f, w, v in fields if f == fn and (wt is None or w == wt)]


def _safe_str(b: bytes) -> str:
    if not b:
        return ""
    try:
        return b.decode("utf-8").strip()
    except Exception:
        return b.decode("utf-8", errors="replace").strip()


def _decrypt_pb(path: Path) -> bytes | None:
    """Decrypt an Antigravity .pb file. Returns plaintext bytes or None."""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        logger.debug("cryptography not installed, cannot decrypt .pb files")
        return None

    try:
        data = path.read_bytes()
    except OSError:
        return None

    if len(data) < 28:
        return None

    try:
        return AESGCM(_AES_KEY).decrypt(data[:12], data[12:], None)
    except Exception as e:
        logger.debug("Failed to decrypt %s: %s", path.name, e)
        return None


def _extract_step_timestamp(metadata_bytes: bytes) -> datetime | None:
    """Parse step metadata (field 5) to extract a createdAt timestamp.

    The metadata contains a nested Timestamp at field 1 with seconds/nanos.
    """
    if not metadata_bytes:
        return None
    try:
        fields = _parse_message(metadata_bytes)
        ts_bytes = _get_field(fields, 1, 2)
        if not ts_bytes:
            return None
        ts_fields = _parse_message(ts_bytes)
        seconds = _get_field(ts_fields, 1, 0) or 0
        nanos = _get_field(ts_fields, 2, 0) or 0
        if seconds <= 0:
            return None
        return datetime.fromtimestamp(seconds, tz=timezone.utc) + timedelta(microseconds=nanos // 1000)
    except Exception:
        return None


def _extract_user_input_text(payload: bytes) -> str:
    """Type 14 USER_INPUT payload → {field 2: text}"""
    inner = _parse_message(payload)
    text_bytes = _get_field(inner, 2, 2)
    if not text_bytes:
        return ""
    text = _safe_str(text_bytes)
    # If wrapped in <USER_REQUEST> tags, extract inner content
    match = _USER_REQUEST_RE.search(text)
    if match:
        return match.group(1).strip()
    return text


def _extract_planner_response(payload: bytes) -> tuple[str, str]:
    """Type 15 PLANNER_RESPONSE payload → (response_text, thinking).

    field 1: visible AI response text (agent commentary shown in sidebar)
    field 3: internal thinking/reasoning
    """
    inner = _parse_message(payload)
    # Field 1 = response text (visible to user)
    f1_bytes = _get_field(inner, 1, 2)
    response = ""
    if f1_bytes:
        text = _safe_str(f1_bytes)
        # Filter control character noise (e.g. <ctrl46> repeated)
        cleaned = re.sub(r"<ctrl\d+>", "", text).strip()
        if len(cleaned) >= 10:
            response = cleaned
    # Field 3 = thinking
    f3_bytes = _get_field(inner, 3, 2)
    thinking = _safe_str(f3_bytes) if f3_bytes else ""
    return response, thinking


def _extract_notify_user_content(payload: bytes) -> tuple[str, list[str]]:
    """Type 82 NOTIFY_USER payload.

    Returns (notification_content, plan_uris) where plan_uris are
    file:// URIs to brain/ plan files referenced by this AI reply.
    """
    inner = _parse_message(payload)
    # Field 1 = reviewAbsoluteUris (file:// URIs to brain plans)
    plan_uris: list[str] = []
    uris_bytes = _get_field(inner, 1, 2)
    if uris_bytes:
        text = _safe_str(uris_bytes)
        for match in re.finditer(r"file://[^\s\x00-\x1f]+", text):
            plan_uris.append(match.group(0))
    # Field 2 = notificationContent (the actual AI reply)
    content_bytes = _get_field(inner, 2, 2)
    content = ""
    if content_bytes:
        s = _safe_str(content_bytes)
        if s and not s.startswith("file://"):
            content = s
    # Fallback: find longest non-URI string
    if not content:
        best = ""
        for fn, wt, v in inner:
            if wt == 2 and isinstance(v, bytes):
                s = _safe_str(v)
                if s and not s.startswith("file://") and len(s) > len(best):
                    best = s
        content = best
    return content, plan_uris


def _uri_to_path(uri: str) -> Path | None:
    """Convert a file:// URI to a Path (handling Windows drive letters)."""
    if not uri.startswith("file://"):
        return None
    from urllib.parse import unquote
    path = unquote(uri[7:])
    # file:///C:/... → C:/...
    if len(path) > 2 and path[2] == ":":
        path = path[1:]
    try:
        return Path(path)
    except Exception:
        return None


def _load_plan_file(uri: str, at_time: datetime | None = None) -> dict | None:
    """Load a brain plan file referenced by a NOTIFY_USER step.

    If at_time is given, finds the .resolved.N snapshot whose mtime is closest
    to (but not after) at_time. Otherwise loads the current version.

    Returns {"title", "uri", "content"} or None if file missing/unreadable.
    """
    path = _uri_to_path(uri)
    if path is None or not path.exists():
        return None

    target_path = path
    if at_time is not None:
        # Look for .resolved.N snapshots matching the message timestamp
        parent = path.parent
        stem = path.name  # e.g. "implementation_plan.md"
        try:
            candidates = list(parent.glob(f"{stem}.resolved*"))
        except OSError:
            candidates = []
        # Also consider the current file
        candidates.append(path)

        target_ts = at_time.timestamp()
        best_path = None
        best_mtime = -1.0
        for c in candidates:
            try:
                mt = c.stat().st_mtime
            except OSError:
                continue
            # Want the latest snapshot whose mtime <= target_ts + small buffer
            if mt <= target_ts + 5 and mt > best_mtime:
                best_mtime = mt
                best_path = c
        if best_path is not None:
            target_path = best_path

    try:
        content = target_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not content.strip():
        return None
    title = path.stem.replace("_", " ").title()
    return {"title": title, "uri": uri, "content": content}


def _extract_workspace(trajectory_fields) -> str:
    """Extract workspace file:// URI from trajectory field 7."""
    ws_bytes = _get_field(trajectory_fields, 7, 2)
    if not ws_bytes:
        return ""
    # Search for first file:// URI in the bytes
    text = ws_bytes.decode("utf-8", errors="replace")
    match = re.search(r"file://[^\x00-\x1f]+", text)
    return match.group(0) if match else ""


def decode_pb_conversation(pb_path: Path, base_timestamp: str = "") -> dict:
    """Decode an Antigravity .pb file into a structured conversation dict.

    Returns:
        {
            "cascade_id": str,
            "workspace": str,     # file:// URI
            "messages": [         # in chronological order
                {"type": "user"|"assistant", "message": {...}, "timestamp": "..."},
                ...
            ],
        }
    """
    result = {"cascade_id": "", "workspace": "", "messages": []}

    plaintext = _decrypt_pb(pb_path)
    if not plaintext:
        return result

    try:
        fields = _parse_message(plaintext)
    except Exception as e:
        logger.debug("Failed to parse %s: %s", pb_path.name, e)
        return result

    # Extract trajectory metadata
    cascade_bytes = _get_field(fields, 6, 2)
    if cascade_bytes:
        result["cascade_id"] = _safe_str(cascade_bytes)
    result["workspace"] = _extract_workspace(fields)

    # Parse all steps (field 2 = repeated Step)
    steps = _get_fields(fields, 2, 2)
    if not steps:
        return result

    # Parse base_timestamp for fallback ordering
    base_dt: datetime | None = None
    if base_timestamp:
        try:
            base_dt = datetime.fromisoformat(base_timestamp.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            pass

    messages: list[dict] = []
    pending_thinking: list[str] = []
    seen_assistant: set[str] = set()
    last_emitted_role: str = ""

    def _flush_pending_thinking(fallback_dt: datetime | None) -> None:
        """Emit accumulated thinking as a standalone assistant message."""
        nonlocal pending_thinking, last_emitted_role
        if not pending_thinking:
            return
        combined = "\n\n---\n\n".join(pending_thinking)
        pending_thinking = []
        if combined in seen_assistant:
            return
        seen_assistant.add(combined)
        ts = ""
        if fallback_dt:
            ts = fallback_dt.isoformat().replace("+00:00", "Z")
        messages.append({
            "type": "assistant",
            "message": {"role": "assistant", "content": [{"type": "text", "text": combined}]},
            "timestamp": ts,
            "thinking_text": combined,
            "content_source": "pb_thinking",
        })
        last_emitted_role = "assistant"

    for idx, step_bytes in enumerate(steps):
        step = _parse_message(step_bytes)
        step_type = _get_field(step, 1, 0)
        metadata = _get_field(step, 5, 2)
        step_dt = _extract_step_timestamp(metadata)
        if step_dt is None and base_dt is not None:
            step_dt = base_dt + timedelta(microseconds=idx)
        ts = step_dt.isoformat().replace("+00:00", "Z") if step_dt else ""

        if step_type == STEP_USER_INPUT:
            payload = _get_field(step, 19, 2)
            if not payload:
                continue
            text = _extract_user_input_text(payload)
            if not text:
                continue
            # No text-based dedup — each step is a unique turn (e.g. multiple "Continue" clicks)
            if last_emitted_role == "user" and pending_thinking:
                _flush_pending_thinking(step_dt)
            else:
                pending_thinking = []
            messages.append({
                "type": "user",
                "message": {"role": "user", "content": text},
                "timestamp": ts,
                "content_source": "pb_decrypted",
            })
            last_emitted_role = "user"

        elif step_type == STEP_PLANNER_RESPONSE:
            payload = _get_field(step, 20, 2)
            if not payload:
                continue
            response, thinking = _extract_planner_response(payload)
            if thinking:
                pending_thinking.append(thinking)
            # PLANNER field 1 = visible AI commentary (like Codex agent_message)
            if response and response not in seen_assistant:
                seen_assistant.add(response)
                msg = {
                    "type": "assistant",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": response}]},
                    "timestamp": ts,
                    "content_source": "pb_decrypted",
                }
                if pending_thinking:
                    msg["thinking_text"] = "\n\n---\n\n".join(pending_thinking)
                    pending_thinking = []
                messages.append(msg)
                last_emitted_role = "assistant"

        elif step_type == STEP_NOTIFY_USER:
            payload = _get_field(step, 94, 2)
            if not payload:
                continue
            content, plan_uris = _extract_notify_user_content(payload)
            if not content or content in seen_assistant:
                continue
            seen_assistant.add(content)

            # Append referenced plan files (implementation_plan.md, walkthrough.md, etc.)
            full_content = content
            for uri in plan_uris:
                plan = _load_plan_file(uri, at_time=step_dt)
                if plan:
                    full_content += (
                        f"\n\n---\n\n"
                        f"### 📋 {plan['title']}\n\n"
                        f"{plan['content']}"
                    )

            msg = {
                "type": "assistant",
                "message": {"role": "assistant", "content": [{"type": "text", "text": full_content}]},
                "timestamp": ts,
                "content_source": "pb_decrypted",
            }
            if pending_thinking:
                msg["thinking_text"] = "\n\n---\n\n".join(pending_thinking)
                pending_thinking = []
            messages.append(msg)
            last_emitted_role = "assistant"

        # Other step types (tool calls, task boundaries, etc.) are ignored

    # Flush any remaining thinking as a standalone message (conversation end)
    if pending_thinking and last_emitted_role == "user":
        _flush_pending_thinking(base_dt + timedelta(microseconds=len(steps)) if base_dt else None)

    result["messages"] = messages
    return result
