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


    async def test_find_machine_platform_suffix(self) -> None:
        db = AsyncMock()
        fake_machine = Machine(
            id=uuid.uuid4(),
            name="donghaixingdeMacBook-Pro.local (Darwin)",
            collector_token_hash="hash_macbook",
        )
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = fake_machine
        db.execute.return_value = mock_result

        # Search with stripped name
        m = await find_machine_by_id_or_hash(db, "donghaixingdeMacBook-Pro.local")
        self.assertIsNotNone(m)
        self.assertEqual(m.name, "donghaixingdeMacBook-Pro.local (Darwin)")

        # Verify query was constructed with candidate matching
        self.assertEqual(db.execute.call_count, 1)

    async def test_device_unbind_keep_data_preserves_records(self) -> None:
        from unittest.mock import patch
        from server.api.devices import delete_device, archive_device, unarchive_device

        user = User(id=uuid.uuid4(), email="user@example.com", role="user")
        dev_id = uuid.uuid4()
        machine = Machine(id=dev_id, user_id=user.id, name="Test Laptop", is_archived=False)
        db = AsyncMock()

        with patch("server.api.devices._verify_device_ownership", new_callable=AsyncMock, return_value=machine), \
             patch("server.api.devices._purge_device_data", new_callable=AsyncMock) as mock_purge, \
             patch("server.api.devices.cache_delete_prefix", new_callable=AsyncMock):

            # Test 1: keep_data=True unbinds device without purging data
            res = await delete_device(dev_id, db=db, _user=user, keep_data=True)
            self.assertEqual(res["status"], "archived")
            self.assertTrue(res["keep_data"])
            self.assertTrue(machine.is_archived)
            self.assertIsNotNone(machine.archived_at)
            # Ensure purge was never called!
            mock_purge.assert_not_called()

            # Test 2: unarchive restores the device
            unarch_res = await unarchive_device(dev_id, db=db, _user=user)
            self.assertEqual(unarch_res["status"], "unarchived")
            self.assertFalse(machine.is_archived)
            self.assertIsNone(machine.archived_at)

            # Test 3: explicit archive endpoint
            arch_res = await archive_device(dev_id, db=db, _user=user)
            self.assertEqual(arch_res["status"], "archived")
            self.assertTrue(machine.is_archived)


if __name__ == "__main__":
    unittest.main()
