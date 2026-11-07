"""Handing a device_tasks row to its device.

Devices take work only over their WebSocket (HTTP polling for tasks went away on 2026-10-17). A row
that is written but never sent does not run: it sits queued until the reaper ends it a day later.
So anything that creates a task for a device sends it with deliver_task right after committing it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DeviceTask, Machine
from .user_filter import normalize_device_name
from .ws_manager import ws_manager

logger = logging.getLogger("server.device_dispatch")

OFFLINE_ERROR = "设备当前不在线，任务没有发出去。等设备连上后再派发"
SEND_FAILED_ERROR = "设备连接刚断开，任务没有发出去。等设备重新连上后再派发"


def ws_alias(device_id: str | None, machine: Machine | None = None) -> str | None:
    """The name the device is connected under (on this replica or another), or None while it is offline.

    A device registers under several names (token hash, name with and without the platform suffix,
    machine id), so each is tried.
    """
    candidates: list[str | None] = [device_id]
    if machine is not None:
        candidates += [machine.collector_token_hash, machine.name, normalize_device_name(machine.name), str(machine.id)]
    return next((c for c in candidates if c and ws_manager.has_device(c)), None)


async def deliver_task(db: AsyncSession, task: DeviceTask, machine: Machine | None = None) -> bool:
    """Send a committed task to its device; True when the device has it.

    Sent: the task is running from now. Not sent: it fails now with the reason, rather than staying
    queued, because nothing would pick it up and a command arriving hours later would be a surprise.
    Either way the change is committed and `task` refreshed.
    """
    alias = ws_alias(task.device_id, machine)
    sent = False
    if alias:
        sent = await ws_manager.send_task(alias, {
            "id": str(task.id),
            "action": task.action,
            "payload": task.payload or {},
            "timeout_seconds": task.timeout_seconds,
        })
    now = datetime.now(timezone.utc)
    if sent:
        values: dict = {"status": "running", "dispatched_at": now}
    else:
        values = {"status": "failed", "error": SEND_FAILED_ERROR if alias else OFFLINE_ERROR, "finished_at": now}
        logger.info("Task %s for %s not delivered: %s", task.id, task.device_id, "send failed" if alias else "offline")
    # Only from queued: a quick device may already have reported task_finished.
    await db.execute(
        update(DeviceTask)
        .where(DeviceTask.id == task.id, DeviceTask.status == "queued")
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    await db.commit()
    await db.refresh(task)
    return sent
