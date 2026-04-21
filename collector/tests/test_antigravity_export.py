from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "collector"))

from collector.parsers.antigravity_export import (  # noqa: E402
    _collect_local_session_artifacts,
    _collect_chat_export_sessions,
    _build_pb_fallback_messages,
    _merge_summary,
    _parse_chat_export_markdown,
    _extract_generator_fallbacks,
    _step_to_jsonl_line,
)


class AntigravityExportTests(unittest.TestCase):
    def test_merge_summary_keeps_richer_fields(self) -> None:
        merged = _merge_summary(
            {
                "summary": "",
                "stepCount": 3,
                "createdTime": "",
                "lastModifiedTime": "2026-04-05T10:00:00Z",
                "workspaces": [],
            },
            {
                "summary": "Recovered title",
                "stepCount": 8,
                "createdTime": "2026-04-05T09:00:00Z",
                "lastModifiedTime": "",
                "workspaces": [{"workspaceFolderAbsoluteUri": "file:///tmp/project"}],
            },
        )

        self.assertEqual(merged["summary"], "Recovered title")
        self.assertEqual(merged["stepCount"], 8)
        self.assertEqual(merged["createdTime"], "2026-04-05T09:00:00Z")
        self.assertEqual(
            merged["workspaces"][0]["workspaceFolderAbsoluteUri"],
            "file:///tmp/project",
        )

    def test_merge_summary_replaces_unindexed_placeholder(self) -> None:
        merged = _merge_summary(
            {
                "summary": "[unindexed] af376bab...",
                "stepCount": 0,
            },
            {
                "summary": "Optimizing Data Loading Speed",
                "stepCount": 42,
            },
        )

        self.assertEqual(merged["summary"], "Optimizing Data Loading Speed")
        self.assertEqual(merged["stepCount"], 42)

    def test_planner_response_keeps_response_and_thinking(self) -> None:
        step = {
            "type": "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            "metadata": {"createdAt": "2026-04-05T10:00:00Z"},
            "plannerResponse": {
                "response": "Final answer",
                "thinking": "Internal reasoning",
            },
        }

        msg = _step_to_jsonl_line(step, "cascade-id", "2026-04-05T09:59:59Z")

        self.assertIsNotNone(msg)
        assert msg is not None
        self.assertEqual(msg["type"], "assistant")
        self.assertEqual(msg["response_text"], "Final answer")
        self.assertEqual(msg["thinking_text"], "Internal reasoning")
        self.assertEqual(msg["fallback_source"], "")
        self.assertEqual(msg["message"]["content"][0]["text"], "Final answer")

    def test_generator_metadata_recovers_transcript_and_metadata_messages(self) -> None:
        payload = {
            "messagesTruncated": True,
            "transcript": "User: hello\nAssistant: recovered from transcript",
            "items": [
                {"role": "assistant", "text": "recovered from metadata"},
                {"role": "assistant", "text": "recovered from metadata"},
            ],
        }

        messages, diagnostics = _extract_generator_fallbacks(payload, "2026-04-05T10:00:00Z")
        contents = [msg["message"]["content"][0]["text"] for msg in messages]

        self.assertIn("recovered from transcript", contents)
        self.assertIn("recovered from metadata", contents)
        self.assertEqual(diagnostics["transcript_messages"], 1)
        self.assertEqual(diagnostics["generator_metadata_messages"], 1)
        self.assertTrue(diagnostics["messages_truncated"])

    def test_offline_pb_fallback_builds_messages_from_fragments(self) -> None:
        messages, diagnostics = _build_pb_fallback_messages([
            "Assistant: recovered from transcript",
            "This is a long recovered protobuf fragment that should remain visible to the user.",
            "file:///Users/test/project",
            "abcd1234",
        ], "2026-04-05T10:00:00Z")

        contents = [msg["message"]["content"][0]["text"] for msg in messages]
        self.assertIn("recovered from transcript", contents)
        self.assertIn(
            "This is a long recovered protobuf fragment that should remain visible to the user.",
            contents,
        )
        self.assertEqual(diagnostics["offline_pb_transcript_messages"], 1)
        self.assertEqual(diagnostics["offline_pb_messages"], 1)

    def test_collect_local_session_artifacts_counts_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            conv = root / "conversations"
            brain = root / "brain" / "session-1"
            browser = root / "browser_recordings" / "session-1"
            conv.mkdir(parents=True)
            brain.mkdir(parents=True)
            browser.mkdir(parents=True)

            (conv / "session-1.pb").write_bytes(b"\x00\x01")
            (brain / "task.md").write_text("# task\n", encoding="utf-8")
            (brain / "walkthrough.md").write_text("# walkthrough\n", encoding="utf-8")
            (browser / "1.jpg").write_bytes(b"jpg")
            (browser / "2.jpg").write_bytes(b"jpg")
            (browser / "metadata.json").write_text(
                json.dumps({"highlights": [{"start_time": "a", "end_time": "b"}]}),
                encoding="utf-8",
            )

            diagnostics = _collect_local_session_artifacts(root, "session-1")

        self.assertTrue(diagnostics["pb_file_present"])
        self.assertEqual(diagnostics["brain_file_count"], 2)
        self.assertEqual(diagnostics["browser_recording_frame_count"], 2)
        self.assertEqual(diagnostics["browser_recording_highlight_count"], 1)

    def test_parse_chat_export_markdown_recovers_user_and_actions(self) -> None:
        content = """\x12\x04# Chat Conversation

Note: _This is purely the output of the chat conversation and does not contain any raw data._

### User Input

第一句
第二句

*Edited relevant file*

*User accepted the command `echo hi`*

### User Input

继续
"""

        messages = _parse_chat_export_markdown(content, "2026-04-06T00:00:00Z")

        self.assertEqual([msg["type"] for msg in messages], ["user", "system", "system", "user"])
        self.assertEqual(messages[0]["message"]["content"][0]["text"], "第一句\n第二句")
        self.assertEqual(messages[1]["message"]["content"], "Edited relevant file")
        self.assertEqual(messages[2]["message"]["content"], "User accepted the command `echo hi`")
        self.assertEqual(messages[3]["message"]["content"][0]["text"], "继续")

    def test_collect_chat_export_sessions_maps_session_from_brain_link(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active = root / "code_tracker" / "active" / "no_repo"
            active.mkdir(parents=True)
            export = active / "abc123_Optimizing Data Loading Speed.md"
            export.write_text(
                """# Chat Conversation

### User Input

我想快速的下载pubchem里的所有化合物

*Listed directory [pubchem](file:///Users/test/pubchem) *

*Viewed [task.md](file:///Users/test/.gemini/antigravity/brain/af376bab-c8a4-4173-92ef-80652a9b5677/task.md) *
""",
                encoding="utf-8",
            )

            sessions = _collect_chat_export_sessions(root)

        self.assertIn("af376bab-c8a4-4173-92ef-80652a9b5677", sessions)
        session = sessions["af376bab-c8a4-4173-92ef-80652a9b5677"]
        self.assertEqual(session["title"], "Optimizing Data Loading Speed")
        self.assertEqual(session["workspace"], "file:///Users/test/pubchem")
        self.assertEqual(session["project_name"], "pubchem")
        self.assertEqual(len(session["messages"]), 3)
        self.assertEqual(session["messages"][0]["type"], "user")


if __name__ == "__main__":
    unittest.main()
