"""Unit tests for Round 18: Dreaming morning briefing and Ask RAG Redis caching optimizations."""

import unittest
import uuid
from unittest.mock import AsyncMock, patch
from server.tasks.dreaming_tasks import _run_all_users_dreaming


class TestRound18Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_dreaming_morning_briefing_notification(self):
        """Verify that when promoted > 0 in dreaming, notify_user is called with briefing."""
        user_id = uuid.uuid4()
        fake_user = unittest.mock.MagicMock()
        fake_user.id = user_id

        fake_session = AsyncMock()
        mock_result = unittest.mock.MagicMock()
        mock_result.scalars.return_value.all.return_value = [fake_user]
        fake_session.execute.return_value = mock_result

        with patch("server.tasks.dreaming_tasks.async_session_factory") as mock_sf, \
             patch("server.tasks.dreaming_tasks.run_dreaming_pipeline", new_callable=AsyncMock) as mock_dreaming, \
             patch("server.tasks.dreaming_tasks.build_profile_draft", new_callable=AsyncMock), \
             patch("server.services.ai_health.put_json", new_callable=AsyncMock), \
             patch("server.tasks.dreaming_tasks._alert_bad_night", new_callable=AsyncMock), \
             patch("server.tasks.dreaming_tasks.notify_user", new_callable=AsyncMock) as mock_notify:

            fake_journal = unittest.mock.MagicMock()
            fake_journal.stage_metrics = {"promoted_count": 3}
            mock_sf.return_value.__aenter__.return_value = fake_session
            mock_dreaming.return_value = fake_journal

            res = await _run_all_users_dreaming(days_back=1)

            self.assertEqual(res["processed"], 1)
            self.assertEqual(res["errors"], 0)
            mock_notify.assert_awaited_once()
            call_args = mock_notify.await_args[0]
            self.assertEqual(call_args[0], user_id)
            self.assertEqual(call_args[1], "briefing")
            self.assertIn("心智晨报", call_args[2])
            self.assertIn("3 条高价值业务记忆", call_args[3])

    async def test_ask_cache_hit_emits_cached_delta_and_done(self):
        """Verify that ask stream returns cached response and avoids LLM call when cache hits."""
        from server.api.ask import ask, AskRequest
        from server.db.models import User

        user = User(id=uuid.uuid4(), email="test@memento.local", name="tester", status="active")
        req = AskRequest(question="你好，这是测试问题吗？", model="test-model")

        cached_payload = {
            "text": "这是来自短时语义缓存的答复。",
            "thinking": "思考过程缓存",
        }

        fake_db = AsyncMock()
        cm = unittest.mock.MagicMock()
        cm.__aenter__.return_value = fake_db

        with patch("server.api.ask.get_or_create_conversation", new_callable=AsyncMock) as mock_get_conv, \
             patch("server.api.ask.retrieve", new_callable=AsyncMock) as mock_ret, \
             patch("server.api.ask.retrieve_core_memories", new_callable=AsyncMock) as mock_core, \
             patch("server.api.ask.get_ai_providers", return_value=[{"name": "test"}]), \
             patch("server.services.profile_service.get_published_profile", new_callable=AsyncMock) as mock_prof, \
             patch("server.api.ask.stream_chat_completion", new_callable=AsyncMock) as mock_stream_llm, \
             patch("server.services.ai_health.get_json", new_callable=AsyncMock) as mock_get_cache, \
             patch("server.api.ask.append_conversation_turns", new_callable=AsyncMock), \
             patch("server.services.ask_runs.async_session_factory", return_value=cm):

            mock_get_conv.return_value = (uuid.uuid4(), "测试会话", {})
            mock_ret.return_value = [{"title": "测试文档", "tool_id": "notes", "relative_path": "test.md", "excerpt": "参考资料1"}]
            mock_core.return_value = []
            mock_prof.return_value = None
            mock_get_cache.return_value = cached_payload

            resp = await ask(req, db=fake_db, _user=user)
            self.assertIsNotNone(resp)

            frames = []
            async for chunk in resp.body_iterator:
                frames.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)

            full_sse = "".join(frames)
            self.assertIn("这是来自短时语义缓存的答复。", full_sse)
            self.assertIn("思考过程缓存", full_sse)
            # Ensure upstream LLM was never called
            mock_stream_llm.assert_not_called()
