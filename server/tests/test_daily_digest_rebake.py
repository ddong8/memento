"""Re-baking a day's report at 03:30 keeps the 23:30 one when the model can't be reached for some
conversations, instead of merging their first 300 characters over it."""

from datetime import date, datetime, timezone
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

DAY = date(2026, 11, 8)
LONG = "需求与实现细节 " * 60


class TestRequireComplete(unittest.IsolatedAsyncioTestCase):
    async def run_summary(self, replies, **kw):
        from server.services.ai_summary_service import generate_daily_summary_from_digests

        convs = [{"tool_id": "claude_code", "title": f"c{i}", "digest": LONG} for i in range(len(replies) - 1)]
        with patch("server.services.ai_summary_service.get_ai_providers", return_value=[object()]), \
             patch("server.services.ai_summary_service._call_ai", new_callable=AsyncMock, side_effect=replies) as ai:
            return await generate_daily_summary_from_digests(DAY, convs, **kw), ai

    async def test_a_failed_conversation_keeps_the_existing_report(self):
        out, ai = await self.run_summary(["摘要一", None, "日报"], require_complete=True)
        self.assertIsNone(out)
        self.assertEqual(ai.await_count, 2)  # no merge

    async def test_without_a_report_yet_the_partial_one_is_better_than_none(self):
        out, ai = await self.run_summary(["摘要一", None, "日报"])
        self.assertEqual(out, "日报")
        merge_prompt = ai.await_args_list[-1].args[0][1]["content"]
        self.assertIn(LONG[:300], merge_prompt)

    async def test_all_summaries_ok_regenerates(self):
        out, _ = await self.run_summary(["摘要一", "摘要二", "日报"], require_complete=True)
        self.assertEqual(out, "日报")


class TestNightlyTask(unittest.IsolatedAsyncioTestCase):
    async def run_task(self, existing):
        from server.tasks import daily_digest

        doc_id = uuid.uuid4()
        user = SimpleNamespace(id=uuid.uuid4())
        msg = SimpleNamespace(document_id=doc_id, role="user", content=LONG,
                              timestamp=datetime(2026, 11, 8, 10, tzinfo=timezone.utc))
        doc = SimpleNamespace(id=doc_id, tool_id="claude_code", title="t")

        def result(items=(), one=None):
            res = MagicMock()
            res.scalars.return_value.all.return_value = list(items)
            res.scalar_one_or_none.return_value = one
            return res

        db = AsyncMock()
        db.add = MagicMock()
        db.execute.side_effect = [result([user]), result([msg]), result([doc]), result(one=existing)]
        session = MagicMock()
        session.__aenter__ = AsyncMock(return_value=db)
        session.__aexit__ = AsyncMock(return_value=False)
        gen = AsyncMock(return_value=None)
        with patch.object(daily_digest, "async_session_factory", return_value=session), \
             patch.object(daily_digest, "user_machine_ids", new_callable=AsyncMock, return_value=None), \
             patch.object(daily_digest, "generate_daily_summary_from_digests", gen):
            self.pending = await daily_digest._generate_digest(DAY)
        self.user = user
        return gen, db

    async def test_rebake_over_an_existing_report_requires_every_summary(self):
        existing = SimpleNamespace(summary="23:30 的日报")
        gen, db = await self.run_task(existing)
        self.assertTrue(gen.await_args.kwargs["require_complete"])
        self.assertEqual(existing.summary, "23:30 的日报")
        db.commit.assert_not_awaited()
        self.assertEqual(self.pending, [str(self.user.id)])

    async def test_first_bake_takes_what_it_gets(self):
        gen, _ = await self.run_task(None)
        self.assertFalse(gen.await_args.kwargs["require_complete"])


class TestRetryLater(unittest.TestCase):
    def run_task(self, pending, **kw):
        from server.tasks import daily_digest

        with patch.object(daily_digest, "_generate_digest", new_callable=AsyncMock, return_value=pending) as gen, \
             patch.object(daily_digest.generate_daily_digest, "apply_async") as later:
            daily_digest.generate_daily_digest.run(**kw)
        return gen, later

    def test_users_whose_report_wasnt_written_are_tried_again(self):
        gen, later = self.run_task(["u1"], date_str="2026-11-08")
        self.assertEqual(gen.await_args.args, (DAY, None))
        later.assert_called_once_with(
            kwargs={"date_str": "2026-11-08", "user_ids": ["u1"], "attempt": 1}, countdown=1800,
        )

    def test_retries_only_the_given_users_and_gives_up_after_the_last(self):
        gen, later = self.run_task(["u1"], date_str="2026-11-08", user_ids=["u1"], attempt=3)
        self.assertEqual(gen.await_args.args, (DAY, ["u1"]))
        later.assert_not_called()

    def test_nothing_to_retry(self):
        _, later = self.run_task([], date_str="2026-11-08")
        later.assert_not_called()


if __name__ == "__main__":
    unittest.main()
