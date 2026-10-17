"""The embedding sweep: only changed chunks are embedded, failures back off.

Pure and HTTP tests need nothing. The database tests run against a real
PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a throwaway database
(they create and drop the schema).
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services import embedding_service as es  # noqa: E402

NOW = datetime.now(timezone.utc)


def _conversation(turns: int, start: int = 0) -> str:
    return "\n\n".join(
        f"{'用户' if i % 2 == 0 else '助手'}: 第 {i} 轮。" + "这一轮讨论设备、项目和会话怎么对上。" * 20
        for i in range(start, start + turns)
    )


class ChunkingTests(unittest.TestCase):
    def test_appending_only_changes_the_tail(self) -> None:
        before = _conversation(40)
        after = before + "\n\n" + _conversation(6, start=40)
        a, b = es._chunk_text(before), es._chunk_text(after)
        self.assertGreater(len(a), 5)
        changed = es.changed_chunks(b, dict(enumerate(a)))
        self.assertTrue(changed)
        self.assertGreaterEqual(min(changed), len(a) - 2)  # everything before the last chunk or two is reused

    def test_no_trailing_overlap_chunk(self) -> None:
        chunks = es._chunk_text(_conversation(30))
        self.assertFalse(chunks[-2].endswith(chunks[-1]))

    def test_retry_delay_backs_off_and_caps(self) -> None:
        self.assertEqual(es.retry_delay(1), timedelta(minutes=2))
        self.assertEqual(es.retry_delay(3), timedelta(minutes=8))
        self.assertEqual(es.retry_delay(12889), timedelta(minutes=360))


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_openai_compatible_request_and_order(self) -> None:
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["url"] = str(request.url)
            seen["auth"] = request.headers.get("authorization")
            body = json.loads(request.content)
            seen["body"] = body
            data = [{"index": i, "embedding": [float(i + 1), 0.0, 0.0]} for i in range(len(body["input"]))]
            return httpx.Response(200, json={"data": list(reversed(data))})

        with patch.multiple(es, EMBEDDING_PROVIDER="openai", EMBEDDING_API_URL="https://api.example/v1",
                            EMBEDDING_API_KEY="k", EMBEDDING_MODEL="BAAI/bge-m3"):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                vectors = await es.embed_texts(["a", "b"], client=client)
        self.assertEqual(seen["url"], "https://api.example/v1/embeddings")
        self.assertEqual(seen["auth"], "Bearer k")
        self.assertEqual(seen["body"], {"model": "BAAI/bge-m3", "input": ["a", "b"], "encoding_format": "float"})
        self.assertEqual(vectors, [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]])  # sorted by index, then normalized

    async def test_rate_limit_is_not_a_failure(self) -> None:
        transport = httpx.MockTransport(lambda r: httpx.Response(429, headers={"retry-after": "3"}))
        with patch.object(es, "EMBEDDING_PROVIDER", "openai"):
            async with httpx.AsyncClient(transport=transport) as client:
                with self.assertRaises(es.EmbeddingRateLimited):
                    await es.embed_texts(["a"], client=client)

    async def test_local_server_request(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertTrue(str(request.url).endswith("/embed"))
            texts = json.loads(request.content)["texts"]
            return httpx.Response(200, json={"embeddings": [[3.0, 4.0] for _ in texts]})

        with patch.multiple(es, EMBEDDING_PROVIDER="local", EMBEDDING_SERVER_URL="http://bge:8002"):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                vectors = await es.embed_texts(["x"] * 12, client=client)
        self.assertEqual(len(vectors), 12)
        self.assertTrue(all(math.isclose(v[0], 0.6) and math.isclose(v[1], 0.8) for v in vectors))


DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class SweepTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base, ConversationMessage, Document, Machine, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        self.calls: list[int] = []

        async def fake_embed(texts, timeout=120.0, client=None):
            self.calls.append(len(texts))
            return [[1.0] + [0.0] * (es.EMBEDDING_DIM - 1) for _ in texts]

        self.patch = patch.object(es, "embed_texts", side_effect=fake_embed)
        self.patch.start()

        async with self.Session() as db:
            user = User(email="a@example.com", role="owner", status="active")
            db.add_all([user, Tool(id="claude_code", display_name="Claude Code")])
            await db.flush()
            m = Machine(name="mini", collector_token_hash="dev", user_id=user.id, last_heartbeat=NOW)
            db.add(m)
            await db.flush()
            self.doc = Document(tool_id="claude_code", machine_id=m.id, relative_path="p/s.jsonl", category="conversation",
                                content_type="jsonl", content="x" * 200, content_hash="h", file_size_bytes=1,
                                synced_at=NOW - timedelta(minutes=10))
            db.add(self.doc)
            await db.flush()
            self.ConversationMessage = ConversationMessage
            await self._add_turns(db, 0, 40)
            await db.commit()

    async def _add_turns(self, db, start: int, n: int) -> None:
        for i in range(start, start + n):
            db.add(self.ConversationMessage(
                document_id=self.doc.id, line_number=i, role="user" if i % 2 == 0 else "assistant",
                content=f"第 {i} 轮。" + "这一轮讨论设备、项目和会话怎么对上。" * 20, message_type="text",
            ))

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        self.patch.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def _sweep(self) -> dict:
        return await es.embed_pending_documents(self.Session, self.engine, budget_seconds=20)

    async def _doc(self):
        from server.db.models import Document

        async with self.Session() as db:
            return await db.get(Document, self.doc.id)

    async def _chunk_count(self) -> int:
        from sqlalchemy import func, select

        from server.db.models import DocumentEmbedding

        async with self.Session() as db:
            return await db.scalar(select(func.count()).select_from(DocumentEmbedding).where(DocumentEmbedding.document_id == self.doc.id))

    async def test_first_sweep_embeds_all_then_only_the_new_tail(self) -> None:
        stats = await self._sweep()
        total = await self._chunk_count()
        self.assertEqual(stats["embedded"], 1)
        self.assertEqual(stats["chunks"], total)
        doc = await self._doc()
        self.assertEqual((doc.embedding_status, doc.embedding_attempts), ("ok", 0))

        # The conversation grows; ingest marks it pending, then it goes quiet
        from sqlalchemy import update

        from server.db.models import Document

        async with self.Session() as db:
            await self._add_turns(db, 40, 4)
            await db.execute(update(Document).where(Document.id == self.doc.id).values(
                embedding_status="pending", synced_at=datetime.now(timezone.utc) - timedelta(minutes=5)))
            await db.commit()
        self.calls.clear()
        stats = await self._sweep()
        self.assertEqual(stats["embedded"], 1)
        self.assertLessEqual(stats["chunks"], 4)  # the changed tail only
        self.assertGreater(await self._chunk_count(), total)

    async def test_a_document_still_being_written_waits(self) -> None:
        from sqlalchemy import update

        from server.db.models import Document

        await self._sweep()  # embedded once
        async with self.Session() as db:
            await db.execute(update(Document).where(Document.id == self.doc.id).values(
                embedding_status="pending", synced_at=datetime.now(timezone.utc)))
            await db.commit()
        stats = await self._sweep()
        self.assertEqual(stats["chunks"], 0)  # synced seconds ago and embedded moments ago: not yet
        async with self.Session() as db:
            await db.execute(update(Document).where(Document.id == self.doc.id).values(
                embedded_at=datetime.now(timezone.utc) - timedelta(hours=1)))
            await db.commit()
        stats = await self._sweep()
        self.assertEqual(stats["embedded"], 1)  # waited too long: embedded although still active

    async def test_failure_backs_off_and_a_success_resets_it(self) -> None:
        self.patch.stop()
        with patch.object(es, "embed_texts", side_effect=httpx.ConnectError("down")):
            stats = await self._sweep()
        self.patch.start()
        self.assertEqual(stats["failed"], 1)
        doc = await self._doc()
        self.assertEqual((doc.embedding_status, doc.embedding_attempts), ("failed", 1))
        self.assertGreater(doc.embedding_next_at, datetime.now(timezone.utc))
        self.assertEqual((await self._sweep())["chunks"], 0)  # backing off

        from sqlalchemy import update

        from server.db.models import Document

        async with self.Session() as db:
            await db.execute(update(Document).where(Document.id == self.doc.id).values(embedding_next_at=None))
            await db.commit()
        stats = await self._sweep()
        doc = await self._doc()
        self.assertEqual((stats["embedded"], doc.embedding_status, doc.embedding_attempts), (1, "ok", 0))

    async def test_a_sync_during_embedding_keeps_it_pending(self) -> None:
        from sqlalchemy import update

        from server.db.models import Document

        async def embed_while_syncing(texts, timeout=120.0, client=None):
            async with self.Session() as db:
                await db.execute(update(Document).where(Document.id == self.doc.id).values(
                    synced_at=datetime.now(timezone.utc), embedding_status="pending"))
                await db.commit()
            return [[1.0] + [0.0] * (es.EMBEDDING_DIM - 1) for _ in texts]

        self.patch.stop()
        with patch.object(es, "embed_texts", side_effect=embed_while_syncing):
            await self._sweep()
        self.patch.start()
        doc = await self._doc()
        self.assertEqual(doc.embedding_status, "pending")
        self.assertIsNotNone(doc.embedded_at)

    async def test_only_one_sweep_at_a_time(self) -> None:
        async def slow_embed(texts, timeout=120.0, client=None):
            await asyncio.sleep(0.5)
            return [[1.0] + [0.0] * (es.EMBEDDING_DIM - 1) for _ in texts]

        self.patch.stop()
        with patch.object(es, "embed_texts", side_effect=slow_embed):
            results = await asyncio.gather(self._sweep(), self._sweep())
        self.patch.start()
        self.assertEqual(sum(1 for r in results if r.get("busy")), 1)
