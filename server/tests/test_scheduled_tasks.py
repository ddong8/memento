"""Scheduled agent tasks: when the next run is (in the user's local time), what a run sends to the device, and
the result going into memory with a push."""

import asyncio
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from server.db.models import DeviceTask, ScheduledTask, UserMemory
from server.services import scheduled_tasks as svc

UTC = timezone.utc


def test_schedules_are_checked():
    for ok in ("hourly:5", "daily:09:30", "weekly:0:8:00", "weekly:6:23:59"):
        assert svc.valid_schedule(ok), ok
    for bad in ("daily:24:00", "hourly:60", "weekly:7:09:00", "every 5m", "daily:9"):
        assert not svc.valid_schedule(bad), bad


def test_next_run_in_the_users_time_zone():
    # 2026-11-27 01:00 UTC = 09:00 in UTC+8
    now = datetime(2026, 11, 27, 1, 0, tzinfo=UTC)
    assert svc.next_run("daily:09:30", 480, now) == datetime(2026, 11, 27, 1, 30, tzinfo=UTC)
    assert svc.next_run("daily:09:00", 480, now) == datetime(2026, 11, 28, 1, 0, tzinfo=UTC)  # strictly after
    assert svc.next_run("hourly:15", 480, now) == datetime(2026, 11, 27, 1, 15, tzinfo=UTC)
    # 2026-11-27 is a Friday (weekday 4); Monday 08:00 local is 2026-11-30 00:00 UTC
    assert svc.next_run("weekly:0:08:00", 480, now) == datetime(2026, 11, 30, 0, 0, tzinfo=UTC)
    assert svc.next_run("weekly:4:10:00", 480, now) == datetime(2026, 11, 27, 2, 0, tzinfo=UTC)


def _st(**kw):
    return ScheduledTask(id=uuid.uuid4(), user_id=uuid.uuid4(), title="每日依赖检查", device="mini", agent="claude",
                         prompt="检查 npm 依赖有没有安全更新", schedule="daily:09:00", tz_offset_min=480, permission_mode="full", **kw)


def test_a_run_is_an_ordinary_device_task_tagged_with_its_schedule():
    st = _st(cwd="/repo")
    action, payload = svc.task_payload(st)
    assert action == "agent"
    assert payload["binary"] == "claude" and payload["cwd"] == "/repo" and payload["scheduled_task_id"] == str(st.id)
    assert "permission_mode" not in payload
    st2 = _st()
    st2.agent, st2.permission_mode = "antigravity", "supervised"
    assert svc.task_payload(st2)[1]["binary"] == "agy" and svc.task_payload(st2)[1]["permission_mode"] == "supervised"
    st3 = _st()
    st3.agent = "shell"
    assert svc.task_payload(st3) == ("shell", {"command": st3.prompt, "scheduled_task_id": str(st3.id)})


def test_a_finished_run_goes_into_memory_and_to_the_phone():
    st = _st()
    added: list = []

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def execute(self, _q):
            class R:
                def scalar_one_or_none(self_inner):
                    return st
            return R()

        def add(self, obj):
            added.append(obj)

        async def commit(self):
            pass

    task = DeviceTask(id=uuid.uuid4(), action="agent", status="succeeded", stdout="有 2 个包需要更新：next、vite",
                      payload={"scheduled_task_id": str(st.id)})
    pushed = AsyncMock(return_value=True)
    with patch.object(svc, "async_session_factory", lambda: Session()), patch("server.services.notify_service.notify_user", pushed):
        assert asyncio.run(svc.on_task_finished(task)) is True
    assert st.last_status == "succeeded"
    mem = [a for a in added if isinstance(a, UserMemory)][0]
    assert mem.key == "定时任务：每日依赖检查" and "next、vite" in mem.content and mem.source == "scheduled"
    assert pushed.await_args.args[2] == "定时任务完成：每日依赖检查"
    # not a scheduled run: left alone
    assert asyncio.run(svc.on_task_finished(DeviceTask(id=uuid.uuid4(), action="agent", status="succeeded", payload={}))) is False
