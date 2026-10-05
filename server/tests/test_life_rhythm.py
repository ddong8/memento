import unittest
import uuid
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

from server.db.models import User, UserLifeRhythm
from server.services import life_service


class TestLifeRhythmService(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.user = User(id=uuid.uuid4(), email="dev@example.com")
        self.db = AsyncMock()
        self.db.add = MagicMock()
        self.db.commit = AsyncMock()
        self.db.refresh = AsyncMock()

    def test_classify_app(self):
        self.assertEqual(life_service.classify_app("Cursor"), "work")
        self.assertEqual(life_service.classify_app("Claude Code"), "work")
        self.assertEqual(life_service.classify_app("Visual Studio Code"), "work")
        self.assertEqual(life_service.classify_app("微信"), "social")
        self.assertEqual(life_service.classify_app("哔哩哔哩"), "entertainment")
        self.assertEqual(life_service.classify_app("微信读书"), "reading")

    async def test_record_daily_rhythm_sleep_hours_cross_midnight(self):
        # Bedtime 01:30, Wakeup 08:30 -> 7.0 hours
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        self.db.execute.return_value = mock_result

        rec = await life_service.record_daily_rhythm(
            db=self.db,
            user=self.user,
            log_date=date(2026, 10, 5),
            app_usages=[{"name": "Claude Code", "minutes": 120}],
            wakeup_time="08:30",
            bedtime="01:30",
        )

        self.db.add.assert_called_once()
        added = self.db.add.call_args[0][0]
        self.assertIsInstance(added, UserLifeRhythm)
        self.assertEqual(added.sleep_hours, 7.0)
        self.assertEqual(added.productive_minutes, 120)

    @patch("server.services.user_filter.user_machine_ids", AsyncMock(return_value=["test-mid"]))
    async def test_sync_rhythms_from_collector_slicing(self):
        # Simulate 2 messages in Cursor spaced by 10 minutes (single session of 10 min, capped at base 15 min)
        # and 1 message in Claude Code 2 hours later (new session of 15 min)
        # Local time UTC+8: 2026-10-05 09:00:00 local is 2026-10-05 01:00:00 UTC
        utc_t1 = datetime(2026, 10, 5, 1, 0, 0, tzinfo=timezone.utc)
        utc_t2 = datetime(2026, 10, 5, 1, 10, 0, tzinfo=timezone.utc)
        utc_t3 = datetime(2026, 10, 5, 3, 0, 0, tzinfo=timezone.utc)

        msg_result = MagicMock()
        msg_result.all.return_value = [
            (utc_t1, "cursor"),
            (utc_t2, "cursor"),
            (utc_t3, "claude-code"),
        ]

        doc_result = MagicMock()
        doc_result.all.return_value = []

        mock_existing = MagicMock()
        mock_existing.scalar_one_or_none.return_value = None

        self.db.execute.side_effect = [
            msg_result,
            doc_result,
            mock_existing,
        ]

        synced = await life_service.sync_rhythms_from_collector(
            db=self.db,
            user=self.user,
            days=1,
            tz_offset=-480,  # UTC+8
        )

        self.assertTrue(len(synced) >= 1)
        self.assertEqual(synced[0].wakeup_time, "09:00")
        self.assertEqual(synced[0].bedtime, "11:00")
