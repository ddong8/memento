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
import time
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import or_, select, update
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import DeviceTask, Machine, User
from ..db.session import async_session_factory, get_db
from ..middleware.auth import get_current_user
from ..services import device_reports, notify_service, task_alerts
from ..services.agent_limits import mark_usage_limit
from ..services.ws_manager import ws_manager
from ..services.device_service import HEARTBEAT_WRITE_EVERY

logger = logging.getLogger("server.tasks_api")


async def _note_task_session(task_id: str, session_id: str) -> None:
    """The session an agent task runs in, kept from its start: a task whose run is lost (a restart, a
    deploy with nowhere to hand it) still says where its work is, for the next question to go on in."""
    try:
        async with async_session_factory() as db:
            await db.execute(
                update(DeviceTask)
                .where(DeviceTask.id == uuid.UUID(task_id), DeviceTask.finished_at.is_(None))
                .values(session_id=session_id[:128])
            )
            await db.commit()
    except Exception as e:
        logger.debug("Could not note the session of task %s: %s", task_id, e)


_last_ws_heartbeat: dict[uuid.UUID, float] = {}

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
    if machine and bool(getattr(machine, "is_archived", False)):
        raise HTTPException(status_code=400, detail="Device is unlinked/archived")
    return machine


# A list shows a task on one line (its command or prompt). The injected context is most of a payload:
# 50 tasks were 398 KB of payload on 10-27, 255 KB of it system_prompt_append. GET /{id} has it all.
_LIST_PAYLOAD_DROP = ("system_prompt_append",)
_LIST_PAYLOAD_CHARS = 500


def _list_payload(payload):
    if not isinstance(payload, dict):
        return payload
    out = {}
    for k, v in payload.items():
        if k in _LIST_PAYLOAD_DROP:
            continue
        out[k] = v[:_LIST_PAYLOAD_CHARS] + "…" if isinstance(v, str) and len(v) > _LIST_PAYLOAD_CHARS else v
    return out


