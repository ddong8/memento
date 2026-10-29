"""Unified conversation parser — normalizes different JSONL formats into a common structure.

Supported formats:
- Claude Code: {type: "user"|"assistant"|"ai-title"|"system", message: {role, content}}
- Codex: {type: "response_item"|"event_msg"|"session_meta"|"turn_context", payload: {role, content: [{type, text}]}}
- OpenClaw: {type: "message", role: "user"|"assistant", content: "..."}
"""

from __future__ import annotations

import ast
from datetime import datetime, timezone
import hashlib
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
    status: str = ""    # "running", "succeeded", "failed", "still_running", etc.
    exit_code: int | None = None
    error: str = ""
    timestamp: str = ""
    raw_type: str = ""  # Original message type


def parse_conversation_line(raw_line: str, tool_id: str) -> NormalizedMessage | None:
    """Parse a single JSONL line into a NormalizedMessage, or None if it should be skipped."""
    try:
        obj = json.loads(raw_line, strict=False)
    except (json.JSONDecodeError, TypeError, ValueError):
        return None

    if not isinstance(obj, dict):
        return None

    msg_type = obj.get("type", "")
    raw_ts = obj.get("timestamp", "")
    if isinstance(raw_ts, (int, float)) and raw_ts > 0:
        ts_sec = raw_ts / 1000.0 if raw_ts > 1e11 else float(raw_ts)
        timestamp = datetime.fromtimestamp(ts_sec, tz=timezone.utc).isoformat()
    else:
        timestamp = str(raw_ts or "")

    # --- Claude Code format ---
    if tool_id == "claude_code":
        if obj.get("isMeta"):
            return None

        if msg_type in ("user", "assistant"):
            message = obj.get("message", {})
            role = message.get("role", msg_type)
            raw_content = message.get("content", "")

            # String content
            if isinstance(raw_content, str):
                content = _strip_system_tags(raw_content)
                if "<command-name>" in content or "<command-message>" in content:
                    return None
                if not content.strip():
                    return None
                return NormalizedMessage(
                    role=role, content=content,
                    timestamp=timestamp, raw_type=msg_type,
                )

            # List of blocks
            if isinstance(raw_content, list):
                thinking = _extract_thinking_parts(raw_content)
                text_blocks = [
                    b.get("text", "") for b in raw_content
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                text_content = _strip_system_tags("\n".join(text_blocks))
                tool_uses = [
                    b for b in raw_content
                    if isinstance(b, dict) and b.get("type") in ("tool_use", "toolCall")
                ]
                tool_results = [
                    b for b in raw_content
                    if isinstance(b, dict) and b.get("type") in ("tool_result", "toolResult")
                ]

                # Pure tool results (in Claude Code, sent under role "user")
                if tool_results and not text_content.strip():
                    b = tool_results[0]
                    out = b.get("content", b.get("output", ""))
                    if isinstance(out, list):
                        out = "\n".join(
                            r.get("text", "") if isinstance(r, dict) else str(r)
                            for r in out
                        )
                    is_err = b.get("is_error") is True
                    err_text = str(out) if is_err else ""
                    return NormalizedMessage(
                        role="tool",
                        content=str(out),
                        status="failed" if is_err else "succeeded",
                        exit_code=1 if is_err else 0,
                        error=err_text[:400] if is_err else "",
                        timestamp=timestamp,
                        raw_type="tool_output",
                    )

                # Tool use blocks
                if tool_uses:
                    b = tool_uses[0]
                    name = b.get("name", "tool")
                    inp = b.get("input") if "input" in b else b.get("arguments", {})
                    if isinstance(inp, dict):
                        if name == "Bash" and "command" in inp:
                            tool_input = str(inp["command"])
                        elif "path" in inp:
                            tool_input = str(inp["path"])
                        elif "file_path" in inp:
                            tool_input = str(inp["file_path"])
                        else:
                            tool_input = json.dumps(inp, ensure_ascii=False)
                    elif isinstance(inp, str):
                        tool_input = inp
                    else:
                        tool_input = str(inp)

                    if text_content.strip():
                        return NormalizedMessage(
                            role="assistant",
                            content=text_content,
                            thinking=thinking,
                            tool_name=name,
                            tool_input=tool_input,
                            status="running",
                            timestamp=timestamp,
                            raw_type=msg_type,
                        )
                    return NormalizedMessage(
                        role="tool",
                        content=f"[{name}]",
                        tool_name=name,
                        tool_input=tool_input,
                        thinking=thinking,
                        status="running",
                        timestamp=timestamp,
                        raw_type="tool_call",
                    )

                # Normal conversational user or assistant turn
                if not text_content.strip() and not thinking.strip():
                    return None
                if not text_content.strip():
                    text_content = thinking
                    thinking = ""
                return NormalizedMessage(
                    role=role,
                    content=text_content,
                    thinking=thinking,
                    timestamp=timestamp,
                    raw_type=msg_type,
                )

        if msg_type == "ai-title":
            return None  # Skip title lines

        if msg_type == "system":
            content = _extract_content(obj.get("message", {}).get("content", ""))
            if not content.strip() or "<command-name>" in content or "<command-message>" in content:
                return None  # Skip command metadata
            return NormalizedMessage(role="system", content=content, timestamp=timestamp, raw_type=msg_type)

        # Skip: file-history-snapshot, queue-operation, etc.
        return None

    # --- WorkBuddy format ---
    if tool_id == "workbuddy":
        if obj.get("isMeta"):
            return None

        if msg_type == "message":
            role = obj.get("role") or (obj.get("message", {}) if isinstance(obj.get("message"), dict) else {}).get("role") or "user"
            raw_content = obj.get("content") if "content" in obj else (obj.get("message", {}) if isinstance(obj.get("message"), dict) else {}).get("content", "")
            text = _strip_system_tags(_extract_codex_content(raw_content))
            if text:
                text = text.replace("<user_query>", "").replace("</user_query>", "").strip()
            if not text:
                return None
            if role in ("user", "assistant"):
                return NormalizedMessage(
                    role=role,
                    content=text,
                    timestamp=timestamp,
                    raw_type=msg_type,
                )
            return None

        if msg_type == "reasoning":
            raw_rc = obj.get("rawContent") or obj.get("content") or []
            thinking_text = _extract_codex_content(raw_rc).strip()
            if thinking_text:
                return NormalizedMessage(
                    role="assistant",
                    content="[AI 思考过程]",
                    thinking=thinking_text,
                    timestamp=timestamp,
                    raw_type="reasoning",
                )
            return None

        if msg_type == "function_call":
            name = str(obj.get("name") or "tool")
            inp = obj.get("arguments") or obj.get("input") or ""
            if isinstance(inp, dict):
                tool_input = json.dumps(inp, ensure_ascii=False)
            else:
                tool_input = str(inp)
            return NormalizedMessage(
                role="tool",
                content=f"[{name}]",
                tool_name=name,
                tool_input=tool_input[:2000],
                status="running",
                timestamp=timestamp,
                raw_type="tool_call",
            )

        if msg_type == "function_call_result":
            name = str(obj.get("name") or "tool")
            raw_out = obj.get("output", "")
            if isinstance(raw_out, dict):
                out_text = str(raw_out.get("text") or json.dumps(raw_out, ensure_ascii=False))
            elif isinstance(raw_out, list):
                out_text = _extract_codex_content(raw_out)
            else:
                out_text = str(raw_out)
            display = out_text.strip()
            if len(display) > 5000:
                display = display[:5000] + "\n…(truncated)"
            if display:
                is_failed = obj.get("is_error") is True or bool(obj.get("error"))
                status_val = obj.get("status") or ("failed" if is_failed else "succeeded")
                exit_code_val = obj.get("exit_code")
                error_val = str(obj.get("error") or "")
                return NormalizedMessage(
                    role="tool",
                    content=display,
                    tool_name=name,
                    status=str(status_val),
                    exit_code=exit_code_val if isinstance(exit_code_val, int) else None,
                    error=error_val,
                    timestamp=timestamp,
                    raw_type="tool_result",
                )
            return None

        return None

    # --- Codex format ---
    if tool_id == "codex":
        # Handle modern item.started / item.completed events
        if msg_type in ("item.completed", "item.started", "item.updated"):
            item = obj.get("item")
            if isinstance(item, dict):
                itype = item.get("type", "")
                done = msg_type == "item.completed"
                if itype == "agent_message":
                    text = item.get("text", "")
                    if done and str(text).strip():
                        return NormalizedMessage(
                            role="assistant",
                            content=str(text).strip(),
                            timestamp=timestamp,
                            raw_type="agent_message",
                        )
                    return None
                if itype == "user_message":
                    text = item.get("text") or item.get("message") or item.get("content") or ""
                    if str(text).strip():
                        return NormalizedMessage(
                            role="user",
                            content=str(text).strip(),
                            timestamp=timestamp,
                            raw_type="user_message",
                        )
                    return None
                if itype == "reasoning":
                    rtext = item.get("text") or item.get("summary") or _extract_codex_content(item.get("rawContent", []))
                    if str(rtext).strip():
                        return NormalizedMessage(
                            role="assistant",
                            content="[AI 思考过程]",
                            thinking=str(rtext).strip(),
                            timestamp=timestamp,
                            raw_type="reasoning",
                        )
                    return None
                if itype == "command_execution":
                    cmd = str(item.get("command") or "")
                    exit_code = item.get("exit_code")
                    output = str(item.get("aggregated_output") or "")
                    is_failed = exit_code is not None and exit_code != 0
                    status = "running" if not done else ("failed" if is_failed else "succeeded")
                    display = output.strip() if output.strip() else f"[{cmd}]"
                    if len(display) > 5000:
                        display = display[:5000] + "\n…(truncated)"
                    err_msg = str(item.get("error") or "")
                    if not err_msg and is_failed:
                        err_msg = f"exit code {exit_code}"
                    return NormalizedMessage(
                        role="tool",
                        content=display,
                        tool_name="Shell",
                        tool_input=cmd,
                        status=status,
                        exit_code=exit_code if isinstance(exit_code, int) else None,
                        error=err_msg,
                        timestamp=timestamp,
                        raw_type="command_execution",
                    )
                if itype == "file_change":
                    changes = item.get("changes") or []
                    paths = [str(c.get("path") or "") for c in changes if isinstance(c, dict)]
                    status = "failed" if item.get("status") == "failed" else ("succeeded" if done else "running")
                    return NormalizedMessage(
                        role="tool",
                        content=", ".join(filter(None, paths)) or "[file_change]",
                        tool_name="Edit",
                        status=status,
                        timestamp=timestamp,
                        raw_type="file_change",
                    )
                if itype == "web_search":
                    query = str(item.get("query") or "")
                    return NormalizedMessage(
                        role="tool",
                        content=f"[WebSearch: {query}]",
                        tool_name="WebSearch",
                        tool_input=query,
                        status="succeeded" if done else "running",
                        timestamp=timestamp,
                        raw_type="web_search",
                    )
                if itype == "mcp_tool_call":
                    s_name = f"{item.get('server', '')}.{item.get('tool', '')}".strip(".") or "mcp"
                    return NormalizedMessage(
                        role="tool",
                        content=f"[{s_name}]",
                        tool_name=s_name,
                        tool_input=json.dumps(item.get("arguments", {}), ensure_ascii=False),
                        status="failed" if item.get("status") == "failed" else ("succeeded" if done else "running"),
                        timestamp=timestamp,
                        raw_type="mcp_tool_call",
                    )
            return None

        payload = obj.get("payload", {})

        if msg_type == "response_item":
            role = payload.get("role", "")
            if role in ("developer", "system"):
                return None  # Skip system prompts
            p_type = payload.get("type", "")
            # Skip reasoning — AI internal thought process, not a reply
            if p_type == "reasoning":
                return None
            # Assistant response_item/message — AI response in Codex
            if p_type == "message" and role == "assistant":
                content = _extract_codex_content(payload.get("content", []))
                if content.strip():
                    return NormalizedMessage(role="assistant", content=content.strip(), timestamp=timestamp, raw_type="message")
                return None
            # User response_item/message — real user input (not system context)
            if p_type == "message" and role == "user":
                content = _extract_codex_content(payload.get("content", []))
                if not content.strip():
                    return None
                # Skip Codex system context injections (not real user text)
                if content.lstrip().startswith(("<environment_context>", "<turn_aborted>", "<recommended_plugins>")):
                    return None
                return NormalizedMessage(role="user", content=content.strip(), timestamp=timestamp, raw_type="message")
            # Tool calls (custom_tool_call, function_call, web_search_call)
            if p_type in ("custom_tool_call", "function_call", "web_search_call"):
                tool_name = payload.get("name") or p_type
                tool_input = payload.get("input") or payload.get("arguments") or ""
                if isinstance(tool_input, dict):
                    tool_input = json.dumps(tool_input, ensure_ascii=False)
                elif not isinstance(tool_input, str):
                    tool_input = str(tool_input)
                return NormalizedMessage(
                    role="tool",
                    content=f"[{tool_name}]",
                    tool_name=tool_name,
                    tool_input=tool_input,
                    status="running",
                    timestamp=timestamp,
                    raw_type="tool_call",
                )
            # Tool call outputs
            if p_type in ("custom_tool_call_output", "function_call_output"):
                raw_out = payload.get("output", "")
                if isinstance(raw_out, list):
                    out_text = _extract_codex_content(raw_out)
                elif isinstance(raw_out, dict):
                    out_text = json.dumps(raw_out, ensure_ascii=False)
                else:
                    out_text = str(raw_out)
                display = out_text.strip()
                if len(display) > 5000:
                    display = display[:5000] + "\n…(truncated)"
                if display:
                    is_failed = payload.get("is_error") is True or bool(payload.get("error"))
                    status_val = payload.get("status") or ("failed" if is_failed else "succeeded")
                    exit_code_val = payload.get("exit_code")
                    error_val = str(payload.get("error") or "")
                    return NormalizedMessage(
                        role="tool",
                        content=display,
                        status=str(status_val),
                        exit_code=exit_code_val if isinstance(exit_code_val, int) else None,
                        error=error_val,
                        timestamp=timestamp,
                        raw_type="tool_result",
                    )
                return None
            return None

        if msg_type == "event_msg":
            event_type = payload.get("type", "")
            if event_type == "task_started":
                return None
            # User message — the actual user input in Codex
            if event_type == "user_message":
                text = payload.get("message", "")
                if text.strip():
                    return NormalizedMessage(role="user", content=text.strip(), timestamp=timestamp, raw_type="user_message")
                return None
            # Agent message — intermediate commentary in new Codex, sole reply in old Codex.
            if event_type == "agent_message":
                text = payload.get("message", "")
                if text.strip():
                    return NormalizedMessage(role="assistant", content=text.strip(), timestamp=timestamp, raw_type="agent_message")
                return None
            # Task complete — if last_agent_message is present, emit as assistant (dedup will drop if already seen)
            if event_type == "task_complete":
                last_msg = payload.get("last_agent_message", "")
                if isinstance(last_msg, str) and last_msg.strip():
                    return NormalizedMessage(role="assistant", content=last_msg.strip(), timestamp=timestamp, raw_type="task_complete")
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
                        # A repr, read as one: never run as code (a log line is what a device uploaded)
                        msg_dict = ast.literal_eval(raw_msg)
                    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
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
                # Map OpenClaw's toolResult role (~27% of messages in a real
                # session) to our "tool" role so it participates in the
                # timeline. Without this, every tool step dropped and chat
                # looked like a disjointed user/assistant transcript.
                if role == "toolResult":
                    role = "tool"
                if role in ("user", "assistant", "tool"):
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

        if msg_type == "compaction":
            # Summary line auto-generated when OpenClaw compacts context.
            # Surface as a system message so it's searchable + visible in the
            # transcript instead of being silently dropped.
            summary = obj.get("summary") or ""
            if summary.strip():
                return NormalizedMessage(
                    role="system", content=summary.strip(),
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

    # --- Antigravity format (native transcript.jsonl or collector export) ---
    if tool_id == "antigravity":
        # Native transcript.jsonl: USER_INPUT
        if msg_type == "USER_INPUT" or obj.get("source") == "USER_EXPLICIT":
            raw_content = obj.get("content", "")
            req_match = re.search(r"<USER_REQUEST>(.*?)</USER_REQUEST>", raw_content, re.DOTALL)
            content = req_match.group(1).strip() if req_match else raw_content
            if content.strip():
                return NormalizedMessage(
                    role="user",
                    content=content,
                    timestamp=obj.get("created_at") or timestamp,
                    raw_type=msg_type or "USER_INPUT",
                )
            return None

        # Native transcript.jsonl: SYSTEM_MESSAGE wrapping queued user messages
        if msg_type == "SYSTEM_MESSAGE":
            raw_content = obj.get("content", "")
            m = re.search(
                r"\[Message\]\s+(?:timestamp=[^\s]+\s+)?(?:sender=([^\s]+)\s+)?(?:priority=[^\s]+\s+)?content=(.*)",
                raw_content,
                re.DOTALL,
            )
            if m:
                sender = (m.group(1) or "").strip().lower()
                body = m.group(2).strip()
                if body.endswith("</SYSTEM_MESSAGE>"):
                    body = body[:-len("</SYSTEM_MESSAGE>")].strip()
                is_task_noise = (
                    "task-" in sender
                    or "task id " in body.lower()
                    or "subagent" in sender
                    or body.startswith("[Notice]")
                    or body.startswith("Task id ")
                )
                if not is_task_noise and body:
                    return NormalizedMessage(
                        role="user",
                        content=body,
                        timestamp=obj.get("created_at") or timestamp,
                        raw_type="user_message_queued",
                    )
            return None

        # Native transcript.jsonl: PLANNER_RESPONSE (Assistant text or Tool Call)
        if msg_type == "PLANNER_RESPONSE":
            tool_calls = obj.get("tool_calls") or []
            if tool_calls and isinstance(tool_calls, list):
                tc = tool_calls[0] if isinstance(tool_calls[0], dict) else {}
                tname = tc.get("name", "tool")
                targs = str(tc.get("args") or "")
                return NormalizedMessage(
                    role="tool",
                    content=f"[{tname}]",
                    tool_name=tname,
                    tool_input=targs[:2000],
                    status="running",
                    timestamp=obj.get("created_at") or timestamp,
                    raw_type="tool_call",
                )
            raw_content = obj.get("content", "")
            content = _extract_content(raw_content) if raw_content else ""
            thinking = str(obj.get("thinking", "") or "").strip()
            if not content.strip() and thinking:
                content = "[AI 思考过程]"
            if content.strip():
                return NormalizedMessage(
                    role="assistant",
                    content=content,
                    thinking=thinking,
                    timestamp=obj.get("created_at") or timestamp,
                    raw_type=msg_type,
                )
            return None

        # Native transcript.jsonl: GENERIC (Tool execution result)
        if msg_type == "GENERIC":
            content = (obj.get("content") or "").strip()
            if content:
                err_raw = str(obj.get("error") or "")
                exit_code_raw = obj.get("exit_code")
                is_err = bool(err_raw) or (isinstance(exit_code_raw, int) and exit_code_raw != 0)
                status_raw = obj.get("status") or ("failed" if is_err else "succeeded")
                return NormalizedMessage(
                    role="tool",
                    content=content[:3000],
                    status=str(status_raw),
                    exit_code=exit_code_raw if isinstance(exit_code_raw, int) else None,
                    error=err_raw,
                    timestamp=obj.get("created_at") or timestamp,
                    raw_type="tool_output",
                )
            return None

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
    "user-prompt-submit-hook|task-notification|"
    "command-message|command-name|skill-format|total_tokens"
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
                t = item.get("type")
                if t == "text":
                    parts.append(item.get("text", ""))
                elif t in ("tool_use", "toolCall"):
                    # Claude uses tool_use + input; OpenClaw uses toolCall + arguments.
                    name = item.get("name", "tool")
                    inp = item.get("input") if "input" in item else item.get("arguments", {})
                    inp_str = json.dumps(inp, ensure_ascii=False) if not isinstance(inp, str) else inp
                    parts.append(f"[Tool: {name}]\n{inp_str}")
                elif t in ("tool_result", "toolResult"):
                    result = item.get("content", item.get("output", ""))
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


def _iter_json_objects(raw_content: str):
    """Yield JSON object source strings from mixed compact JSONL / pretty-
    printed content. Claude Code's VS Code extension on Windows sometimes
    writes entries as indented multi-line JSON in the same ``.jsonl`` file
    as compact ones; splitting on newlines loses those multi-line objects
    entirely. Using json.JSONDecoder.raw_decode walks the stream and
    tolerates arbitrary whitespace between objects.
    """
    if not raw_content:
        return
    decoder = json.JSONDecoder(strict=False)
    i = 0
    n = len(raw_content)
    while i < n:
        # skip any whitespace (incl newlines, CR, tabs) between objects
        while i < n and raw_content[i] in " \t\r\n":
            i += 1
        if i >= n:
            break
        try:
            obj, end = decoder.raw_decode(raw_content, i)
            # Re-serialize as a single compact line so downstream
            # parse_conversation_line (which expects one JSON per string)
            # works unchanged.
            yield json.dumps(obj, ensure_ascii=False)
            i = end
        except json.JSONDecodeError:
            # Couldn't parse starting here — advance to next newline and
            # retry. This handles truncated fragments / concatenation noise.
            next_nl = raw_content.find("\n", i)
            if next_nl < 0:
                break
            i = next_nl + 1


def _pretty_leading_json(text: str) -> str:
    """If text starts with a JSON object/array, pretty-print just that prefix
    and append any trailing non-JSON text unchanged. Otherwise return as-is."""
    s = text.lstrip()
    if not s or s[0] not in "{[":
        return text
    try:
        obj, end = json.JSONDecoder().raw_decode(s)
    except json.JSONDecodeError:
        return text
    pretty = json.dumps(obj, ensure_ascii=False, indent=2)
    rest = s[end:].strip()
    return pretty + "\n\n" + rest if rest else pretty


def _format_hermes_tool_content(content_str: str) -> str:
    """Hermes tool result is `{"output": ..., "exit_code": 0, "error": null}`.
    Extract output (parse inner JSON if applicable), prepend error/exit_code notes.
    """
    try:
        outer = json.loads(content_str)
    except (json.JSONDecodeError, TypeError):
        return content_str
    if not isinstance(outer, dict):
        return content_str

    output = outer.get("output", "")
    error = outer.get("error")
    exit_code = outer.get("exit_code")

    # output may be a JSON-encoded string, optionally followed by non-JSON
    # trailing text (e.g. terminal output prints a JSON line then a stack
    # trace). Pretty-print just the leading JSON value with raw_decode and
    # preserve whatever comes after.
    pretty: str
    if isinstance(output, str):
        pretty = _pretty_leading_json(output)
    elif isinstance(output, (dict, list)):
        pretty = json.dumps(output, ensure_ascii=False, indent=2)
    else:
        pretty = str(output) if output is not None else ""

    parts = []
    if error:
        parts.append(f"⚠️  {error}")
    if pretty:
        parts.append(pretty)
    if exit_code not in (None, 0):
        parts.append(f"(exit_code={exit_code})")
    return "\n\n".join(parts) if parts else content_str


def _parse_hermes_session(raw_content: str, offset: int, limit: int | None) -> list[NormalizedMessage]:
    """Hermes stores a whole session as a single top-level JSON, not JSONL."""
    try:
        d = json.loads(raw_content)
    except json.JSONDecodeError:
        return []
    if not isinstance(d, dict):
        return []
    msgs = d.get("messages") or []
    timestamp = d.get("last_updated") or d.get("session_start") or ""

    # Pre-scan: build call_id → tool_name from assistant.tool_calls
    tool_name_by_id: dict[str, str] = {}
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for tc in m.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            name = fn.get("name") if isinstance(fn, dict) else None
            cid = tc.get("id") or tc.get("call_id")
            if cid and name:
                tool_name_by_id[str(cid)] = str(name)

    out: list[NormalizedMessage] = []
    skipped = 0
    for m in msgs:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content", "")
        if not isinstance(content, str):
            content = "" if content is None else str(content)
        text = content.strip()

        if role == "system" or not text:
            continue
        if role == "user":
            norm = NormalizedMessage(role="user", content=text, timestamp=timestamp)
        elif role == "assistant":
            norm = NormalizedMessage(role="assistant", content=text, timestamp=timestamp)
        elif role == "tool":
            tcid = str(m.get("tool_call_id") or "")
            tool_name = tool_name_by_id.get(tcid, "tool")
            formatted = _format_hermes_tool_content(text)
            display = formatted if len(formatted) <= 4000 else formatted[:4000] + "\n…(truncated)"
            h_status = "succeeded"
            h_exit_code = None
            h_error = ""
            try:
                outer = json.loads(text)
                if isinstance(outer, dict):
                    h_exit_code = outer.get("exit_code")
                    h_error = str(outer.get("error") or "")
                    if h_error or (isinstance(h_exit_code, int) and h_exit_code != 0):
                        h_status = "failed"
            except Exception:
                pass
            norm = NormalizedMessage(
                role="tool",
                content=display,
                tool_name=tool_name,
                status=h_status,
                exit_code=h_exit_code if isinstance(h_exit_code, int) else None,
                error=h_error,
                timestamp=timestamp,
            )
        else:
            continue

        if skipped < offset:
            skipped += 1
            continue
        out.append(norm)
        if limit and len(out) >= limit:
            break
    return out


def _count_hermes_messages(raw_content: str) -> int:
    try:
        d = json.loads(raw_content)
    except json.JSONDecodeError:
        return 0
    if not isinstance(d, dict):
        return 0
    n = 0
    for m in d.get("messages") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        content = m.get("content", "")
        if not isinstance(content, str):
            content = "" if content is None else str(content)
        if role == "system" or not content.strip() or role not in ("user", "assistant", "tool"):
            continue
        n += 1
    return n


def parse_conversation(raw_content: str, tool_id: str, offset: int = 0, limit: int | None = None) -> list[NormalizedMessage]:
    """Parse JSONL conversation into normalized messages. Supports pagination."""
    if tool_id == "hermes":
        return _parse_hermes_session(raw_content, offset, limit)
    messages = []
    seen: set[str] = set()
    skipped = 0
    for line in _iter_json_objects(raw_content):
        if not line.strip():
            continue
        msg = parse_conversation_line(line.strip(), tool_id)
        if msg and msg.role in ("user", "assistant"):
            # Deduplicate: same role + content + timestamp (within same second)
            # Prevents event_msg/user_message and response_item/user duplicates
            dedupe_key = dialogue_key(msg.role, msg.timestamp, msg.content)
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
    if tool_id == "hermes":
        return _count_hermes_messages(raw_content)
    count = 0
    seen: set[str] = set()
    for line in _iter_json_objects(raw_content):
        if not line.strip():
            continue
        msg = parse_conversation_line(line.strip(), tool_id)
        if msg and msg.role in ("user", "assistant"):
            dedupe_key = dialogue_key(msg.role, msg.timestamp, msg.content)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            count += 1
        elif msg:
            count += 1
    return count


# ---- what conversation_messages stores ----

STORED_ROLES = ("user", "assistant", "tool", "system")


def parse_timestamp(raw: str | None) -> datetime | None:
    """A message's time as conversation_messages stores it. One without a zone is UTC, as the
    database takes it."""
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)


def _second(raw: str | None, ts: datetime | None) -> str:
    if ts is not None:
        return str(int(ts.replace(microsecond=0).timestamp()))
    return (raw or "")[:19]


def dialogue_key(role: str, timestamp: str | None, content: str, ts: datetime | None = None) -> str:
    """What two copies of one user or assistant message share: Codex writes each of them twice (an
    event_msg and a response_item). Same role, same text, same second."""
    if ts is None:
        ts = parse_timestamp(timestamp)
    return hashlib.md5(f"{role}:{_second(timestamp, ts)}:{content}".encode("utf-8", "surrogatepass")).hexdigest()


@dataclass
class StoredMessage:
    """One row conversation_messages gets for a message, before its line number."""
    message_type: str
    role: str
    content: str
    metadata: dict
    timestamp: datetime | None
    key: str  # what a stored row for this message matches on (row_key)

    @property
    def loose(self) -> str | None:
        """Role and second only: what a row an older parser stored for this message still shares
        with it (message_store.plan_alignment, "interleave")."""
        if self.timestamp is None:
            return None
        return f"{self.role}:{int(self.timestamp.replace(microsecond=0).timestamp())}"


def row_key(role: str | None, ts: datetime | None, content: str | None, tool_input: str | None = "") -> str:
    """Identity of a stored message: role, second, text and, for a tool call, its input. Parallel calls
    of one tool in the same second (content "[Bash]" each) differ by their input. message_store.ROW_KEY_SQL
    computes the same in the database."""
    sec = str(int(ts.replace(microsecond=0).timestamp())) if ts is not None else ""
    return hashlib.md5(f"{role or ''}:{sec}:{content or ''}\x1f{tool_input or ''}".encode("utf-8", "surrogatepass")).hexdigest()


def messages_to_store(raw_content: str, tool_id: str, seen: set[str] | None = None) -> list[StoredMessage]:
    """The messages of a JSONL conversation conversation_messages keeps, in order.

    A line that is there twice (a slice appended twice when an upload was retried) counts once.
    User and assistant messages are also deduplicated by dialogue_key, as parse_conversation does;
    tool calls only as identical lines: deduplicating them by role, second and text ("[Bash]") dropped
    parallel calls of one tool (10-29: 33 calls missing from three days of one Mac's sessions).
    `seen` carries dialogue keys over from the messages already stored, for a delta."""
    seen = seen if seen is not None else set()
    lines_seen: set[str] = set()
    out: list[StoredMessage] = []
    for line in _iter_json_objects(raw_content):
        line = line.strip()
        if not line:
            continue
        msg = parse_conversation_line(line, tool_id)
        if not msg or msg.role not in STORED_ROLES:
            continue
        line_key = hashlib.md5(line.encode("utf-8", "surrogatepass")).hexdigest()
        if line_key in lines_seen:
            continue
        lines_seen.add(line_key)
        content = msg.content.replace("\x00", "")
        ts = parse_timestamp(msg.timestamp)
        if msg.role in ("user", "assistant"):
            dk = dialogue_key(msg.role, msg.timestamp, content, ts)
            if dk in seen:
                continue
            seen.add(dk)
        meta: dict = {}
        if msg.thinking:
            meta["thinking"] = msg.thinking.replace("\x00", "")
        if msg.tool_name:
            meta["tool_name"] = msg.tool_name.replace("\x00", "")
        if msg.tool_input:
            meta["tool_input"] = msg.tool_input.replace("\x00", "")
        out.append(StoredMessage(
            message_type=msg.raw_type or msg.role,
            role=msg.role,
            content=content,
            metadata=meta,
            timestamp=ts,
            key=row_key(msg.role, ts, content, meta.get("tool_input", "")),
        ))
    return out


def hermes_messages_to_store(raw_content: str) -> list[StoredMessage]:
    """messages_to_store for a Hermes session (one JSON document, not JSONL)."""
    out: list[StoredMessage] = []
    for m in parse_conversation(raw_content, "hermes"):
        content = (m.content or "").replace("\x00", "")
        ts = parse_timestamp(m.timestamp)
        out.append(StoredMessage(
            message_type=m.role,
            role=m.role,
            content=content,
            metadata={"tool_name": m.tool_name} if m.tool_name else {},
            timestamp=ts,
            key=row_key(m.role, ts, content),
        ))
    return out
