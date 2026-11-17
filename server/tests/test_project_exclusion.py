"""Projects the user doesn't collect (services/project_exclusion.py).

The user (2026-11-17): "有些项目是用来测试的，不想它被抓取……对应的记忆，画像等也要删除". The pure tests
need nothing; the database tests run against a throwaway PostgreSQL in MEMENTO_TEST_DATABASE_URL.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.project_exclusion import exclusion_key, matches, memory_project  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


class NamingTests(unittest.TestCase):
    def test_a_project_is_named_like_profile_scopes_name_it(self):
        key = exclusion_key("Test App")
        self.assertEqual(key, "testapp")
        for name in ("test-app", "test_app", "TestApp", "test app"):
            self.assertTrue(matches(key, name), name)
        self.assertFalse(matches(key, "test-app-2"))

    def test_a_star_takes_every_project_it_fits(self):
        key = exclusion_key("test-*")
        self.assertTrue(matches(key, "test-login"))
        self.assertTrue(matches(key, "TEST_payment"))
        self.assertFalse(matches(key, "my-test"))

    def test_which_project_a_memory_is_about(self):
        self.assertEqual(memory_project("/project/test-app/overview", "proj_test-app_overview", "x", "project"), "test-app")
        self.assertEqual(memory_project(None, "proj_demo_overview", "x", "project"), "demo")
        self.assertEqual(memory_project(None, "k", "【test-app】测试库连不上。现象：…；解决：…", "pitfall"), "test-app")
        self.assertIsNone(memory_project(None, "k", "回复用中文", "rule"))


def _lines(cwd: str, n: int, start: int = 0) -> str:
    out = []
    for i in range(start, start + n):
        out.append(json.dumps({
            "type": "user" if i % 2 == 0 else "assistant", "cwd": cwd, "sessionId": "s1", "uuid": f"u{i}",
            "timestamp": f"2026-11-17T00:00:{i:02d}Z",
            "message": {"role": "user" if i % 2 == 0 else "assistant", "content": f"第 {i} 条"},
        }, ensure_ascii=False))
    return "\n".join(out) + "\n"


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class ExclusionDatabaseTests(unittest.IsolatedAsyncioTestCase):
    TEST_REL = "projects/-w-test-app/s1.jsonl"
    KEEP_REL = "projects/-w-keep/s2.jsonl"

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
            self.user_id, self.machine_id = user.id, str(machine.id)
        self.patches = [
            patch("server.services.ingest_service._run_post_ingest", AsyncMock()),
            patch("server.services.project_exclusion.invalidate", AsyncMock()),
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

    async def _send(self, rel: str, project: str, content: str, mode: str = "full", offset: int = 0) -> str:
        """What a collector sends, through the endpoint's path: the document id ("" when dropped)."""
        from server.api.ingest import IngestFileRequest, _ingest_one

        end = offset + len(content.encode())
        req = IngestFileRequest(
            tool="claude_code", category="conversation", content_type="jsonl", relative_path=rel,
            hash=f"h-{rel}-{offset}-{end}", mode=mode, offset=offset, file_size=end, content=content,
            metadata={"session_id": rel, "project_name": project, "project_path": f"/w/{project}"}, end_offset=end,
        )
        async with self.Session() as db:
            doc_id, _ = await _ingest_one(db, req, self.machine_id, str(self.user_id))
            await db.commit()
        return doc_id

    async def _user(self):
        from sqlalchemy import select

        from server.db.models import User

        async with self.Session() as db:
            return (await db.execute(select(User).where(User.id == self.user_id))).scalar_one()

    async def _seed_learned(self) -> None:
        from server.db.models import CorrectionTopic, Skill, Todo, UserMemory, UserProfile

        async with self.Session() as db:
            db.add_all([
                UserMemory(user_id=self.user_id, category="pitfall", key="p1", content="【test-app】测试库连不上。现象：超时；解决：换端口"),
                UserMemory(user_id=self.user_id, category="project", key="proj_test-app_overview",
                           tree_path="/project/test-app/overview", content="【test-app】一个测试项目"),
                UserMemory(user_id=self.user_id, category="pitfall", key="p2", content="【keep】正式项目的坑。现象：x；解决：y"),
                Skill(user_id=self.user_id, slug="test-app-deploy", title="t", description="d", body="b", project="test-app", status="published"),
                Skill(user_id=self.user_id, slug="keep-deploy", title="t", description="d", body="b", project="keep", status="published"),
                CorrectionTopic(user_id=self.user_id, statement="测试库用 5433", scope="项目：test-app", status="accepted"),
                Todo(user_id=self.user_id, title="补测试数据", project="test-app", source="session", fingerprint="f1"),
                UserProfile(user_id=self.user_id, status="published", version=3, content=(
                    "## 关于我\n- 回复用中文\n\n## 项目：test-app\n- 测试库用 5433\n\n## 项目：keep\n- 正式库只读"
                )),
            ])
            await db.commit()

    async def _state(self) -> dict:
        from sqlalchemy import select

        from server.db.models import CorrectionTopic, Document, Skill, SyncState, Todo, UserMemory, UserProfile

        async with self.Session() as db:
            return {
                "docs": sorted((await db.execute(select(Document.relative_path).where(Document.category == "conversation"))).scalars()),
                "memories": dict((await db.execute(select(UserMemory.key, UserMemory.status))).all()),
                "skills": dict((await db.execute(select(Skill.slug, Skill.status))).all()),
                "correction": await db.scalar(select(CorrectionTopic.status)),
                "todo": await db.scalar(select(Todo.status)),
                "profile": await db.scalar(select(UserProfile.content).where(UserProfile.status == "published")),
                "marked": dict((await db.execute(select(SyncState.relative_path, SyncState.excluded_project))).all()),
            }

    async def test_excluding_a_project_takes_away_what_it_left_and_stops_collecting_it(self):
        from server.services import project_exclusion as px

        self.assertTrue(await self._send(self.TEST_REL, "test-app", _lines("/w/test-app", 4)))
        self.assertTrue(await self._send(self.KEEP_REL, "keep", _lines("/w/keep", 4)))
        await self._seed_learned()

        async with self.Session() as db:
            seen = await px.preview(db, await self._user(), "test-app")
        self.assertEqual((seen["documents"], seen["memories"], seen["skills"], seen["corrections"], seen["todos"], seen["profile_rules"]),
                         (1, 2, 1, 1, 1, 1))
        self.assertGreater(seen["messages"], 0)

        async with self.Session() as db:
            await px.add(db, await self._user(), "Test App")
        async with self.Session() as db:
            counts = await px.purge(db, await self._user(), "testapp")
        self.assertEqual(counts["documents"], 1)

        s = await self._state()
        self.assertEqual(s["docs"], [self.KEEP_REL])
        self.assertEqual(s["memories"], {"p1": "excluded", "proj_test-app_overview": "excluded", "p2": "active"})
        self.assertEqual(s["skills"], {"test-app-deploy": "retired", "keep-deploy": "published"})
        self.assertEqual((s["correction"], s["todo"]), ("dismissed", "dropped"))
        self.assertNotIn("test-app", s["profile"])
        self.assertIn("## 项目：keep", s["profile"])
        self.assertEqual(s["marked"][self.TEST_REL], "testapp")
        self.assertIsNone(s["marked"][self.KEEP_REL])

        # The collector goes on sending: the next slice of the log and a new session are dropped
        size = len(_lines("/w/test-app", 4).encode())
        self.assertEqual(await self._send(self.TEST_REL, "test-app", _lines("/w/test-app", 2, 4), "delta", size), "")
        self.assertEqual(await self._send("projects/-w-test-app/s3.jsonl", "test_app", _lines("/w/test-app", 2)), "")
        self.assertEqual((await self._state())["docs"], [self.KEEP_REL])

        # 恢复采集: what was taken out of use is back, and the log comes back whole
        async with self.Session() as db:
            self.assertIsNotNone(await px.restore(db, await self._user(), "testapp"))
        s = await self._state()
        self.assertEqual(s["memories"]["p1"], "active")
        self.assertEqual(s["skills"]["test-app-deploy"], "published")
        self.assertEqual((s["correction"], s["todo"]), ("accepted", "open"))
        self.assertIn("## 项目：test-app\n- 测试库用 5433", s["profile"])
        self.assertNotIn(self.TEST_REL, s["marked"])
        self.assertTrue(await self._send(self.TEST_REL, "test-app", _lines("/w/test-app", 6)))
        self.assertIn(self.TEST_REL, (await self._state())["docs"])

    async def test_a_name_with_a_star_takes_every_project_it_fits(self):
        from server.services import project_exclusion as px

        await self._send("projects/-w-test-login/a.jsonl", "test-login", _lines("/w/test-login", 2))
        await self._send("projects/-w-test-pay/b.jsonl", "test-pay", _lines("/w/test-pay", 2))
        await self._send(self.KEEP_REL, "keep", _lines("/w/keep", 2))
        async with self.Session() as db:
            await px.add(db, await self._user(), "test-*")
        async with self.Session() as db:
            await px.purge(db, await self._user(), "test*")
        self.assertEqual((await self._state())["docs"], [self.KEEP_REL])
        self.assertEqual(await self._send("projects/-w-test-new/c.jsonl", "test-new", _lines("/w/test-new", 2)), "")


if __name__ == "__main__":
    unittest.main()
