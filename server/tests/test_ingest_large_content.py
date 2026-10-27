"""A conversation past 1 MB keeps its whole text in documents.content as deltas arrive.

1de21989 moved texts over 1 MB to MinIO and kept only a 64 KB head in the row, then appended
each delta to that head: the copy in MinIO lost everything between the head and the delta.
Past 1 MB the deltas wait in document_pending_deltas and are appended in one write once the
conversation goes quiet (services/content_staging.py): rewriting 8 MB for each 1.5 KB delta
wrote 24 GB a day. The database tests run against a real PostgreSQL when
MEMENTO_TEST_DATABASE_URL points at a throwaway database (they create and drop the schema)."""

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
    return '{"type":"user","uuid":"u%06d","message":{"content":"m%06d %s"}}' % (i, i, "x" * size)


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

    async def _ingest(self, rel: str, parts: list[str], first_mode: str = "full", offset: int = 0) -> int:
        from server.services.ingest_service import ingest_file

        for n, part in enumerate(parts):
            async with self.Session() as db:
                await ingest_file(
                    db, "claude_code", "conversation", "jsonl", rel, part, f"h{offset}-{n}", offset + len(part),
                    first_mode if n == 0 else "delta", offset, {"session_id": "big"},
                    machine_id=self.machine_id, user_id=self.user_id,
                )
                await db.commit()
            offset += len(part) + 1
        return offset

    async def _content(self, rel: str):
        from server.db.models import Document

        async with self.Session() as db:
            return (await db.execute(Document.__table__.select().where(Document.relative_path == rel))).one()

    async def _pending(self, doc_id) -> int:
        from sqlalchemy import func, select

        from server.db.models import DocumentPendingDelta

        async with self.Session() as db:
            return await db.scalar(
                select(func.count()).select_from(DocumentPendingDelta).where(DocumentPendingDelta.document_id == doc_id)
            )

    async def test_deltas_past_one_megabyte_keep_the_whole_text(self) -> None:
        from server.services.content_staging import merge_pending, with_pending

        rel = "projects/-Users-me-dev-memento/big.jsonl"
        slices = ["\n".join(_line(s * 10 + i, 30_000) for i in range(10)) for s in range(6)]  # ~300 KB each
        await self._ingest(rel, slices)

        doc = await self._content(rel)
        # Rewritten while under 1 MB; the two deltas after that wait to be appended
        self.assertEqual(doc.content, "\n".join(slices[:4]))
        self.assertGreater(len(doc.content), 1_048_576)
        self.assertEqual(await self._pending(doc.id), 2)
        self.assertIsNone(doc.content_s3_key)
        self.uploaded.assert_not_awaited()
        async with self.Session() as db:
            self.assertEqual(await with_pending(db, doc.id, doc.content), "\n".join(slices))
            # Every message is in the messages table already
            from sqlalchemy import func, select

            from server.db.models import ConversationMessage
            self.assertEqual(await db.scalar(
                select(func.count()).select_from(ConversationMessage).where(ConversationMessage.document_id == doc.id)
            ), 60)

        async with self.Session() as db:
            self.assertEqual(await merge_pending(db, doc.id), 2)
            await db.commit()
        self.assertEqual((await self._content(rel)).content, "\n".join(slices))
        self.assertEqual(await self._pending(doc.id), 0)

    async def test_sweep_merges_quiet_conversations_only(self) -> None:
        from sqlalchemy import text, update

        from server.db.models import DocumentPendingDelta
        from server.services.content_staging import merge_due

        rel = "projects/-Users-me-dev-memento/sweep.jsonl"
        slices = ["\n".join(_line(s * 10 + i, 30_000) for i in range(10)) for s in range(5)]
        await self._ingest(rel, slices)
        doc = await self._content(rel)
        self.assertEqual(await self._pending(doc.id), 1)

        self.assertEqual((await merge_due(self.Session, self.engine))["deltas"], 0)  # still being written
        async with self.Session() as db:
            await db.execute(update(DocumentPendingDelta).values(created_at=text("now() - interval '3 minutes'")))
            await db.commit()
        self.assertEqual(await merge_due(self.Session, self.engine), {"documents": 1, "deltas": 1})
        self.assertEqual((await self._content(rel)).content, "\n".join(slices))

    async def test_full_upload_supersedes_waiting_deltas(self) -> None:
        rel = "projects/-Users-me-dev-memento/full.jsonl"
        slices = ["\n".join(_line(s * 10 + i, 30_000) for i in range(10)) for s in range(5)]
        await self._ingest(rel, slices)
        doc = await self._content(rel)
        self.assertEqual(await self._pending(doc.id), 1)

        whole = "\n".join(slices + [_line(999, 10)])
        await self._ingest(rel, [whole], first_mode="full", offset=10_000_000)
        self.assertEqual((await self._content(rel)).content, whole)
        self.assertEqual(await self._pending(doc.id), 0)


class CapContentTests(unittest.TestCase):
    def test_keeps_whole_lines_from_the_start_and_the_end(self) -> None:
        from server.services import content_staging as cs

        with patch.object(cs, "MAX_CONTENT_CHARS", 100), patch.object(cs, "HEAD_CHARS", 30):
            text = "\n".join(f"line{i:03d}" for i in range(40))  # 319 characters
            capped = cs.cap_content(text)
            self.assertLessEqual(len(capped), 100)
            lines = capped.split("\n")
            self.assertEqual(lines[:3], ["line000", "line001", "line002"])
            self.assertEqual(lines[-1], "line039")
            self.assertTrue(all(line.startswith("line") and len(line) == 7 for line in lines))
            self.assertEqual(cs.cap_content("short"), "short")
            self.assertEqual(cs.append(None, "delta"), "delta")
            self.assertEqual(cs.append("a", "b"), "a\nb")

    def test_staged_conversations_are_past_what_the_index_reads(self) -> None:
        from server.services.content_staging import STAGE_MIN_BYTES
        from server.services.tokenize import _MAX_INPUT_CHARS

        self.assertGreaterEqual(STAGE_MIN_BYTES // 4, _MAX_INPUT_CHARS)

if __name__ == "__main__":
    unittest.main()
