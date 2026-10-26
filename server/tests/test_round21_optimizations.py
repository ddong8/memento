from __future__ import annotations

import unittest
from unittest.mock import AsyncMock, MagicMock
import uuid
from server.db.models import DeviceTask, AskConversation, User
from server.api.ask_conversations import get_conversation


class TestRound21Optimizations(unittest.TestCase):
    def test_device_task_user_active_partial_index_defined(self):
        """Verify idx_device_tasks_user_active partial index is defined on DeviceTask table."""
        index_names = {idx.name for idx in DeviceTask.__table__.indexes}
        self.assertIn("idx_device_tasks_user_active", index_names)
        target = next(idx for idx in DeviceTask.__table__.indexes if idx.name == "idx_device_tasks_user_active")
        self.assertIsNotNone(target.dialect_options.get("postgresql", {}).get("where"))

    async def _test_get_conversation_304_fast_path(self):
        conv_id = uuid.uuid4()
        user_id = uuid.uuid4()
        mock_user = MagicMock(spec=User)
        mock_user.id = user_id

        # Mock conversation with deferred turns
        mock_conv = MagicMock(spec=AskConversation)
        mock_conv.id = conv_id
        mock_conv.user_id = user_id
        mock_conv.message_count = 5
        mock_conv.updated_at = None
        mock_conv.created_at = None
        mock_conv.config = {"device_id": "test-device"}
        mock_conv.device_id = "test-device"

        import hashlib
        seed = f"v4:{conv_id}::5:0:test-device"
        tag = f'"{hashlib.sha1(seed.encode("utf-8")).hexdigest()}"'

        mock_request = MagicMock()
        mock_request.headers.get.return_value = tag

        mock_response = MagicMock()
        mock_db = AsyncMock()
        mock_scalars = MagicMock()
        mock_scalars.first.return_value = mock_conv
        mock_db_res = MagicMock()
        mock_db_res.scalars.return_value = mock_scalars
        mock_db.execute.return_value = mock_db_res

        res = await get_conversation(
            conv_id=str(conv_id),
            request=mock_request,
            response=mock_response,
            limit=0,
            db=mock_db,
            _user=mock_user,
        )

        # Confirm 304 response was returned immediately
        self.assertEqual(res.status_code, 304)
        self.assertEqual(res.headers.get("ETag"), tag)
        # Confirm db.refresh was NOT called because turns were not loaded
        mock_db.refresh.assert_not_called()

    def test_get_conversation_304_fast_path(self):
        import asyncio
        asyncio.run(self._test_get_conversation_304_fast_path())
