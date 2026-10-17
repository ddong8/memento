"""Route order under /api/ask/conversations: fixed paths must win over {conv_id}."""

from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from fastapi.testclient import TestClient  # noqa: E402

from server.api import ask_conversations  # noqa: E402
from server.main import app  # noqa: E402
from server.middleware.auth import get_current_user  # noqa: E402
from server.services.ask_runs import ask_runs  # noqa: E402


class RecentActiveRouteTests(unittest.TestCase):
    def test_recent_active_is_not_taken_for_a_conversation_id(self) -> None:
        # It used to be registered after /conversations/{conv_id}, which answered
        # every startup restore with 400 "Invalid conversation ID".
        session = AsyncMock()
        session.execute.return_value = MagicMock(scalars=MagicMock(return_value=MagicMock(first=MagicMock(return_value=None))))
        cm = MagicMock()
        cm.__aenter__.return_value = session
        app.dependency_overrides[get_current_user] = lambda: MagicMock(id=uuid.uuid4())
        try:
            with patch.object(ask_conversations, "async_session_factory", MagicMock(return_value=cm)), \
                 patch.object(ask_runs, "active_for_user", return_value=[]):
                r = TestClient(app).get("/api/ask/conversations/recent-active")
        finally:
            app.dependency_overrides.pop(get_current_user, None)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {"id": None})


if __name__ == "__main__":
    unittest.main()
