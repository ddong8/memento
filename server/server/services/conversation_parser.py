"""Unified conversation parser — normalizes different JSONL formats into a common structure.

Supported formats:
- Claude Code: {type: "user"|"assistant"|"ai-title"|"system", message: {role, content}}
- Codex: {type: "response_item"|"event_msg"|"session_meta"|"turn_context", payload: {role, content: [{type, text}]}}
- OpenClaw: {type: "message", role: "user"|"assistant", content: "..."}
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass
class NormalizedMessage:
    """A single conversation message in a unified format."""
    role: str           # "user", "assistant", "system", "tool"
    content: str        # Plain text content
    tool_name: str = "" # If role=="tool", the tool that was used
    tool_input: str = ""  # Tool input/command
    thinking: str = ""  # Optional thinking/reasoning text kept separate from final response
    timestamp: str = ""
    raw_type: str = ""  # Original message type


def parse_conversation_line(raw_line: str, tool_id: str) -> NormalizedMessage | None:
    """Parse a single JSONL line into a NormalizedMessage, or None if it should be skipped."""
    try:
        obj = json.loads(raw_line)
    except json.JSONDecodeError:
        return None

    if not isinstance(obj, dict):
        return None

    msg_type = obj.get("type", "")
    timestamp = obj.get("timestamp", "")

    # --- Claude Code format ---
    if tool_id == "claude_code":
        if msg_type in ("user", "assistant"):
            message = obj.get("message", {})
            role = message.get("role", msg_type)
            raw_content = message.get("content", "")
            # Extract thinking separately from final text (Claude extended thinking)
            thinking = _extract_thinking_parts(raw_content)
            content = _extract_content(raw_content)
            if not content.strip() and not thinking.strip():
                return None
            # If only thinking is present (no text reply), use thinking as content
            if not content.strip():
                content = thinking
                thinking = ""
            return NormalizedMessage(
                role=role, content=content, thinking=thinking,
                timestamp=timestamp, raw_type=msg_type,
            )

        if msg_type == "ai-title":
            return None  # Skip title lines

        if msg_type == "system":
            content = _extract_content(obj.get("message", {}).get("content", ""))
            if not content.strip() or "<command-name>" in content:
                return None  # Skip command metadata
            return NormalizedMessage(role="system", content=content, timestamp=timestamp, raw_type=msg_type)

        # Skip: file-history-snapshot, queue-operation, etc.
        return None

    # --- Codex format ---
    if tool_id == "codex":
        payload = obj.get("payload", {})

        if msg_type == "response_item":
            role = payload.get("role", "")
            if role in ("developer", "system"):
                return None  # Skip system prompts
            p_type = payload.get("type", "")
            # Skip reasoning — AI internal thought process, not a reply
            if p_type == "reasoning":
                return None
            # Skip assistant response_item/message — duplicates event_msg/agent_message
            if p_type == "message" and role == "assistant":
                return None
            # User response_item/message — real user input (not system context)
            if p_type == "message" and role == "user":
                content = _extract_codex_content(payload.get("content", []))
                if not content.strip():
                    return None
                # Skip Codex system context injections (not real user text)
                if content.lstrip().startswith("<environment_context>"):
                    return None
                if content.lstrip().startswith("<turn_aborted>"):
                    return None
                return NormalizedMessage(role="user", content=content, timestamp=timestamp, raw_type=msg_type)
            return None

        if msg_type == "event_msg":
            event_type = payload.get("type", "")
            if event_type == "task_started":
                return None
            # User message — the actual user input in Codex
            if event_type == "user_message":
                text = payload.get("message", "")
                if text.strip():
                    return NormalizedMessage(role="user", content=text, timestamp=timestamp, raw_type="user_message")
                return None
            # Agent message — intermediate commentary in new Codex, sole reply in old Codex.
            # Kept as assistant message; if task_complete also exists, ingest dedup handles it.
            if event_type == "agent_message":
                text = payload.get("message", "")
                if text.strip():
                    return NormalizedMessage(role="assistant", content=text, timestamp=timestamp, raw_type="agent_message")
                return None
            # Task complete — last_agent_message duplicates the last agent_message, skip
            if event_type == "task_complete":
                return None
            return None

        return None  # Skip session_meta, turn_context, etc.

    # --- OpenClaw format ---
    if tool_id == "openclaw":
        if msg_type == "message":
            raw_msg = obj.get("message", "")
            # OpenClaw stores message as Python repr string, try to parse
            msg_dict = None
            if isinstance(raw_msg, str):
                try:
                    msg_dict = json.loads(raw_msg)
                except json.JSONDecodeError:
                    try:
                        msg_dict = eval(raw_msg)  # noqa: S307 — OpenClaw uses repr format
                    except Exception:
                        pass
            elif isinstance(raw_msg, dict):
                msg_dict = raw_msg

            if msg_dict and isinstance(msg_dict, dict):
                role = msg_dict.get("role", "unknown")
                raw_content = msg_dict.get("content", "")
                # Extract thinking separately (OpenClaw uses Claude-style content array)
                thinking = _extract_thinking_parts(raw_content)
                content = _extract_content(raw_content)
                # Strip OpenClaw metadata prefix (Conversation info blocks)
                if content.startswith("Conversation info"):
                    # Extract actual user text after the JSON block
                    parts = content.split("```\n")
                    if len(parts) >= 3:
                        content = parts[-1].strip()
                    elif len(parts) >= 2:
                        content = parts[-1].strip()
                # Strip [[reply_to_current]] prefix
                content = content.replace("[[reply_to_current]] ", "")
                if role in ("user", "assistant"):
                    if not content.strip() and thinking.strip():
                        # Only thinking — use it as content
                        content = thinking
                        thinking = ""
                    if content.strip():
                        return NormalizedMessage(
                            role=role, content=content.strip(), thinking=thinking,
                            timestamp=timestamp, raw_type=msg_type,
                        )
            return None

        if msg_type in ("session", "model_change", "thinking_level_change", "custom"):
            return None

        if msg_type == "tool_call":
            name = obj.get("name", "tool")
            args = obj.get("arguments", obj.get("data", ""))
            return NormalizedMessage(
                role="tool", content=f"[{name}]", tool_name=name,
                tool_input=str(args), timestamp=timestamp, raw_type=msg_type,
            )
        if msg_type == "tool_result":
            output = str(obj.get("data", obj.get("output", "")))
            return NormalizedMessage(role="tool", content=output, timestamp=timestamp, raw_type="tool_output")

        return None

    # --- Antigravity format (generated by collector export) ---
    if tool_id == "antigravity":
        if msg_type == "session_meta":
            return None  # Skip metadata line

        if msg_type in ("user", "assistant"):
            message = obj.get("message", {})
            role = message.get("role", msg_type)
            content = _extract_content(message.get("content", ""))
            thinking = str(obj.get("thinking_text", "") or "").strip()
            raw_type = obj.get("content_source") or obj.get("fallback_source") or msg_type
            # pb_thinking = standalone thinking with no visible reply
            # Show as collapsible thinking (same UX as Claude Code thinking)
            if raw_type == "pb_thinking" and thinking:
                return NormalizedMessage(
                    role="assistant",
                    content="[AI 思考过程]",
                    thinking=thinking,
                    timestamp=timestamp,
                    raw_type=raw_type,
                )
            if not content.strip():
                content = thinking
            if not content.strip():
                return None
            return NormalizedMessage(
                role=role,
                content=content,
                thinking=thinking,
                timestamp=timestamp,
                raw_type=raw_type,
            )

        if msg_type == "tool":
            tool_name = obj.get("tool_name", "tool")
            tool_input = obj.get("tool_input", "")
            content = obj.get("content", f"[{tool_name}]")
            return NormalizedMessage(
                role="tool", content=content, tool_name=tool_name,
                tool_input=tool_input, timestamp=timestamp, raw_type=msg_type,
            )

        if msg_type == "system":
            message = obj.get("message", {})
            content = _extract_content(message.get("content", ""))
            if content.strip():
                raw_type = obj.get("content_source") or obj.get("fallback_source") or msg_type
                return NormalizedMessage(
                    role="system",
                    content=content,
                    timestamp=timestamp,
                    raw_type=raw_type,
                )
            return None

        return None

    # --- Cursor format: {"role": "user/assistant", "message": {"content": [...]}} ---
    if tool_id == "cursor" or (not msg_type and "message" in obj and "role" in obj):
        role = obj.get("role", "")
        message = obj.get("message", {})
        if isinstance(message, dict):
            raw_content = message.get("content", "")
        else:
            raw_content = message
        thinking = _extract_thinking_parts(raw_content)
        content = _extract_content(raw_content)
        # Strip <user_query> tags
        if content:
            content = content.replace("<user_query>", "").replace("</user_query>", "").strip()
        if role in ("user", "assistant") and content.strip():
            # Skip tool_result/tool_use noise
            if content.startswith("[Tool:") or content.startswith("[Result]"):
                return None
            return NormalizedMessage(
                role=role, content=content, thinking=thinking,
                timestamp=timestamp, raw_type=msg_type or role,
            )
        return None

    # --- Generic fallback ---
    role = obj.get("role", msg_type)
    content = _extract_content(obj.get("content", obj.get("message", "")))
    if role in ("user", "assistant", "system") and content.strip():
        return NormalizedMessage(role=role, content=content, timestamp=timestamp, raw_type=msg_type)

    return None


_SYSTEM_TAGS = (
    "ide_opened_file|ide_selection|system-reminder|"
    "user-prompt-submit-hook|task-notification"
)
_SYSTEM_TAG_RE = re.compile(
    rf"<(?:{_SYSTEM_TAGS})[^>]*>.*?</(?:{_SYSTEM_TAGS})>",
    re.DOTALL,
)
# Plain-text system lines injected by Claude Code (not XML tags)
_SYSTEM_LINE_RE = re.compile(
    r"Read the output file to retrieve the result:\s*/\S+\.output\b",
)


def _strip_system_tags(text: str) -> str:
    """Remove IDE/system injection tags and system lines from message content."""
    text = _SYSTEM_TAG_RE.sub("", text)
    text = _SYSTEM_LINE_RE.sub("", text)
    return text.strip()


def _extract_thinking_parts(content) -> str:
    """Extract Claude-style thinking blocks from a content list.

    Claude Code extended thinking stores reasoning as:
        {"type": "thinking", "thinking": "..."}
    or as redacted thinking:
        {"type": "redacted_thinking", "data": "..."}
    """
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        t = item.get("type", "")
        if t == "thinking":
            text = item.get("thinking", "")
            if text:
                parts.append(text)
        elif t == "redacted_thinking":
            data = item.get("data", "")
            if data:
                parts.append(f"[redacted thinking: {len(data)} bytes]")
    return "\n\n".join(parts)


def _extract_content(content) -> str:
    """Extract text from content that could be string, list, or dict.

    Also strips any IDE/system injection tags.
    """
    if isinstance(content, str):
        return _strip_system_tags(content)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
                elif item.get("type") == "tool_use":
                    name = item.get("name", "tool")
                    inp = json.dumps(item.get("input", {}), ensure_ascii=False)
                    parts.append(f"[Tool: {name}]\n{inp}")
                elif item.get("type") == "tool_result":
                    result = item.get("content", "")
                    if isinstance(result, list):
                        result = " ".join(r.get("text", "") for r in result if isinstance(r, dict))
                    parts.append(f"[Result]\n{str(result)}")
            elif isinstance(item, str):
                parts.append(item)
        return _strip_system_tags("\n".join(parts))
    if isinstance(content, dict):
        return content.get("text", json.dumps(content, ensure_ascii=False))
    return str(content)


def _extract_codex_content(content_list) -> str:
    """Extract text from Codex content array: [{type: "input_text"|"output_text", text: "..."}]"""
    if isinstance(content_list, str):
        return content_list
    if not isinstance(content_list, list):
        return str(content_list)
    parts = []
    for item in content_list:
        if isinstance(item, dict):
            parts.append(item.get("text", ""))
        elif isinstance(item, str):
            parts.append(item)
    return "\n".join(parts)


def parse_conversation(raw_content: str, tool_id: str, offset: int = 0, limit: int | None = None) -> list[NormalizedMessage]:
    """Parse JSONL conversation into normalized messages. Supports pagination."""
    import hashlib
    messages = []
    seen: set[str] = set()
    skipped = 0
    for line in raw_content.splitlines():
        if not line.strip():
            continue
        msg = parse_conversation_line(line.strip(), tool_id)
        if msg and msg.role in ("user", "assistant"):
            # Deduplicate: same role + content + timestamp (within same second)
            # Prevents event_msg/user_message and response_item/user duplicates
            ts_bucket = (msg.timestamp or "")[:19]
            dedupe_key = hashlib.md5(f"{msg.role}:{ts_bucket}:{msg.content}".encode()).hexdigest()
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            if skipped < offset:
                skipped += 1
                continue
            messages.append(msg)
            if limit and len(messages) >= limit:
                break
        elif msg:
            if skipped < offset:
                skipped += 1
                continue
            messages.append(msg)
            if limit and len(messages) >= limit:
                break
    return messages


def count_conversation_messages(raw_content: str, tool_id: str) -> int:
    """Count messages without building full list — memory efficient."""
    import hashlib
    count = 0
    seen: set[str] = set()
    for line in raw_content.splitlines():
        if not line.strip():
            continue
        msg = parse_conversation_line(line.strip(), tool_id)
        if msg and msg.role in ("user", "assistant"):
            ts_bucket = (msg.timestamp or "")[:19]
            dedupe_key = hashlib.md5(f"{msg.role}:{ts_bucket}:{msg.content}".encode()).hexdigest()
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            count += 1
        elif msg:
            count += 1
    return count
