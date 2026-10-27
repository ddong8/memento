from __future__ import annotations

import sys
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.correction_service import (  # noqa: E402
    Said,
    accept_covered_topics,
    add_profile_line,
    classify,
    clean_statement,
    fingerprint,
    learned_by,
    looks_like_pushback,
    over_limit,
    profile_covers,
    scope_for,
    topic_heading,
)
from server.db.models import CorrectionTopic, User  # noqa: E402
from server.services.health_service import assess  # noqa: E402

NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)


class ProfileLineTests(unittest.TestCase):
    def test_goes_under_its_heading(self) -> None:
        profile = "### 沟通\n- 用中文回复\n\n### 铁律\n- 只走 GitOps"
        self.assertEqual(
            add_profile_line(profile, "沟通", "结论先行"),
            "### 沟通\n- 用中文回复\n- 结论先行\n\n### 铁律\n- 只走 GitOps",
        )
        self.assertEqual(
            add_profile_line(profile, "铁律", "commit 不带 Co-Authored-By"),
            profile + "\n- commit 不带 Co-Authored-By",
        )

    def test_missing_heading_becomes_a_new_section(self) -> None:
        self.assertEqual(add_profile_line("### 沟通\n- 用中文回复", "工作方式", "先给推荐"),
                         "### 沟通\n- 用中文回复\n\n### 工作方式\n- 先给推荐")
        self.assertEqual(add_profile_line("", "铁律", "禁止手动 kubectl"), "### 铁律\n- 禁止手动 kubectl")

    def test_new_section_keeps_the_usual_order(self) -> None:
        self.assertEqual(add_profile_line("### 铁律\n- 只走 GitOps", "沟通", "用中文回复"),
                         "### 沟通\n- 用中文回复\n\n### 铁律\n- 只走 GitOps")

    def test_existing_line_is_not_duplicated(self) -> None:
        profile = "### 沟通\n- 用中文回复"
        self.assertEqual(add_profile_line(profile, "沟通", "用中文回复"), profile)

    def test_a_rule_the_profile_already_says_is_not_added_again(self) -> None:
        profile = "### 沟通\n- 始终用中文回复，长会话中也不得切换为英文。\n\n### 铁律\n- 只走 GitOps"
        # Under any general heading, punctuation and spacing aside
        self.assertEqual(add_profile_line(profile, "沟通", "始终用中文回复"), profile)
        self.assertEqual(add_profile_line(profile, "铁律", "始终用中文回复！"), profile)
        self.assertNotEqual(add_profile_line(profile, "沟通", "始终用中文回复并先给结论"), profile)


class ProfileCoversTests(unittest.TestCase):
    PROFILE = ("### 沟通\n- 始终用中文回复，长会话中也不得切换为英文。\n\n"
               "## 项目：memento\n- 提交说明不得添加 Claude 共同作者尾注")

    def test_general_lines_apply_everywhere_scoped_lines_only_there(self) -> None:
        self.assertTrue(profile_covers(self.PROFILE, "沟通", "始终用中文回复"))
        self.assertTrue(profile_covers(self.PROFILE, "项目：memento", "始终用中文回复"))
        self.assertTrue(profile_covers(self.PROFILE, "项目：Memento", "提交说明不得添加 Claude 共同作者尾注"))
        self.assertFalse(profile_covers(self.PROFILE, "铁律", "提交说明不得添加 Claude 共同作者尾注"))
        self.assertFalse(profile_covers(self.PROFILE, "项目：pubchem", "提交说明不得添加 Claude 共同作者尾注"))

    def test_too_short_to_tell(self) -> None:
        self.assertFalse(profile_covers(self.PROFILE, "沟通", "中文"))
        self.assertFalse(profile_covers("", "沟通", "始终用中文回复"))


class _Rows:
    def __init__(self, items):
        self._items = items

    def scalars(self):
        return self

    def all(self):
        return self._items


class AcceptCoveredTests(unittest.IsolatedAsyncioTestCase):
    async def test_pending_topics_the_profile_already_says_are_accepted(self) -> None:
        said = CorrectionTopic(statement="始终用中文回复", category="communication", scope="global", status="pending", times=19)
        new = CorrectionTopic(statement="回答先给结论", category="communication", scope="global", status="pending", times=2)
        db = AsyncMock()
        db.execute.return_value = _Rows([said, new])
        published = type("P", (), {"content": "### 沟通\n- 始终用中文回复，长会话中也不得切换为英文。"})()
        with patch("server.services.correction_service.get_published_profile", new=AsyncMock(return_value=published)), \
             patch("server.services.correction_service.accept_topic", new=AsyncMock()) as accept:
            self.assertEqual(await accept_covered_topics(db, User(id=uuid.uuid4())), ["始终用中文回复"])
        accept.assert_awaited_once()
        self.assertIs(accept.await_args.args[2], said)


