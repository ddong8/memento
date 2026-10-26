import unittest
from unittest.mock import AsyncMock, patch
import uuid

import fakeredis

from server.services import notify_service
from server.services.notify_service import (
    _is_duplicate_push,
    _recent_pushes,
    notify_user,
)


class NotifyServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _recent_pushes.clear()
        # Without Redis: this process's own window
        self.no_redis = patch.object(notify_service, "redis_client", return_value=None)
        self.no_redis.start()

    def tearDown(self):
        self.no_redis.stop()

    async def _check_window(self):
        uid = str(uuid.uuid4())
        title = "测试标题"
        body = "测试内容"

        # First call should succeed (not a duplicate)
        self.assertFalse(await _is_duplicate_push(uid, title, body))

        # Immediate second call with identical content should be detected as duplicate
        self.assertTrue(await _is_duplicate_push(uid, title, body))

        # Different title or body should not be treated as duplicate
        self.assertFalse(await _is_duplicate_push(uid, "不同标题", body))
        self.assertFalse(await _is_duplicate_push(uid, title, "不同内容"))

        # Different user should not be treated as duplicate
        self.assertFalse(await _is_duplicate_push(str(uuid.uuid4()), title, body))

        # Same task summary with different device name prefix or alert count suffix should be deduplicated
        self.assertFalse(await _is_duplicate_push(uid, "✅ 任务完成", "haixingdeMac-mini：修复3D动画卡顿"))
        self.assertTrue(await _is_duplicate_push(uid, "✅ 任务完成", "memento-65b88d53c382f-8eb4ed13：修复3D动画卡顿"))
        self.assertTrue(await _is_duplicate_push(uid, "✅ 任务完成", "haixingdeMac-mini：修复3D动画卡顿（期间 2 次危险操作）"))

    async def test_deduplication_sliding_window(self):
        await self._check_window()

    async def test_deduplication_is_shared_by_replicas_through_redis(self):
        # The ask run's push and the device's push for one task, raised on two replicas
        shared = fakeredis.FakeAsyncRedis(server=fakeredis.FakeServer(), decode_responses=True)
        with patch.object(notify_service, "redis_client", return_value=shared):
            await self._check_window()
            self.assertEqual(_recent_pushes, {})  # decided in Redis, not here

    @patch("server.services.notify_service.send_apns_push", new_callable=AsyncMock)
    @patch("server.services.notify_service.send_expo_push", new_callable=AsyncMock)
    @patch("server.services.notify_service.async_session_factory")
    async def test_notify_user_channel_isolation(self, mock_db_factory, mock_expo, mock_apns):
        mock_apns.return_value = True
        mock_expo.return_value = True

        mock_user = unittest.mock.MagicMock()
        # User has both real APNs token and legacy/expo tokens
        mock_user.notify_settings = {
            "notify_task_done": True,
            "device_tokens": [
                "29f0ec5c728a49d979dddb4c727e5287c25244cbe475914713add62271a113e7",
                "ExponentPushToken[xxxx]",
                "ios_memento_dummy",
            ],
            "recent_notifications": [],
        }

        mock_session = AsyncMock()
        mock_result = unittest.mock.MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_user
        mock_session.execute.return_value = mock_result
        mock_db_factory.return_value.__aenter__.return_value = mock_session

        uid = uuid.uuid4()
        res = await notify_user(uid, "task_done", "任务完成", "内容详情")
        self.assertTrue(res)

        # APNs push should be called with only the valid hex APNs token
        mock_apns.assert_called_once()
        called_tokens = mock_apns.call_args[0][0]
        self.assertEqual(called_tokens, ["29f0ec5c728a49d979dddb4c727e5287c25244cbe475914713add62271a113e7"])

        # Expo push should NOT be called because native APNs is prioritized for the device
        mock_expo.assert_not_called()

    @patch("server.services.notify_service.send_apns_push", new_callable=AsyncMock)
    @patch("server.services.notify_service.async_session_factory")
    async def test_notify_user_pushes_to_open_clients(self, mock_db_factory, _apns):
        """The desktop and web show it from /api/events/stream at once; the feed poll only backs that up."""
        mock_user = unittest.mock.MagicMock()
        mock_user.notify_settings = {"notify_task_done": True, "recent_notifications": []}
        mock_session = AsyncMock()
        mock_result = unittest.mock.MagicMock()
        mock_result.scalar_one_or_none.return_value = mock_user
        mock_session.execute.return_value = mock_result
        mock_db_factory.return_value.__aenter__.return_value = mock_session

        uid = uuid.uuid4()
        with patch("server.services.sse_service.publish_event") as pub:
            await notify_user(uid, "task_done", "✅ 任务完成", "mac：推送通知", url="/ask?id=1")
        pub.assert_called_once()
        (etype, item), kw = pub.call_args
        self.assertEqual(etype, "notification")
        self.assertEqual(kw["user_id"], str(uid))
        self.assertEqual((item["title"], item["body"], item["url"]), ("✅ 任务完成", "mac：推送通知", "/ask?id=1"))
        # The same item the feed returns, so clients dedupe the two by id
        self.assertEqual(mock_user.notify_settings["recent_notifications"][0]["id"], item["id"])
