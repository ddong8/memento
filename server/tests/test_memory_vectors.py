"""Every active memory gets a vector, reconcile compares a new memory with the closest ones, and a
merged duplicate pitfall's hits count for the one it was merged into.

On 11-09 only memories dreaming had touched had vectors (119 of 596 active; none of the 205 pitfalls),
so Ask's memory search scored most memories by word overlap and reconcile, comparing each new memory
with the 80 most recently touched in its group, never put "pytest isn't on PATH" (10-30) next to
"no pytest command on macOS" (10-11): the memento group held 144 pitfalls. Database tests run against
a real PostgreSQL with pgvector when MEMENTO_TEST_DATABASE_URL points at a throwaway database."""

from __future__ import annotations

import math
import os
import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from sqlalchemy.dialects import postgresql  # noqa: E402
from sqlalchemy.orm import make_transient_to_detached  # noqa: E402

from server.db.models import EMBEDDING_INDEX_DIM, User, UserMemory  # noqa: E402
from server.services import memory_lifecycle as ml  # noqa: E402
from server.services import memory_vectors as mv  # noqa: E402
from server.services import retrospective_service as rs  # noqa: E402

DB_URL = os.environ.get("MEMENTO_TEST_DATABASE_URL")


def vec(*weights: tuple[int, float]) -> list[float]:
    """A unit vector with the given weights on the given axes."""
    v = [0.0] * EMBEDDING_INDEX_DIM
    for axis, w in weights:
        v[axis] = w
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]


def _pit(title: str, symptom: str = "报错", fix: str = "解法", project: str | None = "memento") -> str:
    return rs.format_pitfall({"title": title, "symptom": symptom, "cause": "原因", "fix": fix}, project)


class StaleVectorTests(unittest.TestCase):
    def _stored(self, content: str) -> UserMemory:
        mem = UserMemory(id=uuid.uuid4(), user_id=uuid.uuid4(), category="rule", key="k", content=content, embedding=vec((0, 1)))
        make_transient_to_detached(mem)  # as if loaded from the database
        return mem

    def test_a_changed_text_drops_the_old_vector(self):
        mem = self._stored("提交用中文")
        mem.content = "提交用中文 Conventional Commits"
        self.assertIsNone(mem.embedding)

    def test_the_same_text_keeps_it(self):
        mem = self._stored("提交用中文")
        mem.content = "提交用中文"
        self.assertIsNotNone(mem.embedding)

    def test_a_new_memory_keeps_the_vector_it_was_given(self):
        mem = UserMemory(user_id=uuid.uuid4(), category="rule", key="k", embedding=vec((0, 1)), content="提交用中文")
        self.assertIsNotNone(mem.embedding)


class EmbedMemoriesTests(unittest.IsolatedAsyncioTestCase):
    def _mem(self, content: str, embedding=None) -> SimpleNamespace:
        return SimpleNamespace(id=uuid.uuid4(), content=content, embedding=embedding)

    async def test_writes_vectors_without_touching_updated_at(self):
        a, b, done, empty = self._mem("a" * 900), self._mem("b"), self._mem("c", vec((1, 1))), self._mem("  ")
        db = MagicMock()
        db.execute = AsyncMock(return_value=SimpleNamespace(rowcount=1))
        provider = AsyncMock(return_value=[vec((0, 1)), vec((2, 1))])
        with patch.object(mv, "_call_embedding_server", provider), patch.object(mv, "set_committed_value") as commit_value:
            n = await mv.embed_memories(db, [a, b, done, empty])
        self.assertEqual(n, 2)
        self.assertEqual(provider.await_args.args[0], ["a" * mv.EMBED_CHARS, "b"])
        sql = str(db.execute.await_args_list[0].args[0].compile(dialect=postgresql.dialect()))
        self.assertIn("updated_at=user_memories.updated_at", sql.replace(" ", ""))
        self.assertIn("user_memories.content =", sql)  # not over an edit made meanwhile
        self.assertEqual([c.args[0] for c in commit_value.call_args_list], [a, b])

    async def test_provider_down_writes_nothing(self):
        db = MagicMock()
        db.execute = AsyncMock()
        with patch.object(mv, "_call_embedding_server", AsyncMock(return_value=None)):
            self.assertEqual(await mv.embed_memories(db, [self._mem("a")]), 0)
        db.execute.assert_not_awaited()

    async def test_edited_meanwhile_is_left_for_the_next_pass(self):
        mem = self._mem("a")
        db = MagicMock()
        db.execute = AsyncMock(return_value=SimpleNamespace(rowcount=0))
        with patch.object(mv, "_call_embedding_server", AsyncMock(return_value=[vec((0, 1))])), \
                patch.object(mv, "set_committed_value") as commit_value:
            self.assertEqual(await mv.embed_memories(db, [mem]), 0)
        commit_value.assert_not_called()


