"""Unit tests for Round 11 performance and architectural optimizations."""

import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import DeviceTask, User
from server.api.tasks import _serialize
from server.services import cache


class TestRound11Optimizations(unittest.IsolatedAsyncioTestCase):
    async def test_cache_delete_prefix_batching(self):
        """Verify cache_delete_prefix batches Redis DEL calls in chunks of 100."""
        # Generate 250 mock keys
        fake_keys = [f"test:key:{i}" for i in range(250)]

        async def fake_scan_iter(match, count):
            for k in fake_keys:
                yield k

        mock_redis = MagicMock()
        mock_redis.scan_iter = fake_scan_iter
        mock_redis.delete = AsyncMock()

        with patch("server.services.cache.redis_client", return_value=mock_redis):
            deleted = await cache.cache_delete_prefix("test:key:")
            self.assertEqual(deleted, 250)
            # Should have called delete 3 times: 100, 100, 50 keys
            self.assertEqual(mock_redis.delete.call_count, 3)
            first_call_keys = mock_redis.delete.call_args_list[0][0]
            second_call_keys = mock_redis.delete.call_args_list[1][0]
            third_call_keys = mock_redis.delete.call_args_list[2][0]
            self.assertEqual(len(first_call_keys), 100)
            self.assertEqual(len(second_call_keys), 100)
            self.assertEqual(len(third_call_keys), 50)

    def test_tasks_output_truncation(self):
        """Verify _serialize truncates stdout/stderr only when truncate_output=True."""
        large_text = "x" * 5000
        task = DeviceTask(
            id=uuid.uuid4(),
            device_id="dev-1",
            action="remote_exec",
            status="succeeded",
            stdout=large_text,
            stderr=large_text,
        )

        # Full serialization for detail endpoint
        full = _serialize(task, truncate_output=False)
        self.assertEqual(len(full["stdout"]), 5000)
        self.assertEqual(len(full["stderr"]), 5000)

        # Truncated serialization for list endpoint
        truncated = _serialize(task, truncate_output=True)
        self.assertLess(len(truncated["stdout"]), 2100)
        self.assertIn("...[truncated]...", truncated["stdout"])
        self.assertLess(len(truncated["stderr"]), 2100)
        self.assertIn("...[truncated]...", truncated["stderr"])

    async def test_skills_list_cache(self):
        """Verify list_skills utilizes Redis cache."""
        from server.api.skills import list_skills

        user = User(id=uuid.uuid4(), email="user@example.com")
        mock_db = AsyncMock()

        # Cache hit
        cached_data = {"drafts": [], "published": [], "archived": [], "counts": {}, "devices": []}
        with patch("server.api.skills.cache_get", new_callable=AsyncMock) as mock_get, \
             patch("server.api.skills.cache_set", new_callable=AsyncMock) as mock_set:
            mock_get.return_value = cached_data

            result = await list_skills(db=mock_db, user=user)
            self.assertEqual(result, cached_data)
            mock_get.assert_awaited_once_with(f"skills:list:{user.id}")
            mock_set.assert_not_called()
            mock_db.execute.assert_not_called()

    async def test_tools_list_cache(self):
        """Verify list_tools utilizes Redis cache."""
        from server.api.tools import list_tools

        user = User(id=uuid.uuid4(), role="user", email="user@example.com")
        mock_db = AsyncMock()

        cached_data = [{
            "id": "cursor",
            "display_name": "Cursor",
            "icon": None,
            "total_files": 10,
            "total_size_bytes": 1024,
            "last_sync_at": None,
        }]
        with patch("server.api.tools.cache_get", new_callable=AsyncMock) as mock_get, \
             patch("server.api.tools.cache_set", new_callable=AsyncMock) as mock_set:
            mock_get.return_value = cached_data

            result = await list_tools(device_id=None, db=mock_db, _user=user)
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0].id, "cursor")
            mock_get.assert_awaited_once_with(f"tools:list:{user.id}:all")
            mock_set.assert_not_called()
            mock_db.execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
