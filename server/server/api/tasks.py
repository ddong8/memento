"""Remote task execution — dispatch work to collectors running on devices.

The collector already polls the server every 10s for control commands
(resync / update). This extends that same pull-based channel into a general
work queue: the server enqueues a parameterized task, the device picks it up
on its next poll, runs it, and posts the result back.

Pull-based matters here — devices sit behind NAT with no inbound ports open,
which is why the existing collector design works from a home network at all.

Security model
--------------
Remote execution runs arbitrary code on the operator's machines, so it is:

  * OFF unless MEMENTO_REMOTE_EXEC=1 is set on the server, and
  * gated on a per-device key that the server mints and hands to the
    collector over its authenticated heartbeat — deliberately NOT the
    collector sync token, so a leaked sync token cannot escalate from
    "reads my synced files" to "shell on every device". There is nothing
    for the operator to distribute: turning this on is one server-side
    switch, and
  * fully audited — every task, its payload, who dispatched it, and its
    output are persisted in device_tasks.

With both switches on, tasks are unrestricted by design: the operator asked
for a general-purpose remote agent, not a sandbox.
"""

from __future__ import annotations

import logging
import os
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DeviceTask, Machine, User
from ..db.session import async_session_factory, get_db
from ..middleware.auth import get_current_user
from ..services.ws_manager import ws_manager

logger = logging.getLogger("server.tasks_api")

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

REMOTE_EXEC_ENABLED = os.environ.get("MEMENTO_REMOTE_EXEC", "").strip() == "1"


async def _verify_device_key(db: AsyncSession, device_id: str, presented: str | None) -> Machine:
    """Authenticate a collector for remote execution.

    Each device has its own key, minted server-side and delivered over the
    authenticated heartbeat — there is no shared secret for the operator to
    distribute. Compared in constant time so a wrong key can't be recovered
    by timing the response.
    """
    if not presented:
        raise HTTPException(status_code=403, detail="missing remote exec key")
    machine = (await db.execute(
        select(Machine).where(
            (Machine.collector_token_hash == device_id) | (Machine.name == device_id)
        )
    )).scalars().first()
    if not machine or not machine.remote_exec_key:
        raise HTTPException(status_code=403, detail="device not enrolled for remote execution")
    if not secrets.compare_digest(machine.remote_exec_key, presented):
        raise HTTPException(status_code=403, detail="invalid remote exec key")
    return machine

# Actions that run arbitrary code and therefore require the exec switch.
EXEC_ACTIONS = {"shell", "agent"}
# Legacy control actions — these predate this module and stay ungated.
CONTROL_ACTIONS = {"resync", "update"}

# Cap stored output. The collector truncates before upload too; this is the
# server-side backstop so one runaway task cannot bloat the table.
MAX_OUTPUT_CHARS = 200_000


class CreateTask(BaseModel):
    action: str
    payload: dict | None = None
    timeout_seconds: int = Field(default=300, ge=1, le=86400)


class TaskResult(BaseModel):
    status: str  # succeeded | failed | timeout
    exit_code: int | None = None
    stdout: str | None = None
    stderr: str | None = None
    error: str | None = None


def _require_exec_enabled(action: str) -> None:
    if action not in EXEC_ACTIONS:
        return
    if not REMOTE_EXEC_ENABLED:
        raise HTTPException(
            status_code=403,
            detail="remote execution disabled (set MEMENTO_REMOTE_EXEC=1 to enable)",
        )


async def _authorize_device(db: AsyncSession, device_id: str, user: User) -> Machine | None:
    """Non-admins may only target their own devices."""
    machine = (await db.execute(
        select(Machine).where(
            (Machine.collector_token_hash == device_id) | (Machine.name == device_id)
        )
    )).scalars().first()
    if user.role not in ("admin", "owner"):
        if not machine or machine.user_id != user.id:
            raise HTTPException(status_code=404, detail="Device not found")
    return machine


def _serialize(t: DeviceTask) -> dict:
    return {
        "id": str(t.id),
        "device_id": t.device_id,
        "action": t.action,
        "payload": t.payload,
        "status": t.status,
        "exit_code": t.exit_code,
        "stdout": t.stdout,
        "stderr": t.stderr,
        "error": t.error,
        "timeout_seconds": t.timeout_seconds,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "dispatched_at": t.dispatched_at.isoformat() if t.dispatched_at else None,
        "finished_at": t.finished_at.isoformat() if t.finished_at else None,
    }


