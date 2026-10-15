"""Unit tests for Round 12 performance and architectural optimizations."""

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import Machine, User
from server.api.daily import get_daily
from server.api.devices import delete_device, purge_device


class TestRound12Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_get_daily_single_pass_aggregation(self):
        """Verify get_daily groups document info and message counts in a single query."""
        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        doc_id = uuid.uuid4()
        mock_db = AsyncMock()

        # Mock result for the single grouped SQL query
        mock_msg_row_user = (doc_id, "claude_code", "My Conversation", "conv.jsonl", "jsonl", "user", 5)
        mock_msg_row_assistant = (doc_id, "claude_code", "My Conversation", "conv.jsonl", "jsonl", "assistant", 4)
        mock_msg_result = MagicMock()
        mock_msg_result.all.return_value = [mock_msg_row_user, mock_msg_row_assistant]

        # Mock result for summary query (empty)
        mock_summary_result = MagicMock()
        mock_summary_result.scalars.return_value.all.return_value = []

        mock_db.execute.side_effect = [mock_msg_result, mock_summary_result]

        with patch("server.api.daily.user_machine_ids", new_callable=AsyncMock, return_value=[uuid.uuid4()]), \
             patch("server.api.daily.cache_get", new_callable=AsyncMock, return_value=None), \
             patch("server.api.daily.cache_set", new_callable=AsyncMock) as mock_cache_set:

            res = await get_daily("2026-10-15", tz_offset=0, db=mock_db, _user=user)

            self.assertEqual(res["date"], "2026-10-15")
            self.assertEqual(res["total_messages"], 9)
            convs = res["overview"]["conversations"]
            self.assertEqual(len(convs), 1)
            self.assertEqual(convs[0]["id"], str(doc_id))
            self.assertEqual(convs[0]["tool_id"], "claude_code")
            self.assertEqual(convs[0]["user_messages"], 5)
            self.assertEqual(convs[0]["assistant_messages"], 4)
            self.assertEqual(res["overview"]["tool_stats"]["claude_code"], 9)

            # DB execute was called exactly 2 times (1 for grouped messages, 1 for summaries) instead of 3
            self.assertEqual(mock_db.execute.call_count, 2)
            mock_cache_set.assert_awaited_once()

    async def test_device_deletion_cache_invalidation(self):
        """Verify delete_device and purge_device invalidate all relevant caches."""
        user = User(id=uuid.uuid4(), role="user", email="user@example.com")
        dev_id = uuid.uuid4()
        machine = Machine(id=dev_id, user_id=user.id, name="MacBook Pro")

        mock_db = AsyncMock()

        with patch("server.api.devices._verify_device_ownership", new_callable=AsyncMock, return_value=machine), \
             patch("server.api.devices._purge_device_data", new_callable=AsyncMock, return_value={"documents_deleted": 10}), \
             patch("server.api.devices.cache_delete_prefix", new_callable=AsyncMock) as mock_cache_del:

            # Test delete_device
            del_res = await delete_device(dev_id, db=mock_db, _user=user)
            self.assertEqual(del_res["status"], "deleted")
            deleted_prefixes = [call[0][0] for call in mock_cache_del.call_args_list]
            self.assertIn(f"devices:stats:{user.id}", deleted_prefixes)
            self.assertIn(f"hierarchy:devices:{user.id}", deleted_prefixes)
            self.assertIn(f"dashboard:{user.id}", deleted_prefixes)
            self.assertIn(f"tools:list:{user.id}", deleted_prefixes)
            self.assertIn(f"projects:list:{user.id}", deleted_prefixes)

            mock_cache_del.reset_mock()

            # Test purge_device
            purge_res = await purge_device(dev_id, db=mock_db, _user=user)
            self.assertEqual(purge_res["status"], "purged")
            purged_prefixes = [call[0][0] for call in mock_cache_del.call_args_list]
            self.assertIn(f"devices:stats:{user.id}", purged_prefixes)
            self.assertIn(f"hierarchy:devices:{user.id}", purged_prefixes)
            self.assertIn(f"dashboard:{user.id}", purged_prefixes)
            self.assertIn(f"tools:list:{user.id}", purged_prefixes)
            self.assertIn(f"projects:list:{user.id}", purged_prefixes)


if __name__ == "__main__":
    unittest.main()
