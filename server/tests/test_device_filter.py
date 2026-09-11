from __future__ import annotations

import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.db.models import Machine, User  # noqa: E402
from server.services.user_filter import find_machine_by_id_or_hash  # noqa: E402


class DeviceFilterTests(unittest.IsolatedAsyncioTestCase):
    async def test_find_machine_ignored_values(self) -> None:
        db = AsyncMock()
        for ignored in (None, "", "auto", "ask_only", "all"):
            m = await find_machine_by_id_or_hash(db, ignored)
            self.assertIsNone(m)
            db.execute.assert_not_called()

    async def test_find_machine_by_token_hash_or_name(self) -> None:
        db = AsyncMock()
        fake_machine = Machine(
            id=uuid.uuid4(),
            name="Mac mini",
            collector_token_hash="hash_123456",
        )
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = fake_machine
        db.execute.return_value = mock_result

        user = User(id=uuid.uuid4(), email="alice@example.com", role="user")
        m = await find_machine_by_id_or_hash(db, "hash_123456", user)
        self.assertIsNotNone(m)
        self.assertEqual(m.name, "Mac mini")
        self.assertEqual(m.collector_token_hash, "hash_123456")

    async def test_find_machine_by_uuid_fallback(self) -> None:
        db = AsyncMock()
        target_id = uuid.uuid4()
        fake_machine = Machine(
            id=target_id,
            name="Workstation",
            collector_token_hash="token_xyz",
        )

        first_res = MagicMock()
        first_res.scalars.return_value.first.return_value = None
        second_res = MagicMock()
        second_res.scalars.return_value.first.return_value = fake_machine
        db.execute.side_effect = [first_res, second_res]

        m = await find_machine_by_id_or_hash(db, str(target_id))
        self.assertIsNotNone(m)
        self.assertEqual(m.id, target_id)
        self.assertEqual(db.execute.call_count, 2)


if __name__ == "__main__":
    unittest.main()
