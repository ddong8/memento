"""Scheduled agent tasks: run due ones on the user's devices, then keep the result in memory and push it.

Schedules are "hourly:MM", "daily:HH:MM" or "weekly:D:HH:MM" (D 0 = Monday) in the user's local time. The beat
(tasks/scheduled_tasks.py) calls run_due() every minute; a task's finish (task_alerts) calls on_task_finished().
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..db.models import DeviceTask, Machine, ScheduledTask, User, UserMemory
from ..db.session import async_session_factory

logger = logging.getLogger("server.scheduled_tasks")

_SCHEDULE_RE = re.compile(r"^(?:hourly:(\d{1,2})|daily:(\d{1,2}):(\d{1,2})|weekly:([0-6]):(\d{1,2}):(\d{1,2}))$")
AGENT_BINARIES = {"antigravity": "agy"}


def valid_schedule(schedule: str) -> bool:
    m = _SCHEDULE_RE.match(schedule.strip())
    if not m:
        return False
    nums = [int(x) for x in m.groups() if x is not None]
    if schedule.startswith("hourly"):
        return nums[0] < 60
    hh, mm = nums[-2], nums[-1]
    return hh < 24 and mm < 60


def next_run(schedule: str, tz_offset_min: int, after: datetime) -> datetime:
    """The first run strictly after `after` (UTC-aware), computed in the user's local time."""
    m = _SCHEDULE_RE.match(schedule.strip())
    if not m:
        raise ValueError(f"bad schedule: {schedule}")
    tz = timezone(timedelta(minutes=tz_offset_min))
    local = after.astimezone(tz).replace(second=0, microsecond=0)
    if m.group(1) is not None:  # hourly
        cand = local.replace(minute=int(m.group(1)))
        while cand <= after.astimezone(tz):
            cand += timedelta(hours=1)
    elif m.group(2) is not None:  # daily
        cand = local.replace(hour=int(m.group(2)), minute=int(m.group(3)))
        while cand <= after.astimezone(tz):
            cand += timedelta(days=1)
    else:  # weekly
        dow, hh, mm = int(m.group(4)), int(m.group(5)), int(m.group(6))
        cand = local.replace(hour=hh, minute=mm) + timedelta(days=(dow - local.weekday()) % 7)
        while cand <= after.astimezone(tz):
            cand += timedelta(days=7)
    return cand.astimezone(timezone.utc)


def task_payload(st: ScheduledTask) -> tuple[str, dict]:
    """(action, payload) of the device task a scheduled task starts."""
    if st.agent == "shell":
        return "shell", {"command": st.prompt, **({"cwd": st.cwd} if st.cwd else {}), "scheduled_task_id": str(st.id)}
    return "agent", {
        "binary": AGENT_BINARIES.get(st.agent, st.agent),
        "prompt": st.prompt,
        "user_question": st.prompt,
        "title": f"定时任务：{st.title}",
        **({"cwd": st.cwd} if st.cwd else {}),
        **({"permission_mode": st.permission_mode} if st.permission_mode and st.permission_mode != "full" else {}),
        "scheduled_task_id": str(st.id),
    }


async def start(db, st: ScheduledTask, now: datetime) -> DeviceTask | None:
    """Dispatch one run of `st` (whether due or "run now") and record it."""
    from .device_dispatch import deliver_task

    machine = (await db.execute(
        select(Machine).where((Machine.collector_token_hash == st.device) | (Machine.name == st.device), Machine.user_id == st.user_id)
        .order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().first()
    action, payload = task_payload(st)
    task = DeviceTask(
        id=uuid.uuid4(),
        device_id=machine.collector_token_hash if machine else st.device,
        machine_id=machine.id if machine else None,
        user_id=st.user_id,
        action=action,
        payload=payload,
        timeout_seconds=7200 if action == "agent" else 600,
        status="queued",
    )
    db.add(task)
    st.last_run_at = now
    st.last_task_id = task.id
    st.last_status = "running"
    await db.commit()
    await db.refresh(task)
    await deliver_task(db, task, machine)
    return task


async def run_due(now: datetime | None = None) -> int:
    """Start every enabled scheduled task whose time has come; returns how many started."""
    now = now or datetime.now(timezone.utc)
    started = 0
    async with async_session_factory() as db:
        due = (await db.execute(
            select(ScheduledTask).where(ScheduledTask.enabled.is_(True), ScheduledTask.next_run_at <= now)
        )).scalars().all()
        for st in due:
            # Next time first: a failing dispatch must not retry every minute
            st.next_run_at = next_run(st.schedule, st.tz_offset_min, now)
            await db.commit()
            try:
                await start(db, st, now)
                started += 1
            except Exception:
                logger.exception("Scheduled task %s failed to start", st.id)
                st.last_status = "failed"
                await db.commit()
    return started


async def on_task_finished(task: DeviceTask) -> bool:
    """A run of a scheduled task ended: remember what it found and push it. False when it isn't one."""
    sid = str((task.payload or {}).get("scheduled_task_id") or "")
    if not sid:
        return False
    from . import notify_service

    async with async_session_factory() as db:
        st = (await db.execute(select(ScheduledTask).where(ScheduledTask.id == uuid.UUID(sid)))).scalar_one_or_none()
        if st is None:
            return True
        st.last_status = task.status
        out = (task.stdout or task.error or "").strip()
        summary = out if len(out) <= 1500 else "…" + out[-1500:]
        when = datetime.now(timezone(timedelta(minutes=st.tz_offset_min))).strftime("%Y-%m-%d %H:%M")
        if summary:
            # Memory, so the next conversations (and the agents) know what the scheduled check found
            db.add(UserMemory(
                user_id=st.user_id,
                category="project",
                key=f"定时任务：{st.title}"[:120],
                content=f"{when} 在 {st.device} 运行（{task.status}）：\n{summary}",
                source="scheduled",
                confidence=0.8,
            ))
        await db.commit()
        user_id = st.user_id
        title = st.title
    ok = task.status == "succeeded"
    await notify_service.notify_user(user_id, "task_done", f"定时任务{'完成' if ok else '失败'}：{title}", (summary or task.status)[:200])
    return True


async def owned(db, user: User, sid: str) -> ScheduledTask | None:
    try:
        uid = uuid.UUID(sid)
    except ValueError:
        return None
    return (await db.execute(select(ScheduledTask).where(ScheduledTask.id == uid, ScheduledTask.user_id == user.id))).scalar_one_or_none()


# ── the runner: once a minute, on the replica holding the "scheduled-tasks" lease ───────────────────

import asyncio  # noqa: E402

TICK_SECONDS = 60
_runner: asyncio.Task | None = None


async def _loop() -> None:
    from .cluster import cluster

    while True:
        try:
            async with cluster.leased("scheduled-tasks", ttl=90.0) as mine:
                if mine:
                    n = await run_due()
                    if n:
                        logger.info("Started %d scheduled task(s)", n)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Scheduled task pass failed")
        await asyncio.sleep(TICK_SECONDS)


async def start_scheduler() -> None:
    global _runner
    if _runner is None:
        _runner = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    global _runner
    if _runner:
        _runner.cancel()
        await asyncio.gather(_runner, return_exceptions=True)
        _runner = None
    from .cluster import cluster

    await cluster.release_lease("scheduled-tasks")
