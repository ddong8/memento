"""Opening a long conversation one page at a time never shortens it.

bd026047 read only the last 40 turns on open and handed that page to the orphaned-task recovery,
which wrote page + recovered back as the whole conversation: on prod one conversation went from
410 turns to 42. Recovery now appends in SQL and checks the whole conversation for the task.
Runs against a real PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a throwaway database."""

from __future__ import annotations

import asyncio
import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")
T0 = datetime(2026, 10, 1, tzinfo=timezone.utc)


def _turns(n: int) -> list[dict]:
    out = []
    for i in range(n):
        turn = {"role": "user" if i % 2 == 0 else "assistant", "content": f"turn {i}",
                "created_at": (T0 + timedelta(minutes=i)).isoformat()}
        if i % 2:
            turn["toolCalls"] = [{"id": f"direct_{i}", "name": "run_on_device", "result": {"task_id": str(uuid.uuid5(uuid.NAMESPACE_OID, str(i)))}}]
        out.append(turn)
    return out


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class ConversationPageRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import AskConversation, Base, DeviceTask, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

        self.turns = _turns(100)
        last = T0 + timedelta(minutes=99)
        async with self.Session() as db:
            user = User(email="owner@example.com", role="owner", status="active")
            db.add(user)
            await db.flush()
            conv = AskConversation(user_id=user.id, title="long", turns=self.turns, message_count=100,
                                   device_id="dev-mac", cwd="/w", config={"execution_mode": "claude"})
            db.add(conv)
            await db.flush()
            # Ran while the api restarted: finished after the last turn, recorded nowhere
            self.orphan = DeviceTask(user_id=user.id, device_id="dev-mac", action="claude", status="succeeded",
                                     payload={"conversation_id": str(conv.id), "user_question": "lost question"},
                                     stdout="lost answer", created_at=last + timedelta(minutes=1),
                                     finished_at=last + timedelta(minutes=2))
            # Recorded by turn 5 (outside the last page) though its finish time is after the last turn
            self.recorded = DeviceTask(id=uuid.uuid5(uuid.NAMESPACE_OID, "5"), user_id=user.id, device_id="dev-mac",
                                       action="claude", status="succeeded",
                                       payload={"conversation_id": str(conv.id), "user_question": "turn 4"},
                                       stdout="turn 5", created_at=last, finished_at=last + timedelta(minutes=3))
            db.add_all([self.orphan, self.recorded])
            await db.commit()
            self.user, self.conv_id = user, conv.id

        self.patches = [
            patch("server.services.cache.redis_client", return_value=None),
            patch("server.services.ask_runs.ask_runs.get", AsyncMock(return_value=None)),
        ]
        for p in self.patches:
            p.start()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        for p in self.patches:
            p.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def _stored(self) -> tuple[list[dict], int]:
        from server.db.models import AskConversation

        async with self.Session() as db:
            conv = await db.get(AskConversation, self.conv_id)
            return conv.turns, conv.message_count

    async def _open(self, **kw) -> dict:
        from server.api.ask_conversations import get_conversation

        request = MagicMock()
        request.headers = {}
        response = MagicMock()
        response.headers = {}
        async with self.Session() as db:
            return await get_conversation(conv_id=str(self.conv_id), request=request, response=response,
                                          db=db, _user=self.user, **kw)

    async def test_opening_the_last_page_appends_the_orphan_and_keeps_the_rest(self) -> None:
        res = await self._open(limit=40)
        self.assertEqual(res["total_turns"], 102)
        self.assertEqual(res["offset"], 60)
        self.assertEqual(len(res["turns"]), 42)
        self.assertEqual(res["turns"][-1]["content"], "lost answer")
        self.assertEqual(res["turns"][-1]["index"], 101)

        turns, count = await self._stored()
        self.assertEqual(count, 102)
        self.assertEqual(turns[:100], self.turns)
        self.assertEqual([t["content"] for t in turns[100:]], ["lost question", "lost answer"])

        # Opened again: nothing more to recover, the task recorded in turn 5 never came back
        await self._open(limit=40)
        turns, count = await self._stored()
        self.assertEqual((len(turns), count), (102, 102))

    async def test_two_replicas_recovering_at_once_append_once(self) -> None:
        from server.db.models import AskConversation
        from server.services.ask_store import recover_orphaned_tasks_for_conv, tail_turns

        async def recover() -> None:
            async with self.Session() as db:
                conv = await db.get(AskConversation, self.conv_id)
                page = await tail_turns(db, self.conv_id, 40)
                await recover_orphaned_tasks_for_conv(db, conv, dict(conv.config), sample_turns=page)

        await asyncio.gather(recover(), recover())
        turns, count = await self._stored()
        self.assertEqual((len(turns), count), (102, 102))
        self.assertEqual(turns[:100], self.turns)

    async def test_scrolling_up_reads_the_page_before(self) -> None:
        res = await self._open(limit=40, before=60)
        self.assertEqual(res["offset"], 20)
        self.assertTrue(res["has_more"])
        self.assertEqual([t["index"] for t in res["turns"]], list(range(20, 60)))
        self.assertEqual(res["turns"][0]["content"], "turn 20")
        # A page further up never runs the recovery
        turns, _ = await self._stored()
        self.assertEqual(len(turns), 100)

        res = await self._open(limit=40, before=10)
        self.assertEqual((res["offset"], res["has_more"]), (0, False))
        self.assertEqual([t["content"] for t in res["turns"]], [f"turn {i}" for i in range(10)])


if __name__ == "__main__":
    unittest.main()
