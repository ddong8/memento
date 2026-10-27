from __future__ import annotations

import json
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

from server.db.models import Document, KnowledgeEntity, KnowledgeObservation, User, UserMemory  # noqa: E402
from server.services import entity_canon as ec  # noqa: E402
from server.services.entity_canon import EntityRow, is_gone, merge_class, norm_name, plan_merges, summary_update  # noqa: E402

NOW = datetime(2026, 10, 27, 19, tzinfo=timezone.utc)


def row(name: str, etype: str, summary: str | None = None, obs: int = 0, rel: int = 0, days_old: int = 30, **kw) -> EntityRow:
    return EntityRow(id=uuid.uuid4(), name=name, entity_type=etype, summary=summary,
                     created_at=NOW - timedelta(days=days_old), observations=obs, relations=rel, **kw)


class NamingTests(unittest.TestCase):
    def test_case_spaces_and_hyphens_are_one_name(self) -> None:
        self.assertEqual(norm_name(" Memento-Server "), norm_name("memento_server"))
        self.assertEqual(norm_name("Claude Code"), "claudecode")
        self.assertEqual(merge_class("tool"), merge_class("project"))
        self.assertNotEqual(merge_class("Person"), merge_class("tool"))

    def test_gone_summaries(self) -> None:
        self.assertTrue(is_gone("本地 AI 记忆桌面应用，已彻底卸载"))
        self.assertTrue(is_gone("旧版采集端，已被 TS 版取代"))
        self.assertTrue(is_gone("不再使用"))
        self.assertFalse(is_gone("多端 AI 记忆/知识管理项目"))
        self.assertFalse(is_gone(None))


class SummaryTests(unittest.TestCase):
    def test_one_conversations_removal_does_not_rewrite_the_entity(self) -> None:
        self.assertIsNone(summary_update("多端 AI 记忆项目", "本地 AI 记忆桌面应用，包含多个客户端集成，已彻底卸载"))

    def test_in_use_again_replaces_a_gone_or_stale_summary(self) -> None:
        self.assertEqual(summary_update("已卸载", "记忆项目"), "记忆项目")
        self.assertEqual(summary_update("一个很长很长的项目描述", "短描述", old_stale=True), "短描述")

    def test_otherwise_the_longer_one(self) -> None:
        self.assertEqual(summary_update(None, "新描述"), "新描述")
        self.assertEqual(summary_update("短", "更长的描述"), "更长的描述")
        self.assertIsNone(summary_update("更长的描述", "短"))
        self.assertIsNone(summary_update("同样", " 同样 "))
        self.assertIsNone(summary_update("已有", ""))