class ClosestFirstTests(unittest.IsolatedAsyncioTestCase):
    async def test_closest_ones_come_before_the_most_recent_and_the_cap_holds(self):
        user = SimpleNamespace(id=uuid.uuid4())
        new = [SimpleNamespace(id=uuid.uuid4(), category="pitfall", embedding=vec((0, 1))),
               SimpleNamespace(id=uuid.uuid4(), category="pitfall", embedding=None)]
        near = SimpleNamespace(id=uuid.uuid4())
        recent = [SimpleNamespace(id=uuid.uuid4()) for _ in range(ml.EXISTING_PER_CALL + 5)]
        nearest = AsyncMock(return_value=[near, recent[3]])
        with patch.object(ml, "nearest_memories", nearest):
            old = await ml._closest_first(MagicMock(), user, new, recent)
        self.assertEqual(old[:2], [near, recent[3]])
        self.assertEqual(old[2:5], [recent[0], recent[1], recent[2]])
        self.assertEqual(len(old), ml.EXISTING_PER_CALL)
        self.assertEqual(nearest.await_count, 1)  # the one without a vector isn't searched
        self.assertEqual(nearest.await_args.kwargs["categories"], ("pitfall",))
        self.assertEqual(set(nearest.await_args.kwargs["exclude"]), {m.id for m in new})

    def test_rules_and_preferences_are_searched_together(self):
        self.assertEqual(ml._related_categories(SimpleNamespace(category="preference")), ml.ALWAYS_ON)
        self.assertEqual(ml._related_categories(SimpleNamespace(category="project")), ("project",))


class HitAgainTests(unittest.TestCase):
    def test_merged_duplicates_count_for_the_one_kept_once_per_session(self):
        keep, dup, old, gone = (str(uuid.uuid4()) for _ in range(4))
        in_force = {keep: (keep, "K"), dup: (keep, "K"), old: (keep, "K")}
        self.assertEqual(rs.pitfalls_hit_again({"pitfalls_seen": [old]}, in_force), [keep])
        self.assertEqual(rs.pitfalls_hit_again({"pitfalls_added": [dup]}, in_force), [keep])
        self.assertEqual(rs.pitfalls_hit_again({"pitfalls_added": [keep]}, in_force), [])  # recorded for the first time
        self.assertEqual(rs.pitfalls_hit_again({"pitfalls_seen": [old, gone], "pitfalls_added": [dup]}, in_force), [keep])
        self.assertEqual(rs.pitfalls_hit_again({"pitfalls_seen": "p3"}, in_force), [])
        self.assertEqual(rs.pitfalls_hit_again(None, in_force), [])


