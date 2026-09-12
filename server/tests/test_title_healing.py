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
            "rollout-2026-09-08T23-50-06-01a081b6-5805-79e3-8900-9b010a4ce54d",
            "rollout-2026-09-08T11-01-49-01a07ef6-f778-7b01-87c2-84b8617b1dc4",
        ):
            self.assertTrue(_is_junk_or_uuid_title(t), t)

    def test_compaction_and_guardian_preamble_are_junk(self):
        self.assertTrue(_is_junk_or_uuid_title(
            "This session is being continued from a previous conversation. "
            "Analysis: the user asked..."))
        self.assertTrue(_is_junk_or_uuid_title(
            "The following is the Codex agent history whose request action you are assessing."))
        self.assertTrue(_is_junk_or_uuid_title(
            "<recommended_plugins>\nHere is a list of plugins..."))

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

    def test_scans_past_codex_recommended_plugins(self):
        self.assertEqual(
            _title_from_user_messages([
                "<recommended_plugins>\nHere is a list of plugins...",
                "帮我分析一下我这三个vps选择的代理协议是不是最优的",
            ]),
            "帮我分析一下我这三个vps选择的代理协议是不是最优的",
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

    def test_extracts_parent_sid_from_codex_guardian(self):
        content = (
            '{"type":"session_meta"}\n'
            'Reviewed Codex session id: 01a07ef6-f778-7b01-87c2-84b8617b1dc4\n'
            'The Codex agent has requested the following action:'
        )
        self.assertEqual(
            _parent_session_id_from_content(content),
            "01a07ef6-f778-7b01-87c2-84b8617b1dc4",
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


class ConversationPatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_conversation_cascades_to_subagents(self):
        import uuid
        from unittest.mock import AsyncMock, MagicMock, patch
        from server.api.conversations import ConversationUpdate, update_conversation
        from server.db.models import Document, User

        doc_id = uuid.uuid4()
        proj_id = uuid.uuid4()
        user_id = uuid.uuid4()

        user = User(id=user_id, email="tester@example.com")
        doc = Document(
            id=doc_id,
            project_id=proj_id,
            title="Old Prompt Title",
            relative_path="projects/test-proj/session-123.jsonl",
            tool_id="claude_code",
            category="conversation",
            content_type="jsonl",
        )

        db = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = doc
        db.execute.return_value = mock_result

        with patch("server.api.conversations.user_machine_ids", return_value=None), \
             patch("server.services.cache.cache_delete_prefix", new_callable=AsyncMock) as mock_cache_del:
            payload = ConversationUpdate(title="新会话标题")
            res = await update_conversation(doc_id, payload, db=db, _user=user)

            self.assertEqual(res["status"], "ok")
            self.assertEqual(res["title"], "新会话标题")
            self.assertEqual(doc.title, "新会话标题")
            db.commit.assert_awaited_once()
            mock_cache_del.assert_awaited_once_with(f"project:conv:{user_id}:{proj_id}:")


if __name__ == "__main__":
    unittest.main()

