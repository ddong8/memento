"""Which project a synced session is filed under, and that it stays there.

The database tests run against a real PostgreSQL when MEMENTO_TEST_DATABASE_URL points at a
throwaway database (they create and drop the schema).
"""

from __future__ import annotations

import os
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.ingest_service import is_junk_project  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")
SID = "e8acd96e-e64f-4dac-8546-6a35e2f7e3da"
BRAIN_FILE = f"/Users/me/.gemini/antigravity/brain/{SID}/.system_generated/steps/2/output.txt"


class JunkTests(unittest.TestCase):
    def test_an_antigravity_step_output_is_not_a_project(self) -> None:
        self.assertTrue(is_junk_project("output.txt", BRAIN_FILE))
        self.assertTrue(is_junk_project("x", BRAIN_FILE))
        self.assertFalse(is_junk_project("memento", "/Users/me/dev/memento"))


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class IngestProjectTests(unittest.IsolatedAsyncioTestCase):
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
            db.add_all([user, Tool(id="claude_code", display_name="Claude Code"), Tool(id="antigravity", display_name="Antigravity")])
            await db.flush()
            machine = Machine(name="haixingdeMac-mini.local (Darwin)", collector_token_hash="dev-mini", user_id=user.id)
            db.add(machine)
            await db.commit()
            self.user_id, self.machine_id = str(user.id), str(machine.id)
        # No knowledge extraction / embedding work in the background
        self.post = patch("server.services.ingest_service._run_post_ingest", AsyncMock())
        self.post.start()

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        self.post.stop()
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def ingest(self, tool: str, rel: str, content: str, mode: str, offset: int, metadata: dict):
        from server.services.ingest_service import ingest_file

        async with self.Session() as db:
            doc = await ingest_file(
                db, tool, "conversation", "jsonl", rel, content, f"h-{offset}-{len(content)}", offset + len(content),
                mode, offset, metadata, machine_id=self.machine_id, user_id=self.user_id,
            )
            await db.commit()
            return doc

    async def project_of(self, doc):
        from server.db.models import Project

        async with self.Session() as db:
            return await db.get(Project, doc.project_id) if doc.project_id else None

    async def test_a_later_slice_after_cd_does_not_move_the_session(self) -> None:
        rel = "projects/-Users-me-dev-memento/s1.jsonl"
        first = '{"type":"user","cwd":"/Users/me/dev/memento","message":{"content":"看看"}}'
        doc = await self.ingest("claude_code", rel, first, "full", 0,
                                {"session_id": "s1", "project_path": "/Users/me/dev/memento", "project_hash": "memento"})
        self.assertEqual((await self.project_of(doc)).title, "memento")

        # An older collector took the project from the slice: the agent had run `cd server`
        later = '{"type":"user","cwd":"/Users/me/dev/memento/server","message":{"content":"跑测试"}}'
        doc = await self.ingest("claude_code", rel, later, "delta", len(first) + 1,
                                {"session_id": "s1", "project_path": "/Users/me/dev/memento/server", "project_hash": "server"})
        self.assertEqual((await self.project_of(doc)).title, "memento")
        self.assertEqual(doc.metadata_["project_path"], "/Users/me/dev/memento")

    async def test_an_antigravity_brain_file_never_becomes_a_project(self) -> None:
        from sqlalchemy import select

        from server.db.models import Project

        doc = await self.ingest("antigravity", f"brain/{SID}/transcript.jsonl", '{"type":"user","content":"做个视频"}', "full", 0,
                                {"session_id": SID, "project_path": BRAIN_FILE, "project_hash": "output.txt"})
        self.assertIsNone(doc.project_id)
        async with self.Session() as db:
            slugs = (await db.execute(select(Project.slug))).scalars().all()
        self.assertNotIn("antigravity/output.txt", slugs)

    async def test_a_session_filed_under_a_file_takes_its_real_project(self) -> None:
        from server.db.models import Document, Project

        async with self.Session() as db:
            junk = Project(slug="antigravity/output.txt", title="output.txt", tool_id="antigravity", source_path=BRAIN_FILE)
            db.add(junk)
            await db.flush()
            db.add(Document(
                tool_id="antigravity", project_id=junk.id, machine_id=uuid.UUID(self.machine_id),
                relative_path=f"brain/{SID}/transcript.jsonl", category="conversation", content_type="jsonl",
                title="做个视频", content='{"type":"user"}', content_hash="h0", file_size_bytes=15,
                metadata_={"session_id": SID, "project_path": BRAIN_FILE, "project_hash": "output.txt"},
            ))
            await db.commit()
        doc = await self.ingest("antigravity", f"brain/{SID}/transcript.jsonl", '{"type":"assistant"}', "delta", 16,
                                {"session_id": SID, "project_path": "/Users/me/work/video-tool", "project_hash": "video-tool"})
        self.assertEqual((await self.project_of(doc)).title, "video-tool")


    async def test_the_index_is_left_alone_when_a_delta_cannot_change_it(self) -> None:
        from sqlalchemy import select

        from server.db.models import Document, DocumentSearch
        from server.services import tokenize

        def tsv_of(path: str):
            return (
                select(DocumentSearch.content_tsv)
                .join(Document, Document.id == DocumentSearch.document_id)
                .where(Document.relative_path == path)
            )

        calls: list[int] = []
        real = tokenize.tokenize_for_index

        def counting(text: str) -> str:
            calls.append(len(text))
            return real(text)

        rel = "projects/-Users-me-dev-memento/long.jsonl"
        meta = {"session_id": "long", "project_path": "/Users/me/dev/memento", "project_hash": "memento"}
        start = '{"type":"user","message":{"content":"开头的问题"}}\n' * 6000  # > 200k chars: past what the index reads
        with patch.object(tokenize, "tokenize_for_index", counting):
            await self.ingest("claude_code", rel, start, "full", 0, dict(meta))
            self.assertEqual(len(calls), 1)
            async with self.Session() as db:
                before = (await db.execute(tsv_of(rel))).scalar()
            self.assertIsNotNone(before)
            await self.ingest("claude_code", rel, '{"type":"user","message":{"content":"后来的话"}}', "delta", len(start), dict(meta))
            self.assertEqual(len(calls), 1)  # not tokenized again
            async with self.Session() as db:
                after = (await db.execute(tsv_of(rel))).scalar()
            self.assertEqual(before, after)

            # A short document still gets every delta indexed
            short = "projects/-Users-me-dev-memento/short.jsonl"
            await self.ingest("claude_code", short, '{"type":"user"}', "full", 0, {**meta, "session_id": "short"})
            await self.ingest("claude_code", short, '{"type":"user","message":{"content":"新词汇"}}', "delta", 16, {**meta, "session_id": "short"})
            self.assertEqual(len(calls), 3)
            async with self.Session() as db:
                short_tsv = (await db.execute(tsv_of(short))).scalar()
            self.assertIn("词汇", str(short_tsv))


    async def test_keyword_retrieval_finds_words_of_the_content(self) -> None:
        # The full-text index sits in document_search: hybrid_rank's keyword channel must still match
        # a word that is only in a document's content, and rank it; a title match without a row still counts
        from server.db.models import User
        from server.services import ask_retrieval

        meta = {"session_id": "fts", "project_path": "/Users/me/dev/memento", "project_hash": "memento"}
        hit = await self.ingest("claude_code", "projects/-Users-me-dev-memento/fts.jsonl",
                                '{"type":"user","message":{"content":"排查氪星石接口超时"}}', "full", 0, dict(meta))
        await self.ingest("claude_code", "projects/-Users-me-dev-memento/other.jsonl",
                          '{"type":"user","message":{"content":"别的话题"}}', "full", 0, {**meta, "session_id": "other"})
        async with self.Session() as db:
            user = await db.get(User, uuid.UUID(self.user_id))
            with patch.object(ask_retrieval, "_semantic_doc_ranks", AsyncMock(return_value=([], {}, {}))), \
                 patch.object(ask_retrieval, "async_session_factory", self.Session), \
                 patch("server.services.cache.cache_get", AsyncMock(return_value=None)), \
                 patch("server.services.cache.cache_set", AsyncMock()):
                docs, kw_order, _, _ = await ask_retrieval.hybrid_rank(db, user, "氪星石", None, None, k=5)
        self.assertEqual(kw_order, [hit.id])
        self.assertEqual([d.id for d in docs], [hit.id])

    async def test_a_rare_word_picks_the_keyword_candidates(self) -> None:
        # 接口/超时 are in every document here, 氪星石 in one: only it picks candidates (on the real
        # query, through the index), and documents that just repeat the common words aren't returned
        from server.db.models import User
        from server.services import ask_retrieval, fulltext

        fulltext._df_cache.clear()
        fulltext._n_cache = None
        meta = {"project_path": "/Users/me/dev/memento", "project_hash": "memento"}
        hit = await self.ingest("claude_code", "projects/-Users-me-dev-memento/rare.jsonl",
                                '{"type":"user","message":{"content":"排查氪星石接口超时"}}', "full", 0,
                                {**meta, "session_id": "rare"})
        for i in range(3):
            await self.ingest("claude_code", f"projects/-Users-me-dev-memento/common{i}.jsonl",
                              '{"type":"user","message":{"content":"接口超时，接口又超时，接口还是超时"}}', "full", 0,
                              {**meta, "session_id": f"common{i}"})
        async with self.Session() as db:
            user = await db.get(User, uuid.UUID(self.user_id))
            with patch.object(fulltext, "COMMON_TERM_SHARE", 0.5), \
                 patch.object(ask_retrieval, "_semantic_doc_ranks", AsyncMock(return_value=([], {}, {}))), \
                 patch.object(ask_retrieval, "async_session_factory", self.Session), \
                 patch("server.services.cache.cache_get", AsyncMock(return_value=None)), \
                 patch("server.services.cache.cache_set", AsyncMock()):
                _, kw_order, _, _ = await ask_retrieval.hybrid_rank(db, user, "氪星石接口超时", None, None, k=5)
        fulltext._df_cache.clear()
        fulltext._n_cache = None
        self.assertEqual(kw_order, [hit.id])

    async def test_the_eval_finds_who_holds_a_quoted_answer(self) -> None:
        from datetime import datetime, timezone

        from server.db.models import ConversationMessage, Document
        from server.services.eval_service import holders

        meta = {"project_path": "/Users/me/dev/memento", "project_hash": "memento"}
        talk = await self.ingest("claude_code", "projects/-Users-me-dev-memento/q.jsonl",
                                 '{"type":"user","message":{"content":"别的话题"}}', "full", 0, {**meta, "session_id": "q"})
        silent = await self.ingest("claude_code", "projects/-Users-me-dev-memento/s.jsonl",
                                   '{"type":"user","message":{"content":"别的话题"}}', "full", 0, {**meta, "session_id": "s"})
        async with self.Session() as db:
            at = datetime(2026, 11, 9, tzinfo=timezone.utc)
            db.add_all([
                ConversationMessage(document_id=talk.id, line_number=900, role="assistant", content="把 DefaultIM\n改成 pinyin 即可", timestamp=at),
                # tool output quoting the same words is not the conversation answering it
                ConversationMessage(document_id=silent.id, line_number=900, role="user", content="[Result] 把 DefaultIM 改成 pinyin 即可", timestamp=at),
            ])
            note = Document(tool_id="claude_code", machine_id=uuid.UUID(self.machine_id), relative_path="notes/ime.md", category="note",
                            content_type="markdown", content="输入法：把 defaultim 改成 PINYIN 即可。", content_hash="n", file_size_bytes=1)
            other = Document(tool_id="claude_code", machine_id=uuid.UUID(self.machine_id), relative_path="notes/x.md", category="note",
                             content_type="markdown", content="无关", content_hash="o", file_size_bytes=1)
            db.add_all([note, other])
            await db.commit()
            found = await holders(db, {talk.id, silent.id, note.id, other.id}, "把 DefaultIM 改成 pinyin")
        self.assertEqual(found, {talk.id, note.id})

    async def test_the_old_column_is_dropped_keeping_the_newer_vectors(self) -> None:
        # documents.content_tsv as the releases before document_search left it: a start copies over the
        # vectors only it has, keeps the table's where both have one and drops it; the next has nothing to do
        from sqlalchemy import inspect, select, text

        from server.db.models import DocumentSearch
        from server.main import _run_migrations

        meta = {"session_id": "new", "project_path": "/Users/me/dev/memento", "project_hash": "memento"}
        kept = await self.ingest("claude_code", "projects/-Users-me-dev-memento/new.jsonl",
                                 '{"type":"user","message":{"content":"新词汇"}}', "full", 0, dict(meta))
        lost = await self.ingest("claude_code", "projects/-Users-me-dev-memento/old.jsonl",
                                 '{"type":"user","message":{"content":"别的话题"}}', "full", 0, {**meta, "session_id": "old"})
        async with self.engine.begin() as conn:
            await conn.execute(text("ALTER TABLE documents ADD COLUMN content_tsv tsvector"))
            await conn.execute(text("UPDATE documents SET content_tsv = to_tsvector('simple', 'stale')"))
            await conn.execute(text("DELETE FROM document_search WHERE document_id = :d"), {"d": lost.id})
            await conn.run_sync(_run_migrations)
        async with self.engine.begin() as conn:
            await conn.run_sync(_run_migrations)
            cols = await conn.run_sync(lambda c: {col["name"] for col in inspect(c).get_columns("documents")})
        self.assertNotIn("content_tsv", cols)
        async with self.Session() as db:
            tsv = dict((await db.execute(select(DocumentSearch.document_id, DocumentSearch.content_tsv))).all())
        self.assertIn("词汇", str(tsv[kept.id]))
        self.assertEqual(str(tsv[lost.id]), "'stale':1")

class HeartbeatTests(unittest.TestCase):
    def test_written_at_most_once_a_minute(self) -> None:
        from datetime import datetime, timedelta, timezone

        from server.db.models import Machine
        from server.services.device_service import touch_heartbeat

        now = datetime.now(timezone.utc)
        m = Machine(name="mini", collector_token_hash="t", last_heartbeat=now - timedelta(seconds=20))
        touch_heartbeat(m, now)
        self.assertEqual(m.last_heartbeat, now - timedelta(seconds=20))
        touch_heartbeat(m, now + timedelta(seconds=41))
        self.assertEqual(m.last_heartbeat, now + timedelta(seconds=41))
        m.last_heartbeat = None
        touch_heartbeat(m, now)
        self.assertEqual(m.last_heartbeat, now)

if __name__ == "__main__":
    unittest.main()
