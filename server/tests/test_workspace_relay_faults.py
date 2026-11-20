"""Fault-injection tests for cross-device workspace_relay resilience and access isolation."""

from __future__ import annotations

import asyncio
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from server.services import workspace_relay as wr


class TestWorkspaceRelayFaults(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        wr._local_tokens.clear()

    async def test_source_device_rejects_other_account_and_archived_machine(self):
        owner_a = uuid.uuid4()
        owner_b = uuid.uuid4()

        other_machine = MagicMock(
            collector_token_hash="hash-b",
            user_id=owner_b,
            is_archived=False,
            name="B-Mac",
        )
        archived_machine = MagicMock(
            collector_token_hash="hash-a",
            user_id=owner_a,
            is_archived=True,
            name="Old-Mac",
        )
        fake_ctx = AsyncMock()
        fake_ctx.__aenter__.return_value = MagicMock()
        fake_ctx.__aexit__.return_value = None

        with patch.object(wr, "async_session_factory", return_value=fake_ctx), \
                patch.object(wr, "find_machine_by_id_or_hash", AsyncMock(return_value=other_machine)):
            conn_id, err = await wr._source_device("hash-b", owner_a)
            self.assertIsNone(conn_id)
            self.assertIn("不属于", err or "")

        with patch.object(wr, "async_session_factory", return_value=fake_ctx), \
                patch.object(wr, "find_machine_by_id_or_hash", AsyncMock(return_value=archived_machine)):
            conn_id, err = await wr._source_device("hash-a", owner_a)
            self.assertIsNone(conn_id)
            self.assertIn("解除关联", err or "")

    async def test_source_device_offline_fails_fast_instead_of_hanging(self):
        owner = uuid.uuid4()
        machine = MagicMock(
            collector_token_hash="hash-offline",
            user_id=owner,
            is_archived=False,
            name="Offline-Mac",
        )
        fake_ctx = AsyncMock()
        fake_ctx.__aenter__.return_value = MagicMock()
        fake_ctx.__aexit__.return_value = None

        with patch.object(wr, "async_session_factory", return_value=fake_ctx), \
                patch.object(wr, "find_machine_by_id_or_hash", AsyncMock(return_value=machine)), \
                patch.object(wr.ws_manager, "is_online", return_value=False):
            conn_id, err = await asyncio.wait_for(wr._source_device("hash-offline", owner), timeout=1.0)
            self.assertIsNone(conn_id)
            self.assertIn("不在线", err or "")

    async def test_local_token_store_evicts_expired_entries_and_handles_missing(self):
        with patch.object(type(wr.cluster), "redis", new_callable=lambda: property(lambda self: None)):
            tok = await wr._put_token({"source": "dev-1", "path": "/tmp/bundle"})
            self.assertEqual(await wr._get_token(tok), {"source": "dev-1", "path": "/tmp/bundle"})
            # Simulate expiry
            wr._local_tokens[tok] = (0.0, {"source": "dev-1", "path": "/tmp/bundle"})
            self.assertIsNone(await wr._get_token(tok))
            # Writing a new token purges expired local tokens
            tok2 = await wr._put_token({"source": "dev-2", "path": "/tmp/bundle2"})
            self.assertNotIn(tok, wr._local_tokens)
            self.assertIn(tok2, wr._local_tokens)


if __name__ == "__main__":
    unittest.main()
