"""Unit tests for Round 15 deep system optimizations."""

import unittest
import uuid
from unittest.mock import AsyncMock, patch

from server.db.models import Document, User
from server.tasks.learning_tasks import _run


class TestRound15Optimizations(unittest.IsolatedAsyncioTestCase):
    def test_document_composite_index(self):
        """Verify idx_documents_machine_synced index exists on Document table."""
        index_names = {idx.name for idx in Document.__table__.indexes}
        self.assertIn("idx_documents_machine_synced", index_names)

        target_idx = next(idx for idx in Document.__table__.indexes if idx.name == "idx_documents_machine_synced")
        col_names = [col.name for col in target_idx.columns]
        self.assertIn("machine_id", col_names)
        self.assertIn("synced_at", col_names)

    @patch("server.tasks.learning_tasks.notify_user", new_callable=AsyncMock)
    @patch("server.tasks.learning_tasks.learn_from_corrections", new_callable=AsyncMock)
    @patch("server.tasks.learning_tasks.async_session_factory")
    async def test_learning_tasks_per_user_session_scoping(
        self, mock_session_factory, mock_learn_corrections, mock_notify
    ):
        """Verify _run creates a distinct session per user instead of holding a single session across all users."""
        user1 = User(id=uuid.uuid4(), email="u1@test.com", status="active")
        user2 = User(id=uuid.uuid4(), email="u2@test.com", status="active")

        # Mock sessions
        sessions = [AsyncMock(), AsyncMock(), AsyncMock()]
        session_idx = 0

        def get_mock_session():
            nonlocal session_idx
            s = sessions[session_idx]
            session_idx += 1
            cm = AsyncMock()
            cm.__aenter__.return_value = s
            cm.__aexit__.return_value = None
            return cm

        mock_session_factory.side_effect = get_mock_session

        # First session loads users
        from unittest.mock import MagicMock
        mock_res = MagicMock()
        mock_res.scalars.return_value.all.return_value = [user1, user2]
        sessions[0].execute.return_value = mock_res

        mock_learn_corrections.return_value = {"events": 1, "new_topics": [], "auto_accepted": [], "backfill": False}

        result = await _run()
        self.assertEqual(result["events"], 2)
        # Ensure session factory was called 3 times: 1 to fetch users, and 1 for each of the 2 users
        self.assertEqual(mock_session_factory.call_count, 3)
