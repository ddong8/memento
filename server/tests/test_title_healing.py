from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.ingest_service import (
    _extract_latest_ai_title,
    _is_junk_or_uuid_title,
    _parent_session_id_from_content,
    _title_from_user_messages,
)


class JunkTitleTests(unittest.TestCase):
    def test_worker_id_titles_are_junk(self):
        for t in (
            "agent-ae793afb0f284c8bb",
            "agent-acompact-48a1046426ab0b97",
            "subagent-1234",
            "wf_abcdef",
            "workflow-xyz",
        ):
            self.assertTrue(_is_junk_or_uuid_title(t), t)

    def test_compaction_preamble_is_junk(self):
        self.assertTrue(_is_junk_or_uuid_title(
            "This session is being continued from a previous conversation. "
            "Analysis: the user asked..."))

    def test_uuid_and_bare_session_id_are_junk(self):
        sid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
        self.assertTrue(_is_junk_or_uuid_title(sid))
        self.assertTrue(_is_junk_or_uuid_title("a1b2c3d4", session_id="a1b2c3d4-xxxx"))

    def test_regex_artifact_titles_are_junk(self):
        for t in (r're.search(r"\d+", text)', r"match \d{4}", r"grab \w+ here"):
            self.assertTrue(_is_junk_or_uuid_title(t), t)

    def test_real_titles_are_kept(self):
        for t in (
            "修复登录 bug",
            "ims系统还是报错啊",
            # format string with \t — a real prompt, must NOT read as regex junk
            'Run `docker compose ps --format "{{.Service}}\t{{.Status}}"`',
            "Implement per-user data isolation for browse endpoints",
        ):
            self.assertFalse(_is_junk_or_uuid_title(t), t)


class TitleFromUserMessagesTests(unittest.TestCase):
    def test_picks_first_real_message(self):
        self.assertEqual(
            _title_from_user_messages(["修复登录问题", "后续追问"]),
            "修复登录问题",
        )

    def test_scans_past_compaction_preamble(self):
        # The real prompt is the SECOND message; the first is boilerplate.
        self.assertEqual(
            _title_from_user_messages([
                "This session is being continued from a previous conversation...",
                "继续开发时间线功能",
            ]),
            "继续开发时间线功能",
        )

    def test_returns_none_when_nothing_usable(self):
        self.assertIsNone(_title_from_user_messages([None, "", "agent-xxxx"]))

    def test_truncates_to_60_chars(self):
        long = "x" * 200
        self.assertEqual(len(_title_from_user_messages([long])), 60)


class ParentSessionExtractionTests(unittest.TestCase):
    def test_extracts_parent_sid_from_sidechain(self):
        content = (
            '{"type":"user","isSidechain":true,"sessionId":"914b83f9-244a-42d2-a8a7-064b2da6cdc5"}\n'
            '{"type":"assistant","isSidechain":true,"sessionId":"914b83f9-244a-42d2-a8a7-064b2da6cdc5"}'
        )
        self.assertEqual(
            _parent_session_id_from_content(content),
            "914b83f9-244a-42d2-a8a7-064b2da6cdc5",
        )

    def test_none_for_non_sidechain(self):
        content = '{"type":"user","sessionId":"aa549791-3f81-4e86-abcd-ef1234567890"}'
        self.assertIsNone(_parent_session_id_from_content(content))

    def test_none_when_sidechain_false(self):
        content = '{"type":"user","isSidechain":false,"sessionId":"aa549791-3f81-4e86-abcd-ef1234567890"}'
        self.assertIsNone(_parent_session_id_from_content(content))

    def test_none_for_empty(self):
        self.assertIsNone(_parent_session_id_from_content(None))
        self.assertIsNone(_parent_session_id_from_content(""))


class ExtractLatestAiTitleTests(unittest.TestCase):
    def test_extracts_single_ai_title(self):
        content = '{"type":"ai-title","aiTitle":"构建PubChem化合物相似性搜索平台","sessionId":"sid-1"}'
        self.assertEqual(_extract_latest_ai_title(content), "构建PubChem化合物相似性搜索平台")

    def test_extracts_latest_when_multiple_ai_titles_exist(self):
        content = (
            '{"type":"ai-title","aiTitle":"Research how to obtain and use PubChem public data for a com","sessionId":"sid-1"}\n'
            '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"构建平台"}]}}\n'
            '{"type":"ai-title","aiTitle":"构建PubChem化合物相似性搜索平台","sessionId":"sid-1"}\n'
        )
        self.assertEqual(_extract_latest_ai_title(content), "构建PubChem化合物相似性搜索平台")

    def test_returns_none_when_no_ai_title(self):
        content = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}'
        self.assertIsNone(_extract_latest_ai_title(content))
        self.assertIsNone(_extract_latest_ai_title(None))
        self.assertIsNone(_extract_latest_ai_title(""))


if __name__ == "__main__":
    unittest.main()
