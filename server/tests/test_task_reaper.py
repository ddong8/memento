"""Which open device tasks the reaper closes, and which it leaves for a result still on its way."""

from datetime import datetime, timedelta, timezone

from server.db.models import DeviceTask
from server.tasks.task_reaper import overdue

NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)


def _task(status: str, age: timedelta, timeout: int = 300, dispatched_after: timedelta | None = None) -> DeviceTask:
    created = NOW - age
    return DeviceTask(
        status=status,
        created_at=created,
        dispatched_at=created + dispatched_after if dispatched_after is not None else None,
        timeout_seconds=timeout,
    )


def test_running_task_closes_after_its_timeout_and_the_grace_period():
    assert overdue(_task("running", timedelta(minutes=50)), NOW) is None
    assert overdue(_task("running", timedelta(hours=1, minutes=10)), NOW)


def test_timeout_counts_from_dispatch_not_from_queueing():
    # Queued for 3 h, picked up 40 min ago with a 5 min budget: still inside the grace period
    t = _task("running", timedelta(hours=3), dispatched_after=timedelta(hours=2, minutes=20))
    assert overdue(t, NOW) is None


def test_long_agent_runs_keep_their_own_budget():
    assert overdue(_task("running", timedelta(hours=2), timeout=7200), NOW) is None
    assert overdue(_task("running", timedelta(hours=3, minutes=1), timeout=7200), NOW)


def test_open_ended_queued_and_background_tasks_get_a_day():
    for status, timeout in (("running", 0), ("queued", 300), ("still_running", 300)):
        assert overdue(_task(status, timedelta(hours=20), timeout=timeout), NOW) is None
        assert overdue(_task(status, timedelta(hours=26), timeout=timeout), NOW)


def test_naive_timestamps_from_the_database_are_utc():
    t = _task("running", timedelta(hours=2))
    t.created_at = t.created_at.replace(tzinfo=None)
    assert overdue(t, NOW)
