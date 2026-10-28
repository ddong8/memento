"""Celery task: close out device tasks that no device will ever report on.

A task stays queued / running until its device sends task_finished. When that never comes (the
device was reinstalled or retired, or the daemon died mid-task) nothing ended it: 73 tasks sat
"running" or "queued" for up to 47 days, and a mission waiting on one of them never moved on.
Past its own timeout plus a grace period such a task is marked timed out, never deleted; a
device that reports after all still overwrites the status with its real result.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..db.models import DeviceTask
from ..db.session import async_session_factory, engine
from .celery_app import celery_app

logger = logging.getLogger("task_reaper")

OPEN_STATUSES = ("queued", "running", "still_running")
# Time for a result that is on its way (a slow upload, a daemon reconnecting) to arrive.
GRACE = timedelta(hours=1)
# Tasks without a timeout (0) and work an agent left running in the background get a day.
OPEN_ENDED = timedelta(hours=24)


def overdue(task: DeviceTask, now: datetime) -> str | None:
    """Why the task is past saving, or None while a result can still come."""
    created = task.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    if task.status == "queued":
        if now - created > OPEN_ENDED:
            return "设备一直没有领取这个任务（超过 24 小时），已由服务端结束"
        return None
    if task.status == "still_running":
        if now - created > OPEN_ENDED:
            return "后台任务超过 24 小时没有新的回报，已由服务端结束跟踪"
        return None
    started = task.dispatched_at or created
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    budget = timedelta(seconds=task.timeout_seconds) if (task.timeout_seconds or 0) > 0 else OPEN_ENDED
    if now - started > budget + GRACE:
        return "超过超时时间仍未收到设备回报（设备可能已离线或重启），已由服务端结束"
    return None


async def _run() -> dict:
    now = datetime.now(timezone.utc)
    try:
        async with async_session_factory() as db:
            tasks = (await db.execute(
                select(DeviceTask).where(
                    DeviceTask.status.in_(OPEN_STATUSES),
                    # A still_running task the agent reported on is over (it left background work)
                    DeviceTask.finished_at.is_(None),
                    DeviceTask.created_at < now - GRACE,
                )
            )).scalars().all()
            closed = 0
            for t in tasks:
                reason = overdue(t, now)
                if reason is None:
                    continue
                logger.info("Closing stale task %s (%s since %s)", t.id, t.status, t.created_at)
                t.error = f"{t.error}\n{reason}" if t.error else reason
                t.status = "timeout"
                t.finished_at = now
                closed += 1
            await db.commit()
        return {"open": len(tasks), "closed": closed}
    finally:
        # Each run has its own event loop: pooled connections from this one can't be reused.
        await engine.dispose()


@celery_app.task(name="server.tasks.task_reaper.close_stale_tasks", acks_late=True, expires=540)
def close_stale_tasks() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("close_stale_tasks errored: %s", e)
        return {"error": str(e)[:200]}