@unittest.skipUnless(DB_URL, "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class MemoryVectorDatabaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base

        self.engine = create_async_engine(DB_URL)
        async with self.engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
            await conn.run_sync(Base.metadata.drop_all)
            await conn.run_sync(Base.metadata.create_all)
        self.Session = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self) -> None:
        from server.db.models import Base

        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await self.engine.dispose()

    async def _users(self, db):
        user, other = User(email="owner@example.com", role="owner", status="active"), User(email="b@example.com", status="active")
        db.add_all([user, other])
        await db.flush()
        return user, other

    def _memory(self, db, owner, content, *, category="pitfall", status="active", embedding=None, folder="memento",
                is_folder=False, updated_at=None):
        mem = UserMemory(user_id=owner.id, category=category, key=str(uuid.uuid4()), content=content, source="outcome",
                         status=status, embedding=embedding, is_folder=is_folder,
                         tree_path=f"/{category}/{folder}/{uuid.uuid4().hex[:8]}")
        if updated_at is not None:
            mem.created_at = mem.updated_at = updated_at
        db.add(mem)
        return mem

    async def test_backfill_embeds_active_memories_without_a_vector_and_keeps_updated_at(self):
        from sqlalchemy import select

        long_ago = datetime(2026, 10, 11, tzinfo=timezone.utc)
        async with self.Session() as db:
            user, _ = await self._users(db)
            todo = self._memory(db, user, PYTEST_OLD, updated_at=long_ago)
            has = self._memory(db, user, "已有向量", embedding=vec((5, 1)))
            asleep = self._memory(db, user, "没人用", status="dormant")
            folder = self._memory(db, user, "文件夹", is_folder=True)
            await db.commit()
            with patch.object(mv, "_call_embedding_server", AsyncMock(side_effect=lambda texts, timeout: [vec((0, 1)) for _ in texts])):
                out = await mv.backfill_memory_vectors(db)
            self.assertEqual(out, {"missing": 1, "embedded": 1})
        async with self.Session() as db:
            rows = {m.id: m for m in (await db.execute(select(UserMemory))).scalars().all()}
        self.assertIsNotNone(rows[todo.id].embedding)
        self.assertEqual(rows[todo.id].updated_at, long_ago)
        self.assertIsNone(rows[asleep.id].embedding)
        self.assertIsNone(rows[folder.id].embedding)
        self.assertIsNotNone(rows[has.id].embedding)

    async def test_nearest_keeps_to_the_user_category_status_and_threshold(self):
        async with self.Session() as db:
            user, other = await self._users(db)
            close = self._memory(db, user, "a", embedding=vec((0, 0.95), (1, 0.31)))
            closer = self._memory(db, user, "b", embedding=vec((0, 1)))
            self._memory(db, user, "far", embedding=vec((0, 0.5), (1, 0.87)))
            self._memory(db, user, "rule", category="rule", embedding=vec((0, 1)))
            self._memory(db, user, "asleep", status="dormant", embedding=vec((0, 1)))
            self._memory(db, other, "theirs", embedding=vec((0, 1)))
            itself = self._memory(db, user, "self", embedding=vec((0, 1)))
            await db.commit()
            found = await mv.nearest_memories(db, user.id, vec((0, 1)), categories=("pitfall",), exclude=[itself.id])
        self.assertEqual([m.id for m in found], [closer.id, close.id])

    async def test_reconcile_merges_a_reworded_pitfall_from_beyond_the_recent_window(self):
        now = datetime.now(timezone.utc)
        async with self.Session() as db:
            user, _ = await self._users(db)
            # the stored ones got their vectors from the backfill pass; the new one gets its own here
            old = self._memory(db, user, PYTEST_OLD, embedding=vec((0, 1), (1, 0.2)), updated_at=now - timedelta(days=29))
            for n in range(ml.EXISTING_PER_CALL + 10):  # fills the recent window of the group
                self._memory(db, user, _pit(f"无关的坑 {n}"), embedding=vec((7 + n % 50, 1)),
                             updated_at=now - timedelta(days=2, minutes=n))
            new = self._memory(db, user, PYTEST_NEW, updated_at=now - timedelta(hours=3))
            amp_old = self._memory(db, user, AMP_OLD, folder="webrtc-desktop", embedding=vec((1, 1)),
                                   updated_at=now - timedelta(days=40))
            await db.commit()

            def provider(texts, timeout):
                self.assertEqual(texts, [PYTEST_NEW])
                return [vec((0, 1))]

            judged = []

            async def judge(new_items, old_items):
                judged.append((list(new_items), list(old_items)))
                refs = {**{f"N{n}": m for n, m in enumerate(new_items, 1)}, **{f"E{n}": m for n, m in enumerate(old_items, 1)}}
                ref = {m.id: r for r, m in refs.items()}
                actions = []
                if new.id in ref and old.id in ref:
                    actions.append({"type": "duplicate", "keep": ref[old.id], "drop": [ref[new.id]], "reason": "同一个坑"})
                return actions, refs

            with patch.object(mv, "_call_embedding_server", AsyncMock(side_effect=provider)), \
                    patch.object(ml, "_judge", judge), patch.object(ml, "_sync_profile", AsyncMock(return_value=False)):
                out = await ml.reconcile(db, user, now - timedelta(days=1))
            await db.refresh(new)
            await db.refresh(old)

        self.assertEqual(out["superseded"], 1)
        self.assertEqual(new.status, "superseded")
        self.assertEqual(new.superseded_by, old.id)
        self.assertEqual(old.status, "active")
        group_new, group_old = judged[0]
        self.assertEqual([m.id for m in group_new], [new.id])
        self.assertEqual(group_old[0].id, old.id)  # closest first, though 90 others were touched more recently
        self.assertNotIn(amp_old.id, [m.id for m in group_old])  # not close: not pulled in from another project
        self.assertEqual(len(group_old), ml.EXISTING_PER_CALL)

    async def test_device_hits_follow_merges(self):
        from server.db.models import Document, Machine, SessionReview, Tool

        now = datetime.now(timezone.utc)
        async with self.Session() as db:
            user, _ = await self._users(db)
            db.add(Tool(id="claude_code", display_name="Claude Code"))
            mac = Machine(name="mac", collector_token_hash="dev-mac", user_id=user.id)
            db.add(mac)
            await db.flush()
            keep = self._memory(db, user, PYTEST_OLD)
            await db.flush()
            dup = self._memory(db, user, PYTEST_NEW, status="superseded")
            dup.superseded_by = keep.id
            await db.flush()
            dup2 = self._memory(db, user, _pit("pytest 命令找不到", "command not found: pytest"), status="superseded")
            dup2.superseded_by = dup.id  # merged into one that was merged later
            await db.flush()
            sessions = [
                {"pitfalls_seen": [str(dup.id)]},
                {"pitfalls_added": [str(dup2.id)]},
                {"pitfalls_added": [str(keep.id)]},  # where it was first recorded: not "again"
                {"pitfalls_seen": [str(keep.id)], "pitfalls_added": [str(dup.id)]},
            ]
            for n, result in enumerate(sessions):
                doc = Document(machine_id=mac.id, tool_id="claude_code", category="conversation", content_type="jsonl",
                               relative_path=f"s{n}.jsonl", content_hash=f"h{n}", file_size_bytes=1)
                db.add(doc)
                await db.flush()
                db.add(SessionReview(document_id=doc.id, user_id=user.id, outcome="done", result=result,
                                     reviewed_at=now - timedelta(days=n + 1)))
            await db.commit()
            with patch.object(rs, "cache_get", AsyncMock(return_value=None)), patch.object(rs, "cache_set", AsyncMock()):
                found = await rs.device_pitfalls(db, user)
                stats = await rs.review_stats(db, user, days=7)
        self.assertEqual([(p["id"], p["hits"]) for p in found[str(mac.id)]], [(str(keep.id), 3)])
        self.assertEqual(found[str(mac.id)][0]["content"], PYTEST_OLD)
        self.assertEqual(stats["pitfall_repeats"], 3)


PYTEST_OLD = _pit("macOS 上找不到 pytest 命令", "zsh:1: command not found: pytest", "用 .venv/bin/pytest")
PYTEST_NEW = _pit("pytest 不在 PATH 导致测试命令找不到", "which pytest 找不到", "改用 ./server/.venv/bin/pytest")
AMP_OLD = _pit("PowerShell 里用 & 串联命令报 ParserError", "ParserError: AmpersandNotAllowed", "改用 ;", "webrtc-desktop")


if __name__ == "__main__":
    unittest.main()