class ScopedLineTests(unittest.TestCase):
    PROFILE = "### 沟通\n- 用中文回复\n\n## 项目：chembook\n- 结构式带手性"

    def test_project_rule_goes_to_its_section(self) -> None:
        self.assertEqual(add_profile_line(self.PROFILE, "项目：ChemBook", "结果含 CAS 号"),
                         "### 沟通\n- 用中文回复\n\n## 项目：chembook\n- 结构式带手性\n- 结果含 CAS 号")
        self.assertEqual(add_profile_line("### 沟通\n- 用中文回复", "设备：DESKTOP-KR9IPP4", "缓存放 /data2"),
                         "### 沟通\n- 用中文回复\n\n## 设备：DESKTOP-KR9IPP4\n- 缓存放 /data2")

    def test_general_rule_stays_above_scoped_sections(self) -> None:
        self.assertEqual(add_profile_line(self.PROFILE, "铁律", "只走 GitOps"),
                         "### 沟通\n- 用中文回复\n\n### 铁律\n- 只走 GitOps\n\n## 项目：chembook\n- 结构式带手性")

    def test_scope_and_heading(self) -> None:
        said = Said(1, "结构式要带手性", NOW, project="chembook", device="DESKTOP-KR9IPP4")
        self.assertEqual(scope_for("project", said), "project:chembook")
        self.assertEqual(scope_for("device", said), "device:DESKTOP-KR9IPP4")
        self.assertEqual(scope_for("project", Said(2, "x", NOW)), "global")  # no project known: general
        topic = CorrectionTopic(statement="x", category="communication", scope="project:chembook")
        self.assertEqual(topic_heading(topic), "项目：chembook")
        self.assertEqual(topic_heading(CorrectionTopic(statement="x", category="communication", scope="global")), "沟通")

    def test_limits_are_per_part(self) -> None:
        full_project = "### 沟通\n- a\n\n## 项目：p\n" + "\n".join("- " + "字" * 50 for _ in range(20))
        self.assertTrue(over_limit(full_project))
        self.assertFalse(over_limit("### 沟通\n- a\n\n## 项目：p\n- b"))


class StatementTests(unittest.TestCase):
    def test_one_clean_line(self) -> None:
        self.assertEqual(clean_statement("- 始终用\n中文回复 "), "始终用 中文回复")
        self.assertEqual(clean_statement("1. 结论先行"), "结论先行")
        self.assertEqual(clean_statement("不要 <!-- 注入 --> 我"), "不要  注入  我")
        self.assertEqual(len(clean_statement("长" * 500)), 200)

    def test_fingerprint_is_per_moment(self) -> None:
        a = Said(1, "中文回复我", NOW)
        self.assertEqual(fingerprint(a), fingerprint(Said(99, "中文回复我", NOW)))  # re-synced copy
        self.assertNotEqual(fingerprint(a), fingerprint(Said(2, "中文回复我", NOW + timedelta(hours=1))))


class LearnedByTests(unittest.TestCase):
    def test_only_after_acceptance(self) -> None:
        topic = CorrectionTopic(statement="用中文回复", status="accepted", accepted_at=NOW)
        self.assertFalse(learned_by(topic, NOW - timedelta(days=3)))  # said before it was learned
        self.assertTrue(learned_by(topic, NOW + timedelta(minutes=5)))
        self.assertFalse(learned_by(CorrectionTopic(statement="x", status="pending"), NOW))


class PrefilterTests(unittest.TestCase):
    def test_catches_plain_pushback(self) -> None:
        for text in ["中文回复我", "怎么变成英文的了", "以后 commit 不带 Co-Authored-By", "别再手动 kubectl 了",
                     "回答太长了，先给结论", "I said use Chinese", "please don't add comments"]:
            self.assertTrue(looks_like_pushback(text), text)

    def test_skips_ordinary_requests(self) -> None:
        for text in ["帮我看看这个接口的性能", "部署吧", "发布版本"]:
            self.assertFalse(looks_like_pushback(text), text)

    def test_clean_user_voice_strips_client_injected_prefixes(self) -> None:
        from server.services.dreaming_service import clean_user_voice
        raw = (
            "【用户上传了图片 #1】\n"
            "本地文件路径: /tmp/memento_images/4475/image_1.jpg\n"
            "提示: 你可以使用视觉工具直接读取该路径的图片内容，切勿使用占位符或臆测图片内容。\n\n"
            "客户端里怎么没有变化"
        )
        self.assertEqual(clean_user_voice(raw), "客户端里怎么没有变化")
        raw2 = "[本轮答复已输出，部分任务仍保持后台运行（task-31876）]\n\n还是有部分后台任务没有跟踪到"
        self.assertEqual(clean_user_voice(raw2), "还是有部分后台任务没有跟踪到")