# ---------------------------------------------------------------------------
# Operator-facing
# ---------------------------------------------------------------------------
@router.post("/dispatch/{device_id}")
async def create_task(
    device_id: str,
    body: CreateTask,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Queue a task for a device. Picked up on the collector's next poll."""
    if body.action not in EXEC_ACTIONS | CONTROL_ACTIONS:
        raise HTTPException(status_code=400, detail=f"unknown action: {body.action}")
    _require_exec_enabled(body.action)
    machine = await _authorize_device(db, device_id, _user)
    target_device_id = machine.collector_token_hash if machine else device_id

    task = DeviceTask(
        device_id=target_device_id,
        machine_id=machine.id if machine else None,
        user_id=_user.id,
        action=body.action,
        payload=body.payload,
        timeout_seconds=body.timeout_seconds,
        status="queued",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    logger.info(
        "task %s queued: action=%s device=%s by=%s",
        task.id, task.action, device_id, _user.email,
    )
    return _serialize(task)


@router.get("")
async def list_tasks(
    device_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List tasks the caller dispatched (admins see all)."""
    q = select(DeviceTask).order_by(DeviceTask.created_at.desc()).limit(min(limit, 200))
    if _user.role not in ("admin", "owner"):
        q = q.where(DeviceTask.user_id == _user.id)
    if device_id:
        q = q.where(DeviceTask.device_id == device_id)
    if status:
        q = q.where(DeviceTask.status == status)
    return [_serialize(t) for t in (await db.execute(q)).scalars().all()]


@router.get("/{task_id}")
async def get_task(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    task = (await db.execute(
        select(DeviceTask).where(DeviceTask.id == task_id)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404)
    # Mask as 404 rather than 403 so task ids can't be probed for existence.
    if _user.role not in ("admin", "owner") and task.user_id != _user.id:
        raise HTTPException(status_code=404)
    return _serialize(task)


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    task = (await db.execute(
        select(DeviceTask).where(DeviceTask.id == task_id)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404)
    if _user.role not in ("admin", "owner") and task.user_id != _user.id:
        raise HTTPException(status_code=404)
    if task.status in ("succeeded", "failed", "timeout", "cancelled"):
        return _serialize(task)
    # A task already running on the device keeps running — the collector is
    # not interrupted mid-process. This marks it cancelled so its result is
    # discarded on arrival and the UI stops waiting.
    task.status = "cancelled"
    task.finished_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return _serialize(task)


# ---------------------------------------------------------------------------
# Collector-facing (device authenticates with its collector token + exec key)
# ---------------------------------------------------------------------------
@router.get("/poll/{device_id}")
async def poll_tasks(
    device_id: str,
    x_collector_token: str | None = Header(default=None),
    x_remote_exec_key: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Collector pulls its queued tasks and marks them running.

    Requires the exec key in addition to the sync token, so a leaked sync
    token alone cannot pull executable work.
    """
    if not REMOTE_EXEC_ENABLED:
        return []
    if not x_collector_token:
        raise HTTPException(status_code=401, detail="missing collector token")
    await _verify_device_key(db, device_id, x_remote_exec_key)

    rows = (await db.execute(
        select(DeviceTask)
        .where(DeviceTask.device_id == device_id, DeviceTask.status == "queued")
        .order_by(DeviceTask.created_at.asc())
        .limit(5)
    )).scalars().all()
    if not rows:
        return []

    now = datetime.now(timezone.utc)
    ids = [t.id for t in rows]
    await db.execute(
        update(DeviceTask)
        .where(DeviceTask.id.in_(ids))
        .values(status="running", dispatched_at=now)
    )
    await db.commit()
    for t in rows:
        t.status, t.dispatched_at = "running", now
    return [_serialize(t) for t in rows]


@router.post("/{task_id}/result")
async def submit_result(
    task_id: uuid.UUID,
    body: TaskResult,
    x_remote_exec_key: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Collector posts back the outcome of a task."""
    if not REMOTE_EXEC_ENABLED:
        raise HTTPException(status_code=403, detail="remote execution disabled")
    task = (await db.execute(
        select(DeviceTask).where(DeviceTask.id == task_id)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404)
    # Key is checked against the device this task was dispatched to, so one
    # device cannot post results for another device's task.
    await _verify_device_key(db, task.device_id, x_remote_exec_key)
    # A cancelled task's result is discarded — the operator already gave up
    # on it, and overwriting the terminal state would resurrect it in the UI.
    if task.status == "cancelled":
        return {"status": "discarded"}

    if body.status not in ("succeeded", "failed", "timeout"):
        raise HTTPException(status_code=400, detail="invalid status")

    task.status = body.status
    task.exit_code = body.exit_code
    task.stdout = (body.stdout or "")[:MAX_OUTPUT_CHARS] or None
    task.stderr = (body.stderr or "")[:MAX_OUTPUT_CHARS] or None
    task.error = body.error
    task.finished_at = datetime.now(timezone.utc)
    await db.commit()
    logger.info("task %s finished: %s (exit=%s)", task.id, task.status, task.exit_code)
    return {"status": "recorded"}


async def _authenticate_ws(
    db: AsyncSession,
    device_id: str,
    collector_token: str | None,
    remote_exec_key: str | None,
) -> Machine | None:
    if not collector_token or not remote_exec_key:
        return None
    # 1. Verify collector token
    res = await db.execute(select(User).where(User.collector_token == collector_token))
    user = res.scalars().first()
    if not user:
        from ..config import settings
        if not (settings.collector_token and secrets.compare_digest(collector_token, settings.collector_token)):
            return None
    # 2. Verify machine and remote_exec_key
    machine = (await db.execute(
        select(Machine).where(
            (Machine.collector_token_hash == device_id) | (Machine.name == device_id)
        )
    )).scalars().first()
    if not machine or not machine.remote_exec_key:
        return None
    if not secrets.compare_digest(machine.remote_exec_key, remote_exec_key):
        return None
    return machine


@router.websocket("/ws/{device_id}")
async def device_websocket_endpoint(
    websocket: WebSocket,
    device_id: str,
    token: str | None = None,
    key: str | None = None,
):
    """Full-duplex WebSocket channel for real-time task dispatch and chunk streaming."""
    collector_token = token or websocket.headers.get("x-collector-token")
    exec_key = key or websocket.headers.get("x-remote-exec-key")

    async with async_session_factory() as db:
        machine = await _authenticate_ws(db, device_id, collector_token, exec_key)

    if not machine:
        await websocket.close(code=4003, reason="unauthorized")
        return

    await websocket.accept()
    real_device_id = machine.collector_token_hash
    ws_manager.register(real_device_id, websocket)

    try:
        await websocket.send_json({
            "type": "connected",
            "device_id": real_device_id,
            "device_name": machine.name,
        })

        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                # Touch heartbeat in db
                async with async_session_factory() as db:
                    await db.execute(
                        update(Machine)
                        .where(Machine.id == machine.id)
                        .values(last_heartbeat=datetime.now(timezone.utc))
                    )
                    await db.commit()
            elif msg_type == "task_progress":
                tid = data.get("task_id")
                if tid:
                    ws_manager.push_progress(tid, data.get("status", "running"))
            elif msg_type == "task_chunk":
                tid = data.get("task_id")
                if tid:
                    ws_manager.push_chunk(
                        tid,
                        data.get("stream", "stdout"),
                        data.get("text", ""),
                    )
            elif msg_type == "task_finished":
                tid_str = data.get("task_id")
                if tid_str:
                    ws_manager.push_finished(tid_str, data)
                    try:
                        tid_uuid = uuid.UUID(tid_str)
                        async with async_session_factory() as db:
                            t = (await db.execute(
                                select(DeviceTask).where(DeviceTask.id == tid_uuid)
                            )).scalar_one_or_none()
                            if t and t.status != "cancelled":
                                t.status = data.get("status", "succeeded")
                                t.exit_code = data.get("exit_code")
                                t.stdout = (data.get("stdout") or "")[:MAX_OUTPUT_CHARS] or None
                                t.stderr = (data.get("stderr") or "")[:MAX_OUTPUT_CHARS] or None
                                t.error = data.get("error")
                                t.finished_at = datetime.now(timezone.utc)
                                await db.commit()
                    except Exception as e:
                        logger.exception("Error saving WS finished task %s: %s", tid_str, e)
    except WebSocketDisconnect:
        logger.info("Device WebSocket disconnected: %s", real_device_id)
    except Exception as e:
        logger.warning("Device WebSocket error on %s: %s", real_device_id, e)
    finally:
        ws_manager.unregister(real_device_id, websocket)
