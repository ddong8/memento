"""Semantic ranking: documents by their best chunk, less a little for having many chunks.

The pure tests need nothing. The database tests run against a real PostgreSQL
with pgvector when MEMENTO_TEST_DATABASE_URL points at a throwaway database
(they create and drop the schema).
"""

from __future__ import annotations

import math
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services import embedding_service as es  # noqa: E402

NOW = datetime.now(timezone.utc)


def _vec(sim: float) -> list[float]:
    """A unit vector at cosine `sim` from the first axis (the query below)."""
    v = [0.0] * es.EMBEDDING_DIM
    v[0], v[1] = sim, math.sqrt(1 - sim * sim)
    return v


QUERY = _vec(1.0)


class RankChunkPoolTests(unittest.TestCase):
    def test_document_with_many_chunks_loses_a_near_tie(self) -> None:
        hub, answer = uuid.uuid4(), uuid.uuid4()
        pool = [(hub, uuid.uuid4(), 0.30), (answer, uuid.uuid4(), 0.32)]
        hits = es.rank_chunk_pool(pool, {hub: 1000, answer: 1}, want=2)
        self.assertEqual([h.document_id for h in hits], [answer, hub])
        # similarity stays the raw cosine, the penalty only orders
        self.assertAlmostEqual(hits[1].similarity, 0.70)

    def test_a_clearly_closer_document_still_wins_however_long(self) -> None:
        hub, other = uuid.uuid4(), uuid.uuid4()
        pool = [(hub, uuid.uuid4(), 0.20), (other, uuid.uuid4(), 0.30)]
        hits = es.rank_chunk_pool(pool, {hub: 10_000, other: 1}, want=2)
        self.assertEqual(hits[0].document_id, hub)

    def test_best_chunk_per_document_and_want(self) -> None:
        a, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        a_best = uuid.uuid4()
        pool = [
            (a, uuid.uuid4(), 0.40), (a, a_best, 0.10), (b, uuid.uuid4(), 0.20),
            (a, uuid.uuid4(), 0.15), (c, uuid.uuid4(), 0.50),
        ]
        hits = es.rank_chunk_pool(pool, {}, want=2)  # unknown counts count as one chunk
        self.assertEqual([h.document_id for h in hits], [a, b])
        self.assertEqual(hits[0].chunk_id, a_best)
        self.assertAlmostEqual(hits[0].similarity, 0.90)

    def test_pool_size(self) -> None:
        self.assertEqual(es.pool_size(5), es.POOL_MIN)
        self.assertEqual(es.pool_size(20), 20 * es.POOL_PER_DOC)
        self.assertEqual(es.pool_size(500), es.POOL_MAX)


DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class SemanticDocumentHitsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base, Document, DocumentEmbedding, Machine, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

        async with self.Session() as db:
            user = User(email="a@example.com", role="owner", status="active")
            db.add_all([user, Tool(id="claude_code", display_name="Claude Code")])
            await db.flush()
            mine = Machine(name="mini", collector_token_hash="a", user_id=user.id, last_heartbeat=NOW)
            theirs = Machine(name="other", collector_token_hash="b", user_id=user.id, last_heartbeat=NOW)
            db.add_all([mine, theirs])
            await db.flush()
            self.mine = mine.id

            def doc(name: str, machine, sims: list[float]):
                d = Document(tool_id="claude_code", machine_id=machine.id, relative_path=f"p/{name}.jsonl",
                             category="conversation", content_type="jsonl", content=name, content_hash=name,
                             file_size_bytes=1, synced_at=NOW)
                db.add(d)
                return d, sims

            # A long conversation whose every chunk sits a hair closer than the one-chunk answer,
            # one far document, and the nearest of all on another machine.
            specs = [
                doc("hub", mine, [0.80] * 30),
                doc("answer", mine, [0.79]),
                doc("far", mine, [0.50, 0.40]),
                doc("elsewhere", theirs, [0.95]),
            ]
            await db.flush()
            for d, sims in specs:
                for i, sim in enumerate(sims):
                    db.add(DocumentEmbedding(document_id=d.id, chunk_index=i, chunk_text=f"{d.content} {i}",
                                             embedding=_vec(sim)))
            self.ids = {d.content: d.id for d, _ in specs}
            await db.commit()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def test_ranks_documents_and_filters_by_machine(self) -> None:
        async with self.Session() as db:
            hits = await es.semantic_document_hits(db, QUERY, 3, mids=[self.mine])
            texts = await es.chunk_texts(db, [h.chunk_id for h in hits])
        ids = {v: k for k, v in self.ids.items()}
        # The hub filled the old 4-chunks-per-document pool on its own; now every document shows up,
        # and the one-chunk answer edges out the hub's near tie.
        self.assertEqual([ids[h.document_id] for h in hits], ["answer", "hub", "far"])
        self.assertAlmostEqual(hits[1].similarity, 0.80, places=4)
        self.assertEqual(texts[hits[2].chunk_id], "far 0")

    async def test_no_filter_searches_every_document(self) -> None:
        async with self.Session() as db:
            hits = await es.semantic_document_hits(db, QUERY, 1)
        self.assertEqual(hits[0].document_id, self.ids["elsewhere"])

    async def test_chunk_counts(self) -> None:
        async with self.Session() as db:
            counts = await es.chunk_counts(db, set(self.ids.values()))
        self.assertEqual(counts, {self.ids["hub"]: 30, self.ids["answer"]: 1, self.ids["far"]: 2, self.ids["elsewhere"]: 1})