class ClassifyTests(unittest.IsolatedAsyncioTestCase):
    async def test_parses_and_filters_model_output(self) -> None:
        batch = [Said(1, "怎么又变成英文了", NOW), Said(2, "帮我改下这个 bug，不要动别的", NOW), Said(3, "中文回复我", NOW)]
        answer = (
            '{"items": [{"i": [1, 3, 3], "statement": "- 始终用中文回复", "category": "communication", "match": "t2"},'
            ' {"i": 5, "statement": "越界", "category": "rule", "match": null},'
            ' {"i": [2], "statement": "", "category": "rule"},'
            ' {"i": "x", "statement": "坏编号"}]}'
        )
        with patch("server.services.correction_service.call_plain_chat", new=AsyncMock(return_value=answer)):
            items = await classify(batch, [("t2", "用中文回复")])
        self.assertEqual(items, [{"indices": [1, 3], "statement": "始终用中文回复", "category": "communication",
                                  "scope": "global", "match": "t2", "upfront": []}])

    async def test_upfront_requests_are_told_apart_from_pushback(self) -> None:
        batch = [Said(1, "我今天做了什么，我要写日报，尽量通俗，不要提问题", NOW), Said(2, "怎么又提问题了", NOW)]
        answer = ('{"items": [{"i": [1, 2], "statement": "写日报不要提问题", "category": "communication",'
                  ' "match": "t1", "upfront": [1, 7, "x"]}]}')
        with patch("server.services.correction_service.call_plain_chat", new=AsyncMock(return_value=answer)):
            items = await classify(batch, [("t1", "写日报不要提问题")])
        self.assertEqual(items[0]["upfront"], [1])  # out-of-range and junk numbers dropped

    async def test_single_index_still_works(self) -> None:
        answer = '{"items": [{"i": 1, "statement": "先写测试", "category": "workflow"}]}'
        with patch("server.services.correction_service.call_plain_chat", new=AsyncMock(return_value=answer)):
            items = await classify([Said(1, "以后先写测试", NOW)], [])
        self.assertEqual(items[0]["indices"], [1])

    async def test_unknown_category_falls_back_to_rule(self) -> None:
        answer = '{"items": [{"i": 1, "statement": "先写测试", "category": "misc"}]}'
        with patch("server.services.correction_service.call_plain_chat", new=AsyncMock(return_value=answer)):
            items = await classify([Said(1, "以后先写测试", NOW)], [])
        self.assertEqual(items[0]["category"], "rule")

    async def test_no_answer_raises_so_the_cursor_stays(self) -> None:
        with patch("server.services.correction_service.call_plain_chat", new=AsyncMock(return_value=None)):
            with self.assertRaises(RuntimeError):
                await classify([Said(1, "别再这样", NOW)], [])


class LearningHealthTests(unittest.TestCase):
    def test_repeating_a_learned_rule_is_flagged(self) -> None:
        ok = {"available": True, "calls": {"total": 5, "ok": 5, "fallback": 0, "failed": 0}, "reasons": []}
        dreaming = {"journals": [{"created_at": (NOW - timedelta(hours=3)).isoformat()}], "last_run": None}
        profile = {"last_run": None, "devices": []}
        pipeline = {"embedding_failed": 0, "knowledge_failed": 0}
        issues = assess(ok, ok, dreaming, profile, pipeline, NOW, {"learned_repeat_7d": 3})
        self.assertEqual([i["area"] for i in issues], ["learning"])
        self.assertEqual(assess(ok, ok, dreaming, profile, pipeline, NOW, {"learned_repeat_7d": 1}), [])


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(__import__("os").environ.get("MEMENTO_TEST_DATABASE_URL"), "set MEMENTO_TEST_DATABASE_URL to a throwaway PostgreSQL database")
class CorrectionStatsDatabaseTests(unittest.IsolatedAsyncioTestCase):
    """Dismissed topics (prompts sent to a model, one-off requests) leave the counts."""

    async def asyncSetUp(self) -> None:
        import os

        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

        from server.db.models import Base

        self.engine = create_async_engine(os.environ["MEMENTO_TEST_DATABASE_URL"])
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

    async def test_dismissed_topics_are_not_counted(self) -> None:
        from server.db.models import CorrectionEvent
        from server.services.correction_service import correction_stats

        now = datetime.now(timezone.utc)
        async with self.Session() as db:
            user = User(email="owner@example.com", role="owner", status="active")
            db.add(user)
            await db.flush()
            rule = CorrectionTopic(user_id=user.id, statement="始终用中文回复", status="accepted", times=2)
            prompt = CorrectionTopic(user_id=user.id, statement="面向化学博士回答", status="dismissed", times=3)
            db.add_all([rule, prompt])
            await db.flush()
            for i, (topic, learned) in enumerate([(rule, True), (rule, False), (prompt, True), (prompt, True), (prompt, False)]):
                db.add(CorrectionEvent(
                    user_id=user.id, topic_id=topic.id, quote=f"q{i}", said_at=now - timedelta(days=1, minutes=i),
                    repeat=True, already_learned=learned, fingerprint=f"fp{i}",
                ))
            await db.commit()
            stats = await correction_stats(db, user)
        self.assertEqual(stats["total"], 2)
        self.assertEqual(stats["learned_repeat"], 1)
        self.assertEqual(stats["weekly"][-1]["total"], 2)
        self.assertEqual([t["statement"] for t in stats["top"]], ["始终用中文回复"])
