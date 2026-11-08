"""Retrieval eval questions must quote the document that answers them."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.services import eval_service as es  # noqa: E402
from server.tasks import learning_tasks  # noqa: E402


def _doc(title: str, category: str = "note", summary: str | None = None):
    return SimpleNamespace(id=title, title=title, category=category, ai_summary=summary)


DEPLOY = ["用户：push 后迟迟不部署怎么办", "AI：把 gitrepo 的 forceSyncGeneration 加一，Fleet 会另起任务重新连接。"]
GOLD = ["用户：帮我看看黄金的实时价格", "AI：国际现货黄金 XAU/USD 约 4,615.40 美元/盎司。"]


class GroundingTests(unittest.TestCase):
    def test_quote_must_be_in_the_text_ignoring_whitespace(self) -> None:
        self.assertTrue(es._grounded("forceSyncGeneration 加一", DEPLOY))
        self.assertTrue(es._grounded("国际现货黄金XAU/USD约4,615.40", GOLD))
        self.assertFalse(es._grounded("把副本数改成 3", DEPLOY))
        self.assertFalse(es._grounded("加一", DEPLOY))  # too short to tell documents apart
        self.assertFalse(es._grounded("", DEPLOY))

    def test_a_scheduled_run_rebuilds_old_or_stale_sets(self) -> None:
        run = lambda cases, metrics: SimpleNamespace(cases=cases, metrics=metrics)  # noqa: E731
        self.assertTrue(es.needs_new_set(run(53, {"stale": 0})))  # v1, no quotes
        self.assertFalse(es.needs_new_set(run(50, {"grounded": True, "stale": 2})))
        self.assertTrue(es.needs_new_set(run(40, {"grounded": True, "stale": 10})))


class QuestionsForTests(unittest.IsolatedAsyncioTestCase):
    async def ask(self, answer: dict) -> dict:
        with patch("server.services.eval_service.call_plain_chat", new=AsyncMock(return_value=json.dumps(answer, ensure_ascii=False))) as chat:
            out = await es._questions_for([_doc("部署"), _doc("黄金", "conversation")], [DEPLOY, GOLD])
        self.prompt = chat.await_args.kwargs["messages"][1]["content"]
        return out

    async def test_keeps_quoted_questions_under_the_document_that_holds_the_quote(self) -> None:
        out = await self.ask({"questions": [
            # numbered after the wrong document: the quote says which one answers it
            {"n": 2, "q": "推送后 Fleet 一直不部署要怎么强制重新同步", "e": "把 gitrepo 的 forceSyncGeneration 加一"},
            {"n": 1, "q": "上次查的国际金价是多少美元一盎司", "e": "国际现货黄金 XAU/USD 约 4,615.40 美元/盎司"},
        ]})
        self.assertEqual(out, {
            1: ("推送后 Fleet 一直不部署要怎么强制重新同步", "把 gitrepo 的 forceSyncGeneration 加一"),
            2: ("上次查的国际金价是多少美元一盎司", "国际现货黄金 XAU/USD 约 4,615.40 美元/盎司"),
        })
        self.assertIn("原文：\n用户：push 后迟迟不部署怎么办", self.prompt)

    async def test_drops_questions_without_a_real_quote(self) -> None:
        out = await self.ask({"questions": [
            {"n": 1, "q": "那次会话用的是什么模型和 CLI 版本", "e": "模型是 gpt-5，CLI 版本 0.4"},
            {"n": 2, "q": "上次查的国际金价是多少美元一盎司"},
            {"n": 1, "q": None, "e": None},
            "not an object",
        ]})
        self.assertEqual(out, {})


class PassagesTests(unittest.IsolatedAsyncioTestCase):
    async def test_conversations_show_their_dialogue_not_the_raw_log(self) -> None:
        db = AsyncMock()
        db.execute.return_value = SimpleNamespace(all=lambda: [
            ("user", "帮我看看黄金的实时价格"),
            ("assistant", "[AI 思考过程]"),
            ("assistant", "国际现货黄金约 4,615.40 美元/盎司"),
        ])
        parts = await es._passages(db, _doc("黄金", "conversation"))
        self.assertEqual(parts, ["用户：帮我看看黄金的实时价格", "AI：国际现货黄金约 4,615.40 美元/盎司"])

    async def test_notes_still_quote_their_content(self) -> None:
        self.assertTrue(await es.answer_still_there(None, "d", "note", "部署前\n先备份数据库", "先备份 数据库"))
        self.assertFalse(await es.answer_still_there(None, "d", "note", "改成了先发 UAT", "先备份数据库"))


class ScheduledEvalTests(unittest.IsolatedAsyncioTestCase):
    async def run_task(self, run_eval: AsyncMock, build_set: AsyncMock) -> dict:
        session = AsyncMock()
        factory = unittest.mock.MagicMock()
        factory.return_value.__aenter__.return_value = session
        with patch.object(learning_tasks, "async_session_factory", factory), \
                patch.object(learning_tasks, "_users", AsyncMock(return_value=[SimpleNamespace(id="u1")])), \
                patch.object(learning_tasks, "run_eval", run_eval), \
                patch.object(learning_tasks, "build_set", build_set), \
                patch.object(learning_tasks, "recent_runs", AsyncMock(return_value=[])), \
                patch.object(learning_tasks, "notify_user", AsyncMock()):
            return await learning_tasks._evaluate()

    async def test_a_user_without_documents_is_skipped_quietly(self) -> None:
        with self.assertNoLogs(level="WARNING"):
            out = await self.run_task(AsyncMock(side_effect=es.NoMaterial("还没有可出题的资料")), AsyncMock())
        self.assertEqual(out, {"u1": {"skipped": "no documents"}})

    async def test_an_old_set_is_replaced_and_the_new_one_scored(self) -> None:
        old = SimpleNamespace(set_version=1, cases=53, metrics={"hybrid": {"hit5": 0.5}, "stale": 0})
        new = SimpleNamespace(set_version=2, cases=48, metrics={"hybrid": {"hit5": 0.7}, "grounded": True, "stale": 0})
        run_eval = AsyncMock(side_effect=[old, new])
        build_set = AsyncMock(return_value={"set_version": 2, "cases": 48})
        out = await self.run_task(run_eval, build_set)
        self.assertEqual(out, {"u1": {"set_version": 2, "hybrid": {"hit5": 0.7}}})
        self.assertEqual(run_eval.await_args.kwargs["set_version"], 2)


if __name__ == "__main__":
    unittest.main()
