"""Unit tests for Round 13 performance and architectural optimizations."""

import unittest
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import AgentMission, CorrectionTopic, Machine, User, UserProfile
from server.api.learning import check, list_corrections, accept, dismiss, AcceptBody
from server.api.profile import get_profile, save_draft, publish, set_device_targets, report_injection, ProfileContent, PublishBody, TargetsBody, InjectionReport
from server.api.missions import list_missions


class TestRound13Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_list_corrections_caching_and_window_query(self):
        """Verify list_corrections queries top 3 events via DB window function and caches results."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        topic_id = uuid.uuid4()
        now = datetime.now(timezone.utc)
        topic = CorrectionTopic(
            id=topic_id,
            user_id=user.id,
            statement="始终用中文回复",
            category="communication",
            scope="global",
            status="pending",
            times=3,
            first_at=now,
            last_at=now,
        )

        mock_db = AsyncMock()
        mock_topic_res = MagicMock()
        mock_topic_res.scalars.return_value.all.return_value = [topic]

        # Top 3 events returned by window function query
        mock_event_res = MagicMock()
        mock_event_res.all.return_value = [
            (topic_id, "请用中文", now),
            (topic_id, "说中文", now),
        ]

        mock_db.execute.side_effect = [mock_topic_res, mock_event_res]

        with patch("server.api.learning.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.learning.cache_set", new_callable=AsyncMock) as mock_cache_set, \
             patch("server.api.learning.correction_stats", new_callable=AsyncMock, return_value={"total": 1}):

            res = await list_corrections(db=mock_db, user=user)
            self.assertEqual(len(res["pending"]), 1)
            self.assertEqual(res["pending"][0]["id"], str(topic_id))
            self.assertEqual(len(res["pending"][0]["quotes"]), 2)
            self.assertEqual(res["pending"][0]["quotes"][0]["text"], "请用中文")

            # Check that cache_set was called with expected key and 30s ttl
            mock_cache_set.assert_awaited_once()
            cache_key = mock_cache_set.call_args[0][0]
            self.assertEqual(cache_key, f"learning:corrections:{user.id}")
            self.assertEqual(mock_cache_set.call_args[1]["ttl_seconds"], 30)

        # Second call with cached data should skip DB execution
        with patch("server.api.learning.cache_get", new_callable=AsyncMock, return_value=res) as mock_cache_get_hit:
            hit_res = await list_corrections(db=mock_db, user=user)
            self.assertEqual(hit_res, res)
            mock_cache_get_hit.assert_awaited_once_with(f"learning:corrections:{user.id}")

    async def test_learning_check_caching(self):
        """Verify /api/learning/check caches guidance results."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        mock_db = AsyncMock()

        dummy_guidance = {"rules": ["rule 1"], "pitfalls": []}

        with patch("server.api.learning.guidance_for", new_callable=AsyncMock, return_value=dummy_guidance) as mock_guidance, \
             patch("server.api.learning.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.learning.cache_set", new_callable=AsyncMock) as mock_cache_set:

            res = await check(
                action="test_action",
                project="test_proj",
                query="test_query",
                format="json",
                db=mock_db,
                user=user,
            )
            self.assertEqual(res, dummy_guidance)
            mock_guidance.assert_awaited_once_with(mock_db, user, "test_action", "test_proj", "test_query")
            mock_cache_set.assert_awaited_once()
            self.assertIn(f"learning:check:{user.id}:test_action:test_proj:test_query:json", mock_cache_set.call_args[0][0])

    async def test_learning_mutations_cache_invalidation(self):
        """Verify accept and dismiss bust learning caches."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        topic_id = uuid.uuid4()
        topic = CorrectionTopic(
            id=topic_id,
            user_id=user.id,
            statement="测试",
            category="rule",
            status="pending",
            times=1,
            memory_id=None,
        )

        mock_db = AsyncMock()

        with patch("server.api.learning._own_topic", new_callable=AsyncMock, return_value=topic), \
             patch("server.api.learning.accept_topic", new_callable=AsyncMock, return_value=topic), \
             patch("server.api.learning.cache_delete_prefix", new_callable=AsyncMock) as mock_del_prefix:

            await accept(str(topic_id), AcceptBody(), db=mock_db, user=user)
            deleted_prefixes = [call[0][0] for call in mock_del_prefix.call_args_list]
            self.assertIn(f"learning:corrections:{user.id}", deleted_prefixes)
            self.assertIn(f"learning:check:{user.id}", deleted_prefixes)

            mock_del_prefix.reset_mock()
            await dismiss(str(topic_id), db=mock_db, user=user)
            dismiss_prefixes = [call[0][0] for call in mock_del_prefix.call_args_list]
            self.assertIn(f"learning:corrections:{user.id}", dismiss_prefixes)
            self.assertIn(f"learning:check:{user.id}", dismiss_prefixes)

    async def test_profile_caching_and_invalidation(self):
        """Verify get_profile caches payload and mutations invalidate it."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        mock_db = AsyncMock()
        mock_db.add = MagicMock()

        mock_history = MagicMock()
        mock_history.all.return_value = []
        mock_machines = MagicMock()
        mock_machines.scalars.return_value.all.return_value = []
        mock_db.execute.side_effect = [mock_history, mock_machines]

        with patch("server.api.profile.get_published_profile", new_callable=AsyncMock, return_value=None), \
             patch("server.api.profile.get_draft_profile", new_callable=AsyncMock, return_value=None), \
             patch("server.api.profile.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.profile.cache_set", new_callable=AsyncMock) as mock_cache_set, \
             patch("server.api.profile._bust_user_profile_cache", new_callable=AsyncMock) as mock_bust:

            res = await get_profile(db=mock_db, user=user)
            self.assertIn("published", res)
            self.assertIn("devices", res)
            mock_cache_set.assert_awaited_once_with(f"profile:summary:{user.id}", res, ttl_seconds=30)

            # Test save_draft invalidation
            await save_draft(ProfileContent(content="new content"), db=mock_db, user=user)
            mock_bust.assert_awaited_with(user.id)

            # Test publish invalidation
            mock_bust.reset_mock()
            with patch("server.api.profile.publish_profile", new_callable=AsyncMock, return_value=UserProfile(user_id=user.id, version=1, content="published")):
                await publish(PublishBody(content="published"), db=mock_db, user=user)
                mock_bust.assert_awaited_with(user.id)

            # Test set_device_targets invalidation
            mock_bust.reset_mock()
            mock_machine = Machine(id=uuid.uuid4(), user_id=user.id, collector_token_hash="hash")
            with patch("server.api.profile._owned_machine", new_callable=AsyncMock, return_value=mock_machine):
                await set_device_targets("hash", TargetsBody(targets=["claude_code"]), db=mock_db, user=user)
                mock_bust.assert_awaited_with(user.id)

            # Test report_injection invalidation
            mock_bust.reset_mock()
            with patch("server.api.profile._owned_machine", new_callable=AsyncMock, return_value=mock_machine):
                await report_injection(
                    InjectionReport(version=1, results={"cursor": "ok"}),
                    x_device_id="hash",
                    db=mock_db,
                    user=user,
                )
                mock_bust.assert_awaited_with(user.id)

    async def test_list_missions_defer_context(self):
        """Verify list_missions query includes defer(AgentMission.context)."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        mock_db = AsyncMock()
        mock_res = MagicMock()
        mock_res.scalars.return_value.all.return_value = []
        mock_db.execute.return_value = mock_res

        res = await list_missions(limit=10, db=mock_db, user=user)
        self.assertEqual(res, [])
        mock_db.execute.assert_awaited_once()

        # Inspect the SQL statement passed to db.execute
        query = mock_db.execute.call_args[0][0]
        # Check that defer option is present in query._with_options
        self.assertIn("AgentMission.context", str(query._with_options[0].context[0].path))


if __name__ == "__main__":
    unittest.main()
