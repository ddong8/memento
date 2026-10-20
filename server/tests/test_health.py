from __future__ import annotations

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from server.services.ai_health import aggregate  # noqa: E402
from server.services.health_service import ai_failing, assess  # noqa: E402

NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)


def _stats(ok=0, fallback=0, failed=0, reasons=()):
    return {
        "available": True,
        "calls": {"total": ok + fallback + failed, "ok": ok, "fallback": fallback, "failed": failed},
        "reasons": [{"reason": r, "label": label, "count": 1} for r, label in reasons],
    }


def _dreaming(hours_ago=5, last_run=None):
    created = (NOW - timedelta(hours=hours_ago)).isoformat()
    return {"journals": [{"created_at": created}], "last_run": last_run}


PROFILE_OK = {"last_run": None, "devices": [{"name": "mac", "errors": []}]}
PIPELINE_OK = {"embedding_failed": 0, "knowledge_failed": 3}


class AggregateTests(unittest.TestCase):
    def test_folds_hourly_buckets(self) -> None:
        h1, h2 = NOW - timedelta(hours=1), NOW
        data = aggregate([
            (h1, {
                "calls:background:ok": "3",
                "calls:background:failed": "1",
                "model:primary_background|deepseek-v4.1-flash:ok": "3",
                "model:primary_background|deepseek-v4.1-flash:ms": "3000",
                "model:primary|glm-5.3:fail": "2",
                "reason:reasoning_exhausted": "2",
            }),
            (h2, {"calls:stream:fallback": "2", "model:oneapi_fallback|qwen3.8-27b:ok": "2", "reason:timeout": "1"}),
        ])
        self.assertEqual(data["calls"], {"total": 6, "ok": 3, "fallback": 2, "failed": 1})
        self.assertEqual(data["by_kind"]["background"], {"ok": 3, "fallback": 0, "failed": 1})
        first = data["models"][0]
        self.assertEqual((first["model"], first["ok"], first["avg_latency_ms"]), ("deepseek-v4.1-flash", 3, 1000))
        glm = next(m for m in data["models"] if m["model"] == "glm-5.3")
        self.assertEqual((glm["ok"], glm["failed"], glm["avg_latency_ms"]), (0, 2, None))
        self.assertEqual(data["reasons"][0]["label"], "思考耗尽额度")
        self.assertEqual([h["failed"] for h in data["hourly"]], [1, 0])

    def test_empty(self) -> None:
        self.assertEqual(aggregate([])["calls"]["total"], 0)


class AssessTests(unittest.TestCase):
    def test_healthy(self) -> None:
        self.assertEqual(assess(_stats(ok=50), _stats(ok=3), _dreaming(), PROFILE_OK, PIPELINE_OK, NOW), [])

    def test_failing_last_hour_is_an_error(self) -> None:
        last_hour = _stats(ok=5, failed=4, reasons=[("timeout", "超时")])
        self.assertTrue(ai_failing(last_hour))
        issues = assess(_stats(ok=40, failed=4), last_hour, _dreaming(), PROFILE_OK, PIPELINE_OK, NOW)
        self.assertEqual(issues[0]["level"], "error")
        self.assertIn("4/9", issues[0]["text"])
        self.assertIn("超时", issues[0]["text"])

    def test_a_few_failures_are_not_an_alert(self) -> None:
        self.assertFalse(ai_failing(_stats(ok=30, failed=2)))

    def test_heavy_fallback_warns(self) -> None:
        issues = assess(_stats(ok=10, fallback=10), _stats(ok=1), _dreaming(), PROFILE_OK, PIPELINE_OK, NOW)
        self.assertEqual([i["area"] for i in issues], ["ai"])

    def test_stale_or_failed_dreaming(self) -> None:
        issues = assess(_stats(ok=5), _stats(), _dreaming(hours_ago=40), PROFILE_OK, PIPELINE_OK, NOW)
        self.assertEqual(issues[0]["text"], "超过 30 小时没有新的做梦记录")
        run = {"ok": False, "error": "TimeoutError", "profile_status": "llm_failed"}
        issues = assess(_stats(ok=5), _stats(), _dreaming(last_run=run), PROFILE_OK, PIPELINE_OK, NOW)
        self.assertEqual([i["level"] for i in issues], ["error", "warn"])

    def test_profile_and_pipeline_problems(self) -> None:
        profile = {"last_run": {"status": "llm_failed"}, "devices": [{"name": "mac", "errors": ["codex"]}]}
        pipeline = {"embedding_failed": 25, "knowledge_failed": 40}
        areas = [i["area"] for i in assess(_stats(ok=5), _stats(), _dreaming(), profile, pipeline, NOW)]
        self.assertEqual(areas, ["profile", "profile", "pipeline", "pipeline"])


if __name__ == "__main__":
    unittest.main()