class PlanTests(unittest.TestCase):
    def test_memento_split_five_ways_becomes_the_project(self) -> None:
        project = row("Memento", "project", "多端 AI 记忆/知识管理项目", obs=530, rel=3060, days_old=60)
        tool = row("Memento", "tool", "本地 AI 记忆/同步桌面应用，已彻底卸载", obs=44, rel=26)
        lower = row("memento", "project", None, obs=21, rel=113)
        file_ = row("Memento", "file", "安装镜像重复挂载 6 次", obs=5, rel=1)
        concept = row("Memento", "concept", None, obs=1, rel=4, aliases=[{"id": "x", "name": "MEMENTO", "type": "concept"}])
        other = row("Fleet", "tool", "GitOps 部署", obs=3)
        plans = plan_merges([tool, lower, other, project, file_, concept], NOW)

        self.assertEqual(len(plans), 1)
        p = plans[0]
        self.assertIs(p.canonical, project)
        self.assertEqual([d.entity_type for d in p.duplicates], ["project", "tool", "file", "concept"])
        self.assertEqual(p.summary, "多端 AI 记忆/知识管理项目")
        self.assertFalse(p.clear_stale)
        merged = {(a["name"], a["type"]): a for a in p.aliases}
        self.assertIn("已彻底卸载", merged[("Memento", "tool")]["summary"])
        self.assertEqual(merged[("Memento", "tool")]["observations"], 44)
        # Aliases a merged row carried come along
        self.assertIn(("MEMENTO", "concept"), merged)

    def test_people_only_merge_with_people(self) -> None:
        plans = plan_merges([row("Claude", "person", obs=2), row("claude", "person"), row("Claude", "tool", obs=9)], NOW)
        self.assertEqual(len(plans), 1)
        self.assertEqual({plans[0].canonical.entity_type, *(d.entity_type for d in plans[0].duplicates)}, {"person"})

    def test_a_gone_or_stale_kept_summary_gives_way_to_a_current_one(self) -> None:
        keep = row("Hermes", "tool", "已被 Memento 取代", obs=9, stale_at=NOW)
        dup = row("hermes", "concept", "多智能体调度器", obs=1)
        p = plan_merges([keep, dup], NOW)[0]
        self.assertIs(p.canonical, keep)
        self.assertEqual(p.summary, "多智能体调度器")
        self.assertTrue(p.clear_stale)
        self.assertTrue(any(a.get("replaced_at") and a["summary"] == "已被 Memento 取代" for a in p.aliases))

    def test_ties_go_to_the_oldest(self) -> None:
        old, new = row("Redis", "tool", days_old=90), row("redis", "technology", days_old=1)
        self.assertIs(plan_merges([new, old], NOW)[0].canonical, old)


class FindTests(unittest.IsolatedAsyncioTestCase):
    async def test_lookup_uses_the_normalised_name_index_and_prefers_the_exact_row(self) -> None:
        captured = []
        exact = KnowledgeEntity(id=uuid.uuid4(), name="memento", entity_type="tool")
        other = KnowledgeEntity(id=uuid.uuid4(), name="Memento", entity_type="project")

        async def execute(stmt):
            captured.append(stmt)
            res = MagicMock()
            res.scalars.return_value.all.return_value = [other, exact]
            return res

        db = SimpleNamespace(execute=execute)
        self.assertIs(await ec.find_entity(db, uuid.uuid4(), "memento", "tool"), exact)
        self.assertIs(await ec.find_entity(db, uuid.uuid4(), "Memento", "concept"), other)
        sql = str(captured[0].compile(dialect=postgresql.dialect()))
        # Constants inline, exactly as idx_knowledge_entities_norm_name is written
        self.assertIn("regexp_replace(lower(knowledge_entities.name), '[-_\\s]+', '', 'g')", sql)
        self.assertIn("NOT IN", sql)
        self.assertIsNone(await ec.find_entity(db, uuid.uuid4(), " - ", "tool"))

        await ec.find_entity(db, uuid.uuid4(), "Alice", "Person")
        self.assertIn("lower(knowledge_entities.entity_type) = ", str(captured[-1].compile(dialect=postgresql.dialect())))


class Result:
    def __init__(self, rows=None, rowcount=0):
        self._rows, self.rowcount = rows or [], rowcount

    def all(self):
        return self._rows


