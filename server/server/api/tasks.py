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

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DeviceTask, Machine, User
from ..db.session import async_session_factory, get_db
from ..middleware.auth import get_current_user
from ..services import notify_service, task_alerts
from ..services.cluster import SharedDict, cluster
from ..services.ws_manager import ws_manager

logger = logging.getLogger("server.tasks_api")

router = APIRouter(prefix="/api/tasks", tags=["tasks"])

REMOTE_EXEC_ENABLED = os.environ.get("MEMENTO_REMOTE_EXEC", "").strip() == "1"


def normalize_device_name(name: str | None) -> str:
    """Strip platform suffixes like ' (Darwin)', ' (Windows)', ' (Linux)'."""
    if not name:
        return ""
    for suffix in (" (Darwin)", " (Windows)", " (Linux)"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name


# Actions that run arbitrary code and therefore require the exec switch.
EXEC_ACTIONS = {"shell", "agent"}
# Legacy control actions — these predate this module and stay ungated.
CONTROL_ACTIONS = {"resync", "update"}

# Cap stored output. The collector truncates before upload too; this is the
# server-side backstop so one runaway task cannot bloat the table.
MAX_OUTPUT_CHARS = 200_000

# Live agent capabilities reported by connected devices (whichever replica they're on)
_device_capabilities = SharedDict(cluster, "device_capabilities")


def get_cached_device_capabilities(device_id: str | None = None, tool: str | None = None) -> dict | None:
    if not device_id or device_id in ("auto", "ask_only"):
        for caps in _device_capabilities.data.values():
            if tool:
                if tool in caps:
                    return caps[tool]
            else:
                return caps
        return None

    caps = _device_capabilities.data.get(device_id)
    if not caps:
        for k, v in _device_capabilities.data.items():
            if k == device_id or device_id.startswith(k) or k.startswith(device_id):
                caps = v
                break

    if not caps:
        return None
    if tool:
        return caps.get(tool)
    return caps


def get_device_environment_summary(device_id: str | None = None) -> str | None:
    """Format a compact environment profile string for system prompts and tool contexts."""
    caps = get_cached_device_capabilities(device_id)
    if not caps or not isinstance(caps, dict):
        return None
    env = caps.get("environment")
    if not env or not isinstance(env, dict):
        return None

    plat = env.get("platform") or ""
    arch = env.get("arch") or ""
    shell = env.get("shell") or ""
    user = env.get("username") or ""
    tools_dict = env.get("tools") or {}
    active_tools = [f"{k}: {v}" for k, v in tools_dict.items() if v]

    lines = [
        f"系统平台: {plat} ({arch}) | 默认 Shell: {shell} | 当前用户: {user}",
    ]
    if active_tools:
        lines.append(f"已就绪工具链: {', '.join(active_tools)}")
    workspaces = env.get("workspaces") or []
    if workspaces:
        lines.append(f"常用工作区路径: {', '.join(workspaces[:3])}")
    lines.append("提示: 目标设备已就绪上述环境与工具，执行命令时直接调用对应环境，无需重复运行 which/--version 探查。")
    return "\n".join(lines)



class CreateTask(BaseModel):
    action: str
    payload: dict | None = None
    timeout_seconds: int = Field(default=7200, ge=0, le=86400)


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
        ).order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().first()
    if user.role not in ("admin", "owner"):
        if not machine or machine.user_id != user.id:
            raise HTTPException(status_code=404, detail="Device not found")
    return machine


