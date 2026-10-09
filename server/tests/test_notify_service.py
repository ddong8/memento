import unittest
from unittest.mock import AsyncMock, patch
import uuid
import time

from server.services.notify_service import (
    _is_duplicate_push,
    _recent_pushes,
    notify_user,
)


class NotifyServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _recent_pushes.clear()

    def test_deduplication_sliding_window(self):
        uid = str(uuid.uuid4())
        title = "测试标题"
        body = "测试内容"

        # First call should succeed (not a duplicate)
        self.assertFalse(_is_duplicate_push(uid, title, body))

        # Immediate second call with identical content should be detected as duplicate
        self.assertTrue(_is_duplicate_push(uid, title, body))

        # Different title or body should not be treated as duplicate
        self.assertFalse(_is_duplicate_push(uid, "不同标题", body))
        self.assertFalse(_is_duplicate_push(uid, title, "不同内容"))

        # Different user should not be treated as duplicate
        self.assertFalse(_is_duplicate_push(str(uuid.uuid4()), title, body))

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