class MergeTests(unittest.IsolatedAsyncioTestCase):
    async def test_moves_everything_then_deletes_and_records_aliases(self) -> None:
        project = row("Memento", "project", "多端 AI 记忆项目", obs=530, rel=3060)
        tool = row("Memento", "tool", "已彻底卸载", obs=44, rel=26)
        loaded = [(r.id, r.name, r.entity_type, r.summary, r.created_at, [], None, None, r.observations, r.relations)
                  for r in (project, tool)]
        calls: list[tuple[str, object]] = []

        async def execute(stmt, params=None):
            sql = str(stmt)
            calls.append((sql, params))
            if sql.lstrip().upper().startswith("SELECT"):
                return Result(loaded)
            return Result(rowcount=3)

        db = SimpleNamespace(execute=execute, flush=AsyncMock())
        stats = await ec.merge_duplicate_entities(db, uuid.uuid4(), now=NOW)

        db.flush.assert_awaited_once()
        self.assertEqual(stats["merged_entities"], 1)
        self.assertEqual(stats["cross_type"], 1)
        self.assertEqual(stats["merged_observations"], 3)
        sqls = [s for s, _ in calls]
        order = [next(i for i, s in enumerate(sqls) if key in s) for key in (
            "UPDATE knowledge_observations", "DELETE FROM knowledge_observations", "SET source_id", "SET target_id",
            "source_id = target_id", "DELETE FROM knowledge_entities", "SET aliases",
            "GROUP BY r.source_id, r.target_id, r.relation_type",
        )]
        self.assertEqual(order, sorted(order))
        self.assertEqual(calls[sqls.index(next(s for s in sqls if "DELETE FROM knowledge_entities" in s))][1], {"dups": [tool.id]})
        aliases_sql, upd = next((s, p) for s, p in calls if "SET aliases" in s)
        self.assertEqual(len(upd), 1)
        self.assertEqual(upd[0]["id"], project.id)
        self.assertEqual(upd[0]["summary"], "多端 AI 记忆项目")
        self.assertEqual(json.loads(upd[0]["aliases"])[0]["summary"], "已彻底卸载")
        self.assertIn("updated_at = updated_at", aliases_sql)
        self.assertEqual(stats["collapsed_edges"], 3)

    async def test_nothing_to_merge_still_collapses_parallel_edges(self) -> None:
        calls = []
        uid = uuid.uuid4()

        async def execute(stmt, params=None):
            calls.append((str(stmt), params))
            if str(stmt).lstrip().upper().startswith("SELECT"):
                return Result([(uuid.uuid4(), "Fleet", "tool", None, NOW, [], None, None, 1, 0)])
            return Result(rowcount=2)

        stats = await ec.merge_duplicate_entities(SimpleNamespace(execute=execute, flush=AsyncMock()), uid, now=NOW)
        self.assertEqual((stats["merged_entities"], stats["collapsed_edges"], len(calls)), (0, 2, 2))
        sql, params = calls[1]
        # The whole graph of this user, not only edges touching merged entities
        self.assertIn("WHERE e.user_id = :uid", sql)
        self.assertEqual(params, {"uid": uid})


class StaleTests(unittest.IsolatedAsyncioTestCase):
    async def test_gone_but_still_used_in_later_conversations(self) -> None:
        gone_doc, b, c = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        used, quiet = uuid.uuid4(), uuid.uuid4()
        t0 = NOW - timedelta(days=10)
        obs = [
            (used, gone_doc, "Memento 已彻底卸载", t0),
            (used, b, "Memento 部署到 k3s", t0 + timedelta(days=3)),
            (used, c, "Memento 桌面端发版", t0 + timedelta(days=5)),
            (used, c, "又一条", t0 + timedelta(days=6)),
            (quiet, gone_doc, "eln 已删除", t0),
            (quiet, b, "eln 当年的表结构", t0 + timedelta(days=3)),
            # Same day as the removal: not "later"
            (quiet, c, "eln 卸载前备份", t0 + timedelta(hours=5)),
        ]
        updates = []

        async def execute(stmt, params=None):
            sql = str(stmt)
            if sql.startswith("UPDATE"):
                updates.append(stmt)
                return Result()
            if "knowledge_observations" in sql:
                return Result(obs)
            return Result([(used, t0), (quiet, t0)])

        n = await ec.mark_stale_entities(SimpleNamespace(execute=execute), uuid.uuid4(), now=NOW)
        self.assertEqual(n, 1)
        compiled = updates[0].compile(dialect=postgresql.dialect())
        self.assertIn(used, compiled.params.values())
        self.assertIn("2 个对话", compiled.params["stale_reason"])
        self.assertIn("updated_at=knowledge_entities.updated_at", str(compiled))


class ExtractionTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_gone_summary_becomes_an_observation_of_that_conversation(self) -> None:
        from server.services import graph_service

        existing = KnowledgeEntity(id=uuid.uuid4(), name="Memento", entity_type="project", summary="多端 AI 记忆项目")
        doc = Document(id=uuid.uuid4(), category="memory", content="x", metadata_={}, knowledge_attempts=0)
        db = MagicMock()
        db.execute = AsyncMock()
        db.commit = AsyncMock()
        db.flush = AsyncMock()
        db.refresh = AsyncMock()
        llm = {"entities": [{"name": "memento", "type": "tool", "summary": "本地 AI 记忆桌面应用，已彻底卸载"}],
               "relations": [], "observations": []}
        with patch.object(graph_service, "_call_llm", AsyncMock(return_value=llm)), \
             patch.object(graph_service, "find_entity", AsyncMock(return_value=existing)):
            await graph_service._extract_and_store(db, doc, "p", "h", uuid.uuid4(), None)

        self.assertEqual(existing.summary, "多端 AI 记忆项目")
        added = [c.args[0] for c in db.add.call_args_list]
        self.assertEqual([(o.entity_id, o.content, o.source_document_id) for o in added if isinstance(o, KnowledgeObservation)],
                         [(existing.id, "本地 AI 记忆桌面应用，已彻底卸载", doc.id)])

    async def test_a_current_summary_clears_stale(self) -> None:
        from server.services import graph_service

        existing = KnowledgeEntity(id=uuid.uuid4(), name="Hermes", entity_type="tool", summary="已被取代",
                                   stale_at=NOW, stale_reason="x")
        doc = Document(id=uuid.uuid4(), category="memory", content="x", metadata_={}, knowledge_attempts=0)
        db = MagicMock(execute=AsyncMock(), commit=AsyncMock(), flush=AsyncMock(), refresh=AsyncMock())
        llm = {"entities": [{"name": "Hermes", "type": "tool", "summary": "调度器"}], "relations": [], "observations": []}
        with patch.object(graph_service, "_call_llm", AsyncMock(return_value=llm)), \
             patch.object(graph_service, "find_entity", AsyncMock(return_value=existing)):
            await graph_service._extract_and_store(db, doc, "p", "h", uuid.uuid4(), None)
        self.assertEqual((existing.summary, existing.stale_at, existing.stale_reason), ("调度器", None, None))


