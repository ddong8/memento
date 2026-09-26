"""Record risky agent operations on their task and tell the user's phone.

Devices report every agent tool call over their WebSocket (Claude Code's
PreToolUse hook -> local collector bridge -> server); risk_policy decides which
ones matter. Finished tasks nobody was watching get a push too, so work
dispatched from the phone can be left to run.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from ..db.models import DeviceTask
from ..db.session import async_session_factory
from . import notify_service
from .risk_policy import RiskFinding, classify_tool_use
from .ws_manager import ws_manager

logger = logging.getLogger("server.task_alerts")

MAX_ALERTS_PER_TASK = 50


def display_device_name(name: str | None) -> str:
    """'haixingdeMac-mini.local (Darwin)' -> 'haixingdeMac-mini'."""
    name = re.sub(r"\s*\([^)]*\)\s*$", "", name or "").strip()
    return re.sub(r"\.local$", "", name) or "设备"


async def append_alert(task_id: str, alert: dict, *, machine_id: uuid.UUID | None = None) -> uuid.UUID | None:
    """Store alert on the task; returns the task's user id, or None if the task
    doesn't exist or (when machine_id is given) doesn't belong to that machine."""
    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        return None
    async with async_session_factory() as db:
        task = (await db.execute(select(DeviceTask).where(DeviceTask.id == tid))).scalar_one_or_none()
        if task is None or (machine_id is not None and task.machine_id != machine_id):
            return None
        task.alerts = [*(task.alerts or []), alert][-MAX_ALERTS_PER_TASK:]
        await db.commit()
        return task.user_id


async def raise_alert(
    task_id: str,
    finding: RiskFinding,
    tool: str,
    device_name: str | None,
    *,
    machine_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    stream_to_watchers: bool = True,
) -> dict | None:
    """Record, stream to anyone watching the task, and push to the phone."""
    alert = {**finding.as_alert(tool), "at": datetime.now(timezone.utc).isoformat()}
    owner = await append_alert(task_id, alert, machine_id=machine_id)
    if owner is None:
        return None
    if stream_to_watchers:
        ws_manager.push_alert(task_id, alert)
    if notify_service.allow_risky_push(task_id):
        await notify_service.notify_user(
            user_id or owner,
            "risky",
            f"⚠️ {finding.label}",
            f"{display_device_name(device_name)}：{finding.detail}",
            url=notify_service.task_link(task_id),
        )
    return alert


async def handle_agent_tool_use(machine_id: uuid.UUID, device_name: str | None, data: dict) -> None:
    """WebSocket 'agent_tool_use' frame from a device."""
    try:
        tool = str(data.get("tool") or "")
        finding = classify_tool_use(tool, data.get("input") or {}, data.get("cwd"))
        task_id = str(data.get("task_id") or "")
        if finding and task_id:
            await raise_alert(task_id, finding, tool, device_name, machine_id=machine_id)
    except Exception:
        logger.exception("Failed to handle agent_tool_use")


def _task_summary(task: DeviceTask) -> str:
    payload = task.payload or {}
    text = str(payload.get("prompt") or payload.get("command") or "").strip()
    first = text.splitlines()[0] if text else "（无描述）"
    return first if len(first) <= 60 else first[:59] + "…"


async def handle_task_finished(task_id: str, status: str | None, device_name: str | None, watched: bool) -> None:
    """Push a finished agent task to the phone if nobody was watching it finish."""
    notify_service.forget_task(task_id)
    if watched or status == "cancelled":
        return
    try:
        async with async_session_factory() as db:
            task = (await db.execute(
                select(DeviceTask).where(DeviceTask.id == uuid.UUID(task_id))
            )).scalar_one_or_none()
        if task is None or task.action != "agent":
            return
        title = {"succeeded": "✅ 任务完成", "timeout": "⏱️ 任务超时"}.get(status or "", "❌ 任务失败")
        body = f"{display_device_name(device_name)}：{_task_summary(task)}"
        if task.alerts:
            body += f"（期间 {len(task.alerts)} 次危险操作）"
        await notify_service.notify_user(
            task.user_id, "task_done", title, body, url=notify_service.task_link(task_id),
        )
    except Exception:
        logger.exception("Failed to notify task finished %s", task_id)
