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

        from server.db.models import Document
        from server.services import tokenize

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
                before = (await db.execute(select(Document.content_tsv).where(Document.relative_path == rel))).scalar()
            await self.ingest("claude_code", rel, '{"type":"user","message":{"content":"后来的话"}}', "delta", len(start), dict(meta))
            self.assertEqual(len(calls), 1)  # not tokenized again
            async with self.Session() as db:
                after = (await db.execute(select(Document.content_tsv).where(Document.relative_path == rel))).scalar()
            self.assertEqual(before, after)

            # A short document still gets every delta indexed
            short = "projects/-Users-me-dev-memento/short.jsonl"
            await self.ingest("claude_code", short, '{"type":"user"}', "full", 0, {**meta, "session_id": "short"})
            await self.ingest("claude_code", short, '{"type":"user","message":{"content":"新词汇"}}', "delta", 16, {**meta, "session_id": "short"})
            self.assertEqual(len(calls), 3)


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