class PitfallRelevanceTests(unittest.IsolatedAsyncioTestCase):
    def _db(self, mems):
        res = MagicMock()
        res.scalars.return_value.all.return_value = mems
        return SimpleNamespace(execute=AsyncMock(return_value=res))

    def _mems(self, user):
        def m(key, content, category="pitfall", path="/pitfall/memento/x"):
            return UserMemory(id=uuid.uuid4(), user_id=user.id, key=key, category=category, tree_path=path,
                              content=content, status="active", is_folder=False)
        return [
            m("fleet_stalled", "Fleet 不部署：代理单出口，推送后一直不同步"),
            m("launchd_nas", "launchd 备份连不上 NAS：本地网络隐私权限"),
            m("verify_first", "完成前先验证，继续执行前先确认部署状态", category="rule"),
            m("release_tag", "发版 tag 必须等于 package.json 的 version"),
        ] + [m(f"misc_{i}", f"开始处理任务 {i}，部署完成后检查") for i in range(10)]

    async def test_generic_requests_inject_nothing(self) -> None:
        from server.services.mind_resonance_service import _fetch_pitfalls, pitfall_terms

        user = User(id=uuid.uuid4(), email="u@example.com")
        db = self._db(self._mems(user))
        for q in ("完成了吗", "继续", "开始吧", "全部完成了吗", "好的", "test", "部署到线上"):
            self.assertEqual(await _fetch_pitfalls(db, user, pitfall_terms(q), 4, target_project="memento"), [], q)
        self.assertEqual(await _fetch_pitfalls(db, user, [], 4), [])

    async def test_requests_naming_something_get_its_pitfalls(self) -> None:
        from server.services.mind_resonance_service import _fetch_pitfalls, pitfall_terms

        user = User(id=uuid.uuid4(), email="u@example.com")
        db = self._db(self._mems(user))
        out = await _fetch_pitfalls(db, user, pitfall_terms("fleet 卡住了，push 后不部署"), 4, target_project="memento")
        self.assertEqual([p["key"] for p in out], ["fleet_stalled"])
        out = await _fetch_pitfalls(db, user, pitfall_terms("launchd 备份连不上 NAS"), 4)
        self.assertEqual([p["key"] for p in out], ["launchd_nas"])

    def test_terms_drop_unsplit_chinese_phrases_and_filler(self) -> None:
        from server.services.mind_resonance_service import pitfall_terms, term_specificity

        terms = pitfall_terms("部署完了吗")
        self.assertNotIn("部署完了吗", terms)
        self.assertIn("部署", terms)
        self.assertEqual(term_specificity("完成"), 0.0)
        self.assertEqual(term_specificity("部署"), 0.5)
        self.assertEqual(term_specificity("fleet"), 1.0)
        self.assertEqual(term_specificity("test"), 0.0)
        self.assertEqual(term_specificity("吗"), 0.0)

    async def test_stale_summaries_are_not_injected(self) -> None:
        from server.services.mind_resonance_service import _fetch_graph_entities

        user = User(id=uuid.uuid4(), email="u@example.com")
        ent = KnowledgeEntity(id=uuid.uuid4(), user_id=user.id, name="Hermes", entity_type="tool",
                              summary="已被 Memento 取代", stale_at=NOW, updated_at=NOW)

        async def execute(stmt):
            res = MagicMock()
            res.scalars.return_value.all.return_value = [ent]
            res.all.return_value = []
            return res

        out = await _fetch_graph_entities(SimpleNamespace(execute=execute), user, ["hermes"], 4)
        self.assertEqual((out[0]["name"], out[0]["summary"]), ("Hermes", ""))


class DreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_merges_and_marks_in_savepoints_then_drops_caches(self) -> None:
        from server.services import dreaming_service

        class Nested:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

        locks = []

        async def execute(stmt, params=None):
            locks.append((str(stmt), params))
            return SimpleNamespace(scalar=lambda: True)

        db = SimpleNamespace(begin_nested=lambda: Nested(), execute=execute)
        with patch.object(ec, "merge_duplicate_entities", AsyncMock(return_value={"merged_entities": 4, "merged_observations": 9})), \
             patch.object(ec, "mark_stale_entities", AsyncMock(return_value=1)), \
             patch("server.services.cache.cache_delete_prefix", AsyncMock()) as bust:
            stats = await dreaming_service.deduplicate_and_merge_entities(db, "u1")
        self.assertEqual((stats["merged_entities"], stats["stale_entities"]), (4, 1))
        self.assertEqual({c.args[0] for c in bust.await_args_list}, {"memory:resonance:u1", "profile_injection:u1"})
        self.assertIn("pg_try_advisory_xact_lock", locks[0][0])
        self.assertEqual(locks[0][1], {"k": "graph-tidy:u1"})

    async def test_skips_while_another_tidy_holds_the_lock(self) -> None:
        from server.services import dreaming_service

        async def execute(stmt, params=None):
            return SimpleNamespace(scalar=lambda: False)

        merge = AsyncMock()
        with patch.object(ec, "merge_duplicate_entities", merge), patch.object(ec, "mark_stale_entities", AsyncMock()):
            stats = await dreaming_service.deduplicate_and_merge_entities(SimpleNamespace(execute=execute), "u1")
        merge.assert_not_awaited()
        self.assertEqual(stats["merged_entities"], 0)


if __name__ == "__main__":
    unittest.main()
