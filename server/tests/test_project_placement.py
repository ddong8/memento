"""Which device a project lives on, and the folder on each.

The pure tests need nothing. The endpoint tests run against a real PostgreSQL
when MEMENTO_TEST_DATABASE_URL points at a throwaway database (they create and
drop the schema), e.g. postgresql+asyncpg://postgres@localhost:5433/memento_placement_test
"""

from __future__ import annotations

import os
import sys
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.project_placement import (  # noqa: E402
    DeviceRef,
    DiscoveredProject,
    Placement,
    discovered_for,
    is_junk_project,
    pick_project_path,
    project_devices,
)

NOW = datetime.now(timezone.utc)


class JunkProjectTests(unittest.TestCase):
    def test_files_tool_state_and_home_roots_are_not_projects(self) -> None:
        self.assertTrue(is_junk_project("transcript.jsonl", None))
        self.assertTrue(is_junk_project("task-21641.log", None))
        self.assertTrue(is_junk_project("output.txt", "C:/Users/Admin/.gemini/antigravity/brain/x/.system_generated/steps/2/output.txt"))
        self.assertTrue(is_junk_project("x", "/Users/me/.gemini/antigravity/brain/5279/.system_generated/logs"))
        self.assertTrue(is_junk_project("Users", "/Users"))
        self.assertTrue(is_junk_project("Users", "C:/Users/"))

    def test_real_projects_stay(self) -> None:
        self.assertFalse(is_junk_project("memento", "/Users/me/dev/memento"))
        self.assertFalse(is_junk_project("home", "d:/dev/2026/0518/home"))
        self.assertFalse(is_junk_project("vps", None))
        self.assertFalse(is_junk_project("socket.io", "/Users/me/dev/socket.io"))


class PickPathTests(unittest.TestCase):
    def test_a_newer_session_in_a_subfolder_does_not_move_the_project(self) -> None:
        pls = [
            Placement(None, "/Users/haixingdong/dev/memento", 10, NOW - timedelta(days=3)),
            Placement(None, "/Users/haixingdong/dev/memento/web", 2, NOW),
        ]
        self.assertEqual(pick_project_path(pls, "antigravity/memento", "memento"), "/Users/haixingdong/dev/memento")

    def test_exact_name_beats_partial_then_latest_wins(self) -> None:
        pls = [
            Placement(None, "/Users/me/dev/memento-old", 50, NOW),
            Placement(None, "/Users/me/dev/memento", 1, NOW - timedelta(days=9)),
            Placement(None, "/Users/me/work/memento", 1, NOW - timedelta(days=1)),
        ]
        self.assertEqual(pick_project_path(pls, "codex/memento", "memento"), "/Users/me/work/memento")

    def test_nothing_named_after_the_project(self) -> None:
        pls = [Placement(None, "/Users/me/.gemini/antigravity/brain/abc", 3, NOW), Placement(None, None, 4, NOW)]
        self.assertIsNone(pick_project_path(pls, "antigravity/memento", "memento"))


class ProjectDevicesTests(unittest.TestCase):
    def test_each_device_gets_its_own_folder_merged_records_fold_in(self) -> None:
        mini, book, book_old, win = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        index = {
            mini: DeviceRef("dev-mini", "mini (Darwin)"),
            book: DeviceRef("dev-book", "book (Darwin)"),
            book_old: DeviceRef("dev-book", "book (Darwin)"),
            win: DeviceRef("dev-win", "PC (Windows)"),
        }
        pls = [
            Placement(mini, "/Users/a/dev/memento", 5, NOW - timedelta(hours=1)),
            Placement(book, "/Users/b/Desktop/dev/memento", 3, NOW - timedelta(days=2)),
            Placement(book_old, "/Users/b/Desktop/dev/memento", 4, NOW - timedelta(days=5)),
            Placement(None, "/Users/x/memento", 9, NOW),  # no machine: no device
        ]
        found = [
            DiscoveredProject(win, "antigravity", "memento", "d:/dev/memento"),
            DiscoveredProject(win, "antigravity", "other", "d:/dev/other"),
        ]
        devices = project_devices("antigravity/memento", "memento", pls, discovered_for("antigravity/memento", found), index)
        self.assertEqual([d["device_id"] for d in devices], ["dev-mini", "dev-book", "dev-win"])
        self.assertEqual(devices[0]["source_path"], "/Users/a/dev/memento")
        self.assertEqual(devices[1]["source_path"], "/Users/b/Desktop/dev/memento")
        self.assertEqual(devices[1]["document_count"], 7)
        self.assertEqual(devices[2], {"device_id": "dev-win", "name": "PC (Windows)", "source_path": "d:/dev/memento", "document_count": 0, "last_active": None})


DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class EndpointTests(unittest.IsolatedAsyncioTestCase):
    """One project worked on from three machines, each in its own folder."""

    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.api import projects as projects_api
        from server.db.models import Base, Document, Machine, Project, Tool, User

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)
        projects_api._last_consolidation_time = time.time()  # skip the background tidy-up

        async with self.Session() as db:
            self.user = User(email="owner@example.com", role="owner", status="active")
            db.add_all([self.user, Tool(id="antigravity", display_name="Antigravity"), Tool(id="system", display_name="System")])
            await db.flush()
            mini = Machine(name="haixingdeMac-mini.local (Darwin)", collector_token_hash="dev-mini", user_id=self.user.id, last_heartbeat=NOW)
            book = Machine(name="donghaixingdeMacBook-Pro.local (Darwin)", collector_token_hash="dev-book", user_id=self.user.id, last_heartbeat=NOW)
            win = Machine(name="DESKTOP-KR9IPP4 (Windows)", collector_token_hash="dev-win", user_id=self.user.id, last_heartbeat=NOW)
            db.add_all([mini, book, win])
            await db.flush()
            book_old = Machine(name="donghaixingdeMacBook-Pro.local (Darwin)", collector_token_hash="dev-book-old",
                               user_id=self.user.id, last_heartbeat=NOW - timedelta(days=30), merged_into=book.id)
            db.add(book_old)
            # The shared row carries the MacBook's folder, as in production
            memento = Project(slug="antigravity/memento", title="memento", tool_id="antigravity",
                              source_path="/Users/donghaixing/Desktop/dev/memento")
            video = Project(slug="antigravity/video", title="video", tool_id="antigravity", source_path="/Users/donghaixing/Desktop/dev/video")
            transcript = Project(slug="antigravity/transcript.jsonl", title="transcript.jsonl", tool_id="antigravity",
                                 source_path="/Users/haixingdong/.gemini/antigravity/brain/5279/.system_generated/logs/transcript.jsonl")
            root = Project(slug="antigravity/Users", title="Users", tool_id="antigravity", source_path="/Users")
            db.add_all([memento, video, transcript, root])
            await db.flush()

            def conv(machine, project, sid, path, age_days, title="会话"):
                return Document(
                    tool_id="antigravity", project_id=project.id, machine_id=machine.id,
                    relative_path=f"brain/{sid}/transcript.jsonl", category="conversation", content_type="jsonl",
                    title=title, content_hash=sid, file_size_bytes=10,
                    metadata_={"session_id": sid, **({"project_path": path} if path else {})},
                    synced_at=NOW - timedelta(days=age_days),
                )

            db.add_all([
                conv(mini, memento, "s-mini-1", "/Users/haixingdong/dev/memento", 3),
                conv(mini, memento, "s-mini-2", "/Users/haixingdong/dev/memento/web", 0),
                conv(book, memento, "s-book-1", "/Users/donghaixing/Desktop/dev/memento", 1),
                conv(book_old, memento, "s-book-old", "/Users/donghaixing/Desktop/dev/memento", 9),
                conv(win, memento, "s-win-1", None, 2),
                conv(book, video, "s-video", "/Users/donghaixing/Desktop/dev/video", 4),
                conv(mini, transcript, "s-junk-1", None, 1),
                conv(mini, root, "s-junk-2", "/Users", 1),
                Document(
                    tool_id="system", machine_id=mini.id, relative_path="discovery/dev-mini.json", category="discovery",
                    content_type="json", content_hash="disc", file_size_bytes=10,
                    content='{"antigravity": {"projects": [{"name": "vps", "path": "/Users/haixingdong/Desktop/vps"}]}}',
                ),
            ])
            await db.commit()
            self.memento_id = memento.id

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def _projects(self, device_id: str | None) -> dict[str, dict]:
        from server.api.projects import list_projects

        async with self.Session() as db:
            items = await list_projects(tool_id="antigravity", device_id=device_id, sync=True, db=db, _user=self.user)
        return {p["title"]: p for p in items}

    async def _sessions(self, device_id: str | None) -> dict:
        from server.api.projects import get_project_conversations

        async with self.Session() as db:
            return await get_project_conversations(
                self.memento_id, session_offset=0, session_limit=50, offset=None, limit=None,
                max_messages_per_session=0, order="desc", device_id=device_id, db=db, _user=self.user, as_of=None,
            )

    async def test_each_device_sees_its_own_folder(self) -> None:
        mini = await self._projects("dev-mini")
        self.assertEqual(mini["memento"]["source_path"], "/Users/haixingdong/dev/memento")
        self.assertEqual([d["device_id"] for d in mini["memento"]["devices"]], ["dev-mini"])
        self.assertEqual(mini["vps"]["source_path"], "/Users/haixingdong/Desktop/vps")
        self.assertNotIn("transcript.jsonl", mini)
        self.assertNotIn("Users", mini)
        self.assertNotIn("video", mini)

        book = await self._projects("dev-book")
        self.assertEqual(book["memento"]["source_path"], "/Users/donghaixing/Desktop/dev/memento")
        self.assertEqual(book["memento"]["document_count"], 2)  # its old, merged record counts too
        self.assertIn("video", book)
        self.assertNotIn("vps", book)

        # No folder known on this device: empty, not the MacBook's folder from the shared row
        win = await self._projects("dev-win")
        self.assertEqual(win["memento"]["source_path"], "")

    async def test_without_a_device_every_project_says_where_it_lives(self) -> None:
        everything = await self._projects(None)
        devices = everything["memento"]["devices"]
        self.assertEqual([d["device_id"] for d in devices], ["dev-mini", "dev-book", "dev-win"])
        self.assertEqual(devices[0]["source_path"], "/Users/haixingdong/dev/memento")
        self.assertEqual(devices[1]["source_path"], "/Users/donghaixing/Desktop/dev/memento")
        self.assertEqual(everything["memento"]["source_path"], "/Users/haixingdong/dev/memento")
        self.assertEqual([d["device_id"] for d in everything["vps"]["devices"]], ["dev-mini"])
        self.assertNotIn("transcript.jsonl", everything)

    async def test_sessions_name_their_device(self) -> None:
        mini = await self._sessions("dev-mini")
        self.assertEqual(mini["project"]["source_path"], "/Users/haixingdong/dev/memento")
        self.assertEqual({s["device_id"] for s in mini["sessions"]}, {"dev-mini"})

        win = await self._sessions("dev-win")
        self.assertEqual(win["project"]["source_path"], "")

        everything = await self._sessions(None)
        by_sid = {s["session_id"]: s["device_id"] for s in everything["sessions"]}
        self.assertEqual(by_sid["s-book-old"], "dev-book")
        self.assertEqual(by_sid["s-win-1"], "dev-win")
        self.assertEqual(by_sid["s-mini-1"], "dev-mini")