def _serialize(t: DeviceTask, truncate_output: bool = False, include_events: bool = True) -> dict:
    stdout = t.stdout
    stderr = t.stderr
    if truncate_output:
        if stdout and len(stdout) > 2000:
            stdout = stdout[:1000] + "\n...[truncated]...\n" + stdout[-1000:]
        if stderr and len(stderr) > 2000:
            stderr = stderr[:1000] + "\n...[truncated]...\n" + stderr[-1000:]
    return {
        "id": str(t.id),
        "device_id": t.device_id,
        "action": t.action,
        "payload": t.payload,
        "status": t.status,
        "exit_code": t.exit_code,
        "stdout": stdout,
        "stderr": stderr,
        "error": t.error,
        "timeout_seconds": t.timeout_seconds,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "dispatched_at": t.dispatched_at.isoformat() if t.dispatched_at else None,
        "finished_at": t.finished_at.isoformat() if t.finished_at else None,
        "alerts": t.alerts or [],
        "events": (t.events or []) if include_events else [],
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
    q = (
        select(DeviceTask)
        .options(defer(DeviceTask.events))
        .order_by(DeviceTask.created_at.desc())
        .limit(min(limit, 200))
    )
    if _user.role not in ("admin", "owner"):
        q = q.where(DeviceTask.user_id == _user.id)
    if device_id:
        q = q.where(DeviceTask.device_id == device_id)
    if status:
        q = q.where(DeviceTask.status == status)
    return [_serialize(t, truncate_output=True, include_events=False) for t in (await db.execute(q)).scalars().all()]


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


class TaskInputRequest(BaseModel):
    input: str


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    try:
        t_uuid = uuid.UUID(task_id)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail=f"invalid task id format: {task_id}")

    task = (await db.execute(
        select(DeviceTask).where(DeviceTask.id == t_uuid)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404)
    if _user.role not in ("admin", "owner") and task.user_id != _user.id:
        raise HTTPException(status_code=404)
    if task.status in ("succeeded", "failed", "timeout", "cancelled"):
        return _serialize(task)

    # Notify running collector process immediately to kill process tree
    await ws_manager.send_cancel(task.device_id, str(task.id))

    task.status = "cancelled"
    task.finished_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(task)
    return _serialize(task)


@router.post("/{task_id}/input")
async def send_task_input(
    task_id: str,
    body: TaskInputRequest,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    try:
        t_uuid = uuid.UUID(task_id)
    except (ValueError, AttributeError):
        return {"ok": False, "reason": f"invalid task id format: {task_id}"}

    task = (await db.execute(
        select(DeviceTask).where(DeviceTask.id == t_uuid)
    )).scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404)
    if _user.role not in ("admin", "owner") and task.user_id != _user.id:
        raise HTTPException(status_code=404)
    if task.status not in ("queued", "running"):
        return {"ok": False, "reason": f"task status is {task.status}, not running"}

    sent = await ws_manager.send_input(task.device_id, str(task.id), body.input)
    return {"ok": sent}


# ---------------------------------------------------------------------------
# Collector-facing (device authenticates with its collector token + exec key)
# ---------------------------------------------------------------------------
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
    base_dev_id = normalize_device_name(device_id)
    machines = (await db.execute(
        select(Machine).where(
            (Machine.collector_token_hash == device_id)
            | (Machine.name == device_id)
            | (Machine.name == base_dev_id)
            | (Machine.name.like(f"{base_dev_id}%"))
        ).order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().all()
    if not machines:
        return None
    for m in machines:
        if m.remote_exec_key and secrets.compare_digest(m.remote_exec_key, remote_exec_key):
            return m
    return None


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
        await websocket.accept()
        await websocket.close(code=4003, reason="unauthorized")
        return

    await websocket.accept()
    real_device_id = machine.collector_token_hash
    await ws_manager.register(
        real_device_id, websocket, device_id, machine.name,
        normalize_device_name(machine.name) if machine.name else None,
        str(machine.id) if machine.id else None,
    )

    try:
        async with async_session_factory() as db:
            await db.execute(
                update(Machine)
                .where(Machine.id == machine.id)
                .values(last_heartbeat=datetime.now(timezone.utc))
            )
            await db.commit()
    except Exception as e:
        logger.warning("Failed to update machine last_heartbeat on WS accept: %s", e)

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
            elif msg_type == "agent_capabilities":
                caps = data.get("capabilities") or {}
                _device_capabilities.set((real_device_id, machine.name, str(machine.id) if machine.id else None), caps)
                logger.info("Received dynamic agent capabilities from device %s (%s)", real_device_id, machine.name)
            elif msg_type == "agent_quotas":
                from .quotas import set_cached_device_quotas
                quotas = data.get("quotas") or {}
                set_cached_device_quotas(real_device_id, quotas, machine.name, str(machine.id) if machine.id else None)
                logger.info("Received dynamic agent quotas from device %s (%s)", real_device_id, machine.name)
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
            elif msg_type == "agent_event":
                tid = data.get("task_id")
                if tid and isinstance(data.get("event"), dict):
                    ws_manager.push_event(tid, data["event"])
            elif msg_type == "agent_tool_use":
                # Classified and pushed off the receive loop: a slow push must
                # never stall chunk streaming.
                notify_service.spawn(task_alerts.handle_agent_tool_use(machine.id, machine.name, data))
            elif msg_type in ("file_stat_resp", "file_chunk_resp"):
                ws_manager.handle_file_response(data)
            elif msg_type == "task_finished":
                tid_str = data.get("task_id")
                if tid_str:
                    watched = await ws_manager.is_watched(tid_str)
                    ws_manager.push_finished(tid_str, data)
                    try:
                        tid_uuid = uuid.UUID(tid_str)
                        async with async_session_factory() as db:
                            t = (await db.execute(
                                select(DeviceTask).where(DeviceTask.id == tid_uuid)
                            )).scalar_one_or_none()
                            if t and t.status != "cancelled":
                                new_status = data.get("status", "succeeded")
                                t.status = new_status
                                t.exit_code = data.get("exit_code")
                                t.stdout = (data.get("stdout") or "")[:MAX_OUTPUT_CHARS] or None
                                t.stderr = (data.get("stderr") or "")[:MAX_OUTPUT_CHARS] or None
                                t.error = data.get("error")
                                if isinstance(data.get("events"), list):
                                    t.events = data["events"][:400]
                                if new_status != "still_running":
                                    t.finished_at = datetime.now(timezone.utc)
                                await db.commit()
                                if not watched and new_status != "still_running":
                                    try:
                                        from ..db.models import AskConversation
                                        from ..services.ask_store import infer_conversation_config, recover_orphaned_tasks_for_conv
                                        pl = t.payload or {}
                                        pl_conv = str(pl.get("conversation_id") or "").strip()
                                        pl_sess = str(pl.get("session_id") or "").strip()
                                        conv_obj = None
                                        if pl_conv:
                                            try:
                                                conv_obj = (await db.execute(select(AskConversation).where(AskConversation.id == uuid.UUID(pl_conv)))).scalars().first()
                                            except Exception:
                                                pass
                                        if not conv_obj and pl_sess:
                                            cand_convs = (await db.execute(
                                                select(AskConversation)
                                                .where(AskConversation.user_id == t.user_id)
                                                .order_by(AskConversation.updated_at.desc())
                                                .limit(20)
                                            )).scalars().all()
                                            conv_obj = next((c for c in cand_convs if infer_conversation_config(c)[0].get("session_id") == pl_sess), None)
                                        if conv_obj:
                                            cfg_c, _ = infer_conversation_config(conv_obj)
                                            await recover_orphaned_tasks_for_conv(db, conv_obj, cfg_c)
                                    except Exception as rec_err:
                                        logger.warning("Failed to auto-recover conversation turn for task %s: %s", tid_str, rec_err)
                    except Exception as e:
                        logger.exception("Error saving WS finished task %s: %s", tid_str, e)
                    notify_service.spawn(task_alerts.handle_task_finished(
                        tid_str, data.get("status"), machine.name, watched,
                    ))
    except WebSocketDisconnect:
        logger.info("Device WebSocket disconnected: %s", real_device_id)
    except Exception as e:
        logger.warning("Device WebSocket error on %s: %s", real_device_id, e)
    finally:
        await ws_manager.unregister(real_device_id, websocket)
