from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from sqlalchemy.dialects import postgresql

from server.services.memory_lifecycle import DORMANT_AFTER, PITFALL_UNUSED_AFTER, sweep_dormant


class SweepDormantTests(unittest.IsolatedAsyncioTestCase):
    async def test_pitfalls_never_used_sleep_sooner_than_other_memories(self) -> None:
        db = AsyncMock()
        db.execute.side_effect = [MagicMock(rowcount=2), MagicMock(rowcount=3)]
        now = datetime(2026, 11, 23, tzinfo=timezone.utc)
        n = await sweep_dormant(db, SimpleNamespace(id=uuid.uuid4()), now=now)
        self.assertEqual(n, 5)
        general, pitfalls = (str(c.args[0].compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
                             for c in db.execute.await_args_list)
        self.assertIn("NOT IN ('rule', 'rules', 'preference')", general)
        self.assertIn(str((now - DORMANT_AFTER).date()), general)
        # only pitfalls no AI was handed: recall_count 0, untouched (or not run into again) for 30 days
        self.assertIn("user_memories.category = 'pitfall'", pitfalls)
        self.assertIn("coalesce(user_memories.recall_count, 0) = 0", pitfalls)
        self.assertIn(str((now - PITFALL_UNUSED_AFTER).date()), pitfalls)
        self.assertIn("user_memories.source != 'manual'", pitfalls)
        db.commit.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
