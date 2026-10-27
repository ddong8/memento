from __future__ import annotations

import sys
import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from sqlalchemy.dialects import postgresql  # noqa: E402

from server.db.models import LearningEval, User  # noqa: E402
from server.services import learning_eval_service as le  # noqa: E402
from server.services.health_service import assess  # noqa: E402

CST = timezone(timedelta(hours=8))
WEEK = date(2026, 10, 19)  # a Monday
START, END = le.week_bounds(WEEK, CST)


def at(days: float) -> datetime:
    return START + timedelta(days=days)


class WeekTests(unittest.TestCase):
    def test_weeks_start_monday_in_local_time(self) -> None:
        # Sunday 23:30 in Shanghai is still that week; 16:30 UTC Sunday is Monday 00:30 there
        self.assertEqual(le.week_start(datetime(2026, 10, 25, 15, 30, tzinfo=timezone.utc), CST), WEEK)
        self.assertEqual(le.week_start(datetime(2026, 10, 25, 16, 30, tzinfo=timezone.utc), CST), date(2026, 10, 26))
        self.assertEqual(END - START, timedelta(days=7))
        self.assertEqual(START.utcoffset(), timedelta(hours=8))


class RuleMetricTests(unittest.TestCase):
    def test_before_and_after_acceptance_pooled_over_settled_rules(self) -> None:
        a, b, fresh, pending = uuid.uuid4(), uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        a_acc = at(-28)  # settled: said 4 times in the 2 weeks before, twice since (once this week)
        b_acc = at(-14)  # settled: said once before, never again
        rows = [
            *[(a, "交付前先自测", "accepted", a_acc, a_acc - timedelta(days=d)) for d in (14, 10, 5, 1)],
            (a, "交付前先自测", "accepted", a_acc, at(-10)),
            (a, "交付前先自测", "accepted", a_acc, at(2)),
            (b, "用中文回复", "accepted", b_acc, b_acc - timedelta(days=7)),
            # Accepted 3 days before the week ended: corrected again, but not settled yet
            (fresh, "界面要精致", "accepted", at(4), at(5)),
            (pending, "别反问", "pending", None, at(1)),
        ]
        m = le.rule_metrics(rows, START, END)
        self.assertEqual(m["week_corrections"], 3)
        self.assertEqual(m["week_on_accepted"], 2)  # a this week, and fresh after its acceptance
        self.assertEqual(m["rules"], 2)
        self.assertEqual(m["rules_never_again"], 1)
        # before: 5 events over 2 + 1 weeks; after: 2 events over 5 + 3 weeks
        self.assertEqual(m["before_per_rule_week"], round(5 / 3, 2))
        self.assertEqual(m["after_per_rule_week"], 0.25)
        self.assertEqual(m["week_per_rule"], 0.5)
        self.assertEqual([s["statement"] for s in m["stubborn"]], ["交付前先自测", "界面要精致"])

    def test_no_rules_no_rates(self) -> None:
        m = le.rule_metrics([], START, END)
        self.assertEqual((m["rules"], m["before_per_rule_week"], m["week_per_rule"]), (0, None, None))


def _week(monday: date, **metrics) -> LearningEval:
    return LearningEval(user_id=uuid.uuid4(), week=monday, metrics={"prompts": 200, **metrics})


class RegressionTests(unittest.TestCase):
    def weeks(self, *learned: float, rule: float = 0.05, on_accepted: int = 5) -> list[LearningEval]:
        # newest first
        return [
            _week(WEEK - timedelta(weeks=i), learned_per_100=v, week_per_rule=rule if i else rule, week_on_accepted=on_accepted)
            for i, v in enumerate(learned)
        ]

    def test_learned_repeats_well_above_the_recent_median(self) -> None:
        drop = le.regression(self.weeks(4.0, 1.5, 2.0, 1.0, 9.0))
        self.assertEqual(drop["metric"], "learned_per_100")
        self.assertEqual((drop["now"], drop["was"]), (4.0, 1.75))
        self.assertIn("每 100 次提问里有 4.0 次", le.regression_text(drop))

    def test_small_rises_and_quiet_weeks_stay_silent(self) -> None:
        self.assertIsNone(le.regression(self.weeks(2.2, 1.5, 2.0, 1.0)))  # +0.45 points only
        self.assertIsNone(le.regression(self.weeks(4.0, 1.5)))  # not enough history
        quiet = self.weeks(4.0, 1.5, 2.0, 1.0)
        quiet[0].metrics["prompts"] = 10
        self.assertIsNone(le.regression(quiet))

    def test_accepted_rules_corrected_more_often(self) -> None:
        weeks = self.weeks(1.0, 1.0, 1.0, 1.0)
        weeks[0].metrics["week_per_rule"] = 0.2
        drop = le.regression(weeks)
        self.assertEqual(drop["metric"], "week_per_rule")
        weeks[0].metrics["week_on_accepted"] = 2
        self.assertIsNone(le.regression(weeks))

    def test_health_page_warns(self) -> None:
        ok = {"available": True, "calls": {"total": 5, "ok": 5, "fallback": 0, "failed": 0}, "reasons": []}
        now = datetime(2026, 10, 27, 12, tzinfo=timezone.utc)
        dreaming = {"journals": [{"created_at": (now - timedelta(hours=3)).isoformat()}], "last_run": None}
        drop = {"metric": "learned_per_100", "now": 4.0, "was": 1.75, "week": "2026-10-19"}
        issues = assess(ok, ok, dreaming, {"last_run": None, "devices": []}, {"embedding_failed": 0, "knowledge_failed": 0},
                        now, None, {"outcomes": {"regression": drop}})
        self.assertEqual([i["area"] for i in issues], ["learning"])
        self.assertIn("学过还犯变多", issues[0]["text"])


class RunTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_run_backfills_then_rescores_recent_weeks(self) -> None:
        user = User(id=uuid.uuid4(), email="u@example.com", proactive_settings={})
        now = datetime(2026, 10, 27, 4, 50, tzinfo=CST)  # a Tuesday
        for have, n, trigger in ((0, le.BACKFILL_WEEKS, "backfill"), (9, le.RECOMPUTE_WEEKS, "scheduled")):
            db = AsyncMock()
            db.execute.return_value.scalar = lambda have=have: have
            with patch.object(le, "save_week", AsyncMock()) as save:
                weeks = await le.run_learning_eval(db, user, now=now)
            self.assertEqual(len(weeks), n)
            self.assertEqual(weeks[-1], date(2026, 10, 19))  # the last finished week, not this one
            self.assertEqual(save.await_args_list[-1].args[3], trigger)

    async def test_prompt_query_dedupes_real_user_messages(self) -> None:
        captured = []

        class Db:
            async def execute(self, stmt):
                captured.append(stmt)
                return type("R", (), {"scalar": lambda self: 7})()

        n = await le.count_prompts(Db(), uuid.uuid4(), START, END)
        self.assertEqual(n, 7)
        sql = str(captured[0].compile(dialect=postgresql.dialect()))
        self.assertIn("count(DISTINCT md5(left(conversation_messages.content", sql)
        self.assertIn("coalesce(conversation_messages.message_type", sql)
        self.assertIn("documents.metadata ?", sql)
        self.assertIn("parent_session_id", captured[0].compile().params.values())


if __name__ == "__main__":
    unittest.main()
