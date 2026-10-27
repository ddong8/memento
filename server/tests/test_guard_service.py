from __future__ import annotations

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

from server.db.models import Machine, User  # noqa: E402
from server.services import guard_service  # noqa: E402
from server.services.guard_service import event_rows, guard_enabled, guard_tools, set_status  # noqa: E402


def _user(settings: dict | None = None) -> User:
    return User(id=uuid.uuid4(), email="u@example.com", proactive_settings=settings or {})


def _machine(targets: list[str], status: dict | None = None) -> Machine:
    return Machine(id=uuid.uuid4(), name="mac", collector_token_hash="dev1", profile_targets=targets, profile_status=status or {})


class SwitchTests(unittest.TestCase):
    def test_on_by_default_and_follows_the_profile_targets(self) -> None:
        self.assertTrue(guard_enabled(_user()))
        m = _machine(["claude_code", "antigravity", "codex"])
        self.assertEqual(guard_tools(_user(), m), ["claude_code", "codex"])
        self.assertEqual(guard_tools(_user(), _machine(["workbuddy"])), [])

    def test_turned_off_removes_every_hook(self) -> None:
        u = _user({"completion_guard": False, "enabled": True})
        self.assertFalse(guard_enabled(u))
        self.assertEqual(guard_tools(u, _machine(["claude_code", "codex"])), [])


class EventTests(unittest.TestCase):
    def test_keeps_known_tools_and_outcomes_and_trims_text(self) -> None:
        u, m = _user(), _machine(["claude_code"])
        now = datetime.now(timezone.utc)
        rows = event_rows(u, m, [
            {"tool": "claude_code", "outcome": "no_evidence", "blocked": True, "claim": "已修复" * 200, "at": now.isoformat()},
            {"tool": "codex", "outcome": "verified", "followup": True, "check": "pytest -q", "at": "2020-01-01T00:00:00Z"},
            {"tool": "cursor", "outcome": "verified"},
            {"tool": "codex", "outcome": "no_claim"},
        ])
        self.assertEqual([r.tool for r in rows], ["claude_code", "codex"])
        self.assertEqual(len(rows[0].claim), 200)
        self.assertTrue(rows[0].blocked and not rows[0].followup)
        self.assertEqual(rows[0].said_at, now)
        # A clock years off is replaced by the time it arrived
        self.assertGreater(rows[1].said_at, now - timedelta(minutes=1))
        self.assertEqual(rows[1].machine_id, m.id)

    def test_at_most_fifty_per_request(self) -> None:
        rows = event_rows(_user(), _machine([]), [{"tool": "codex", "outcome": "verified"}] * 80)
        self.assertEqual(len(rows), 50)


class StatusTests(unittest.TestCase):
    def test_guard_status_sits_beside_the_profile_status(self) -> None:
        m = _machine(["codex"], {"version": 7, "results": {"codex": "unchanged"}})
        set_status(m, {"codex": "written", "codex_trust": "trusted", "junk": "x"})
        self.assertEqual(m.profile_status["version"], 7)
        self.assertEqual(m.profile_status["guards"]["results"], {"codex": "written", "codex_trust": "trusted"})


class InjectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_injection_carries_the_switch_and_report_keeps_guard_status(self) -> None:
        from server.api import profile as profile_api

        u = _user()
        m = _machine(["claude_code", "codex"], {"guards": {"results": {"codex": "written"}}})
        db = MagicMock()
        db.commit = AsyncMock()
        with patch.object(profile_api, "cache_get", AsyncMock(return_value=None)), \
             patch.object(profile_api, "cache_set", AsyncMock()), \
             patch.object(profile_api, "_owned_machine", AsyncMock(return_value=m)), \
             patch.object(profile_api, "get_published_profile", AsyncMock(return_value=None)):
            res = await profile_api.get_injection(x_device_id="dev1", db=db, user=u)
            self.assertEqual(res["guards"], {"completion_evidence": ["claude_code", "codex"]})

            u.proactive_settings = {"completion_guard": False}
            res = await profile_api.get_injection(x_device_id="dev1", db=db, user=u)
            self.assertEqual(res["guards"], {"completion_evidence": []})

        with patch.object(profile_api, "_owned_machine", AsyncMock(return_value=m)), \
             patch.object(profile_api, "_bust_user_profile_cache", AsyncMock()):
            await profile_api.report_injection(
                body=profile_api.InjectionReport(version=3, results={"codex": "written"}), x_device_id="dev1", db=db, user=u,
            )
        self.assertEqual(m.profile_status["version"], 3)
        self.assertEqual(m.profile_status["guards"], {"results": {"codex": "written"}})

    async def test_switch_keeps_other_settings_and_busts_the_injection_cache(self) -> None:
        from server.api import learning as learning_api

        u = _user({"morning_brief_time": "08:00"})
        db = MagicMock()
        db.commit = AsyncMock()
        with patch.object(learning_api, "cache_delete_prefix", AsyncMock()) as bust:
            res = await learning_api.set_guard(body=learning_api.GuardBody(enabled=False), db=db, user=u)
        self.assertEqual(res, {"enabled": False})
        self.assertEqual(u.proactive_settings, {"morning_brief_time": "08:00", "completion_guard": False})
        bust.assert_awaited_once_with(f"profile_injection:{u.id}")


class StatsTests(unittest.IsolatedAsyncioTestCase):
    async def test_stats_query_counts_first_stops_and_followups(self) -> None:
        captured = []

        async def execute(stmt):
            captured.append(stmt)
            return SimpleNamespace(one=lambda: SimpleNamespace(
                claims=10, verified=6, disclosed=1, blocked=3, followups=3,
                checked_after=2, disclosed_after=1, deploy_claims=4,
            ))

        db = SimpleNamespace(execute=execute)
        stats = await guard_service.guard_stats(db, uuid.uuid4(), datetime(2026, 10, 1, tzinfo=timezone.utc))
        self.assertEqual(stats["unchecked_rate"], 0.3)
        self.assertEqual(stats["checked_after"], 2)
        sql = str(captured[0].compile(dialect=postgresql.dialect()))
        self.assertIn("FILTER (WHERE guard_events.followup IS false)", sql)
        self.assertIn("guard_events.outcome != ", sql)


if __name__ == "__main__":
    unittest.main()