def _serialize(t: DeviceTask, truncate_output: bool = False, include_events: bool = True) -> dict:
    stdout = t.stdout
    stderr = t.stderr
    payload = t.payload
    if truncate_output:
        if stdout and len(stdout) > 2000:
            stdout = stdout[:1000] + "\n...[truncated]...\n" + stdout[-1000:]
        if stderr and len(stderr) > 2000:
            stderr = stderr[:1000] + "\n...[truncated]...\n" + stderr[-1000:]
        payload = _list_payload(payload)
    return {
        "id": str(t.id),
        "device_id": t.device_id,
        "action": t.action,
        "payload": payload,
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
        "session_id": t.session_id,
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

    task_payload = dict(body.payload or {})
    if body.action == "agent":
        try:
            from ..services.mind_resonance_service import render_mind_resonance_markdown, sense_resonance
            sub_proj = task_payload.get("project_id") or task_payload.get("cwd") or ""
            sub_query = task_payload.get("user_question") or task_payload.get("prompt") or ""
            res = await sense_resonance(db, _user, query=sub_query, project=str(sub_proj) if sub_proj else None, action="agent")
            mind_md = render_mind_resonance_markdown(res)
            if mind_md.strip():
                cur_append = task_payload.get("system_prompt_append") or ""
                task_payload["system_prompt_append"] = f"{cur_append}\n\n{mind_md}".strip() if cur_append else mind_md.strip()
        except Exception as e:
            logger.warning("Failed to auto-inject mind resonance in tasks.create_task: %s", e)

    task = DeviceTask(
        device_id=target_device_id,
        machine_id=machine.id if machine else None,
        user_id=_user.id,
        action=body.action,
        payload=task_payload,
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
    # Set when this answers a question the agent asked (the question event's id); else the input steers the task
    question_id: str | None = None


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
    # Only this task: the device's other tasks keep running.
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

    sent = await ws_manager.send_input(task.device_id, str(task.id), body.input, body.question_id)
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
    aliases = (
        real_device_id, device_id, machine.name,
        normalize_device_name(machine.name) if machine.name else None,
        str(machine.id) if machine.id else None,
    )
    await ws_manager.register(real_device_id, websocket, *aliases)
    device_reports.record_owner(aliases, str(machine.user_id) if machine.user_id else None)
    await ws_manager.send_kept_cancels(*aliases)

    try:
        async with async_session_factory() as db:
            await db.execute(
                update(Machine)
                .where(Machine.id == machine.id)
                .values(last_heartbeat=datetime.now(timezone.utc))
            )
            await db.commit()
        if machine.id:
            _last_ws_heartbeat[machine.id] = time.monotonic()
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
                # Touch heartbeat in db, throttled to at most once per HEARTBEAT_WRITE_EVERY (60s)
                # in memory first to avoid acquiring DB connections and executing no-op UPDATEs.
                now_mono = time.monotonic()
                if machine.id and now_mono - _last_ws_heartbeat.get(machine.id, 0.0) >= HEARTBEAT_WRITE_EVERY.total_seconds():
                    _last_ws_heartbeat[machine.id] = now_mono
                    now = datetime.now(timezone.utc)
                    try:
                        async with async_session_factory() as db:
                            await db.execute(
                                update(Machine)
                                .where(
                                    Machine.id == machine.id,
                                    or_(Machine.last_heartbeat.is_(None), Machine.last_heartbeat < now - HEARTBEAT_WRITE_EVERY),
                                )
                                .values(last_heartbeat=now)
                            )
                            await db.commit()
                    except Exception as e:
                        logger.warning("Failed to update machine heartbeat: %s", e)
            elif msg_type == "agent_capabilities":
                caps = data.get("capabilities") or {}
                device_reports.set_device_capabilities((real_device_id, machine.name, str(machine.id) if machine.id else None), caps)
                logger.info("Received dynamic agent capabilities from device %s (%s)", real_device_id, machine.name)
            elif msg_type == "agent_quotas":
                quotas = data.get("quotas") or {}
                device_reports.set_cached_device_quotas(real_device_id, quotas, machine.name, str(machine.id) if machine.id else None)
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
                    if data["event"].get("kind") == "session" and data["event"].get("session_id"):
                        notify_service.spawn(_note_task_session(tid, str(data["event"]["session_id"])))
            elif msg_type == "agent_tool_use":
                # Classified and pushed off the receive loop: a slow push must
                # never stall chunk streaming.
                notify_service.spawn(task_alerts.handle_agent_tool_use(machine.id, machine.name, data))
            elif msg_type in ("file_stat_resp", "file_chunk_resp", "p2p_answer"):
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
                                # Ended on the account's quota: failed, not done or left running
                                done = mark_usage_limit({**data, "action": t.action})
                                new_status = done.get("status", "succeeded")
                                t.status = new_status
                                t.exit_code = data.get("exit_code")
                                t.stdout = (data.get("stdout") or "")[:MAX_OUTPUT_CHARS] or None
                                t.stderr = (data.get("stderr") or "")[:MAX_OUTPUT_CHARS] or None
                                t.error = done.get("error")
                                t.session_id = str(data.get("session_id") or "")[:128] or None
                                if isinstance(data.get("events"), list):
                                    t.events = data["events"][:400]
                                # still_running too: the agent has exited and nothing more comes for this task
                                # (left open, the reaper turned it into a timeout a day later)
                                t.finished_at = datetime.now(timezone.utc)
                                await db.commit()
                                if not watched:
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
                                            # 1. Direct index-backed lookup on config->>'session_id'
                                            conv_obj = (await db.execute(
                                                select(AskConversation)
                                                .where(
                                                    (AskConversation.user_id == t.user_id) | (AskConversation.user_id.is_(None)),
                                                    AskConversation.config.op("->>")("session_id") == pl_sess,
                                                )
                                                .order_by(AskConversation.updated_at.desc())
                                                .limit(1)
                                            )).scalars().first()
                                            if not conv_obj:
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
