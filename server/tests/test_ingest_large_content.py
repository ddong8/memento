"""A conversation past 1 MB keeps its whole text in documents.content as deltas arrive.

1de21989 moved texts over 1 MB to MinIO and kept only a 64 KB head in the row, then appended
each delta to that head: the copy in MinIO lost everything between the head and the delta.
The database tests run against a real PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a
throwaway database (they create and drop the schema)."""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


def _line(i: int, size: int) -> str:
    return '{"type":"user","uuid":"u%06d","message":{"content":"%s"}}' % (i, "x" * size)


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class LargeConversationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base, Machine, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.Session() as db:
            user = User(email="owner@example.com", role="owner", status="active")
            db.add_all([user, Tool(id="claude_code", display_name="Claude Code")])
            await db.flush()
            machine = Machine(name="mac (Darwin)", collector_token_hash="dev-mac", user_id=user.id)
            db.add(machine)
            await db.commit()
            self.user_id, self.machine_id = str(user.id), str(machine.id)
        self.post = patch("server.services.ingest_service._run_post_ingest", AsyncMock())
        self.post.start()
        # Object storage "works": nothing may be moved out of the row anyway
        self.upload = patch("server.services.storage_service.upload_bytes", AsyncMock(side_effect=lambda key, *_a, **_k: key))
        self.uploaded = self.upload.start()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        self.upload.stop()
        self.post.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def test_deltas_past_one_megabyte_keep_the_whole_text(self) -> None:
        from server.db.models import Document
        from server.services.ingest_service import ingest_file

        rel = "projects/-Users-me-dev-memento/big.jsonl"
        slices = ["\n".join(_line(s * 10 + i, 30_000) for i in range(10)) for s in range(5)]  # ~300 KB each
        offset = 0
        for n, part in enumerate(slices):
            async with self.Session() as db:
                await ingest_file(
                    db, "claude_code", "conversation", "jsonl", rel, part, f"h{n}", offset + len(part),
                    "full" if n == 0 else "delta", offset, {"session_id": "big"},
                    machine_id=self.machine_id, user_id=self.user_id,
                )
                await db.commit()
            offset += len(part) + 1

        async with self.Session() as db:
            doc = (await db.execute(Document.__table__.select().where(Document.relative_path == rel))).one()
        self.assertEqual(doc.content, "\n".join(slices))
        self.assertGreater(len(doc.content), 1_048_576)
        self.assertIsNone(doc.content_s3_key)
        self.uploaded.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
