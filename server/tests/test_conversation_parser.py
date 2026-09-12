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


if __name__ == "__main__":
    unittest.main()

