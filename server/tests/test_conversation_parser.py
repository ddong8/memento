from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.conversation_parser import parse_conversation_line  # noqa: E402


class ConversationParserTests(unittest.TestCase):
    def test_antigravity_message_preserves_separate_thinking(self) -> None:
        raw = json.dumps({
            "type": "assistant",
            "timestamp": "2026-04-05T10:00:00Z",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Final answer"}],
            },
            "response_text": "Final answer",
            "thinking_text": "Internal reasoning",
            "content_source": "response",
        })

        msg = parse_conversation_line(raw, "antigravity")

        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "assistant")
        self.assertEqual(msg.content, "Final answer")
        self.assertEqual(msg.thinking, "Internal reasoning")
        self.assertEqual(msg.raw_type, "response")

    def test_antigravity_message_falls_back_to_thinking_when_response_missing(self) -> None:
        raw = json.dumps({
            "type": "assistant",
            "timestamp": "2026-04-05T10:00:00Z",
            "message": {"role": "assistant", "content": []},
            "thinking_text": "Only thinking available",
            "fallback_source": "thinking_fallback",
        })

        msg = parse_conversation_line(raw, "antigravity")

        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.content, "Only thinking available")
        self.assertEqual(msg.thinking, "Only thinking available")
        self.assertEqual(msg.raw_type, "thinking_fallback")

    def test_junk_or_uuid_title_detection(self) -> None:
        from server.services.ingest_service import _is_junk_or_uuid_title

        self.assertTrue(_is_junk_or_uuid_title(None))
        self.assertTrue(_is_junk_or_uuid_title(""))
        self.assertTrue(_is_junk_or_uuid_title("   "))
        self.assertTrue(_is_junk_or_uuid_title("transcript"))
        self.assertTrue(_is_junk_or_uuid_title("transcript.jsonl"))
        self.assertTrue(_is_junk_or_uuid_title("untitled"))
        self.assertTrue(_is_junk_or_uuid_title("aa549791-3f81-4e86-bbee-e892b7131a4f"))
        self.assertTrue(_is_junk_or_uuid_title("5a4ed0ef-230f-4965-b1ab-c9945a0b77fa"))
        self.assertTrue(_is_junk_or_uuid_title("session-12345", "session-12345"))

        self.assertFalse(_is_junk_or_uuid_title("项目时间线记录功能"))
        self.assertFalse(_is_junk_or_uuid_title("Fix login bug"))

    def test_claude_code_user_text_message(self) -> None:
        raw = json.dumps({
            "type": "user",
            "timestamp": "2026-09-05T07:00:02.361Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "在吗"}],
            },
        })
        msg = parse_conversation_line(raw, "claude_code")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "user")
        self.assertEqual(msg.content, "在吗")

    def test_claude_code_skips_meta_and_command_injections(self) -> None:
        # isMeta: true
        meta_raw = json.dumps({
            "type": "user",
            "isMeta": True,
            "message": {"role": "user", "content": "<command-message>workflow</command-message>"},
        })
        self.assertIsNone(parse_conversation_line(meta_raw, "claude_code"))

        # command-name XML tag
        cmd_raw = json.dumps({
            "type": "user",
            "message": {
                "role": "user",
                "content": "<command-name>workflow-authoring</command-name>",
            },
        })
        self.assertIsNone(parse_conversation_line(cmd_raw, "claude_code"))

    def test_claude_code_tool_use_parsed_as_tool_call(self) -> None:
        raw = json.dumps({
            "type": "assistant",
            "timestamp": "2026-09-05T07:00:10Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_123",
                        "name": "Bash",
                        "input": {"command": "git status --short", "description": "Check git"},
                    }
                ],
            },
        })
        msg = parse_conversation_line(raw, "claude_code")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "tool")
        self.assertEqual(msg.raw_type, "tool_call")
        self.assertEqual(msg.tool_name, "Bash")
        self.assertEqual(msg.tool_input, "git status --short")

    def test_claude_code_tool_result_parsed_as_tool_output(self) -> None:
        raw = json.dumps({
            "type": "user",
            "timestamp": "2026-09-05T07:00:12Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_123",
                        "content": '{"additionalProperties": false, "type": "object"}',
                    }
                ],
            },
        })
        msg = parse_conversation_line(raw, "claude_code")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "tool")
        self.assertEqual(msg.raw_type, "tool_output")
        self.assertIn("additionalProperties", msg.content)
        self.assertNotEqual(msg.role, "user")  # Crucial: NOT a user chat message!

    def test_claude_code_assistant_text_with_thinking(self) -> None:
        raw = json.dumps({
            "type": "assistant",
            "timestamp": "2026-09-05T07:00:20Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "Let me think about this"},
                    {"type": "text", "text": "Here is the response."},
                ],
            },
        })
        msg = parse_conversation_line(raw, "claude_code")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "assistant")
        self.assertEqual(msg.content, "Here is the response.")
        self.assertEqual(msg.thinking, "Let me think about this")

    def test_codex_assistant_response_item_parsed(self) -> None:
        raw = json.dumps({
            "type": "response_item",
            "timestamp": "2026-09-08T15:50:50Z",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "IPv6 可以让两台设备直接传文件。"}],
            },
        })
        msg = parse_conversation_line(raw, "codex")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "assistant")
        self.assertEqual(msg.content, "IPv6 可以让两台设备直接传文件。")

    def test_codex_user_response_item_parsed_and_plugins_skipped(self) -> None:
        raw_user = json.dumps({
            "type": "response_item",
            "timestamp": "2026-09-08T15:50:44Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "有基于ipv6点对点传输文件的协议吗"}],
            },
        })
        msg = parse_conversation_line(raw_user, "codex")
        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg.role, "user")
        self.assertEqual(msg.content, "有基于ipv6点对点传输文件的协议吗")

        raw_plugins = json.dumps({
            "type": "response_item",
            "timestamp": "2026-09-08T15:50:44Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "<recommended_plugins>\nPlugin list"}],
            },
        })
        self.assertIsNone(parse_conversation_line(raw_plugins, "codex"))

    def test_codex_tool_call_and_output_parsed(self) -> None:
        raw_call = json.dumps({
            "type": "response_item",
            "timestamp": "2026-09-08T15:51:00Z",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "input": "ls -la",
                "call_id": "call_123",
            },
        })
        call_msg = parse_conversation_line(raw_call, "codex")
        self.assertIsNotNone(call_msg)
        assert call_msg is not None
        self.assertEqual(call_msg.role, "tool")
        self.assertEqual(call_msg.raw_type, "tool_call")
        self.assertEqual(call_msg.tool_name, "exec")
        self.assertEqual(call_msg.tool_input, "ls -la")

        raw_out = json.dumps({
            "type": "response_item",
            "timestamp": "2026-09-08T15:51:01Z",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "call_123",
                "output": [{"type": "input_text", "text": "total 42\nfile.txt"}],
            },
        })
        out_msg = parse_conversation_line(raw_out, "codex")
        self.assertIsNotNone(out_msg)
        assert out_msg is not None
        self.assertEqual(out_msg.role, "tool")
        self.assertEqual(out_msg.raw_type, "tool_result")
        self.assertEqual(out_msg.content, "total 42\nfile.txt")


if __name__ == "__main__":
    unittest.main()


