"""Background missions: a goal the server works toward one step at a time.

The pulse loop (pulse_service) calls step_mission about once a minute for each running mission.
A step asks the model, given the goal and the last few steps, for one JSON decision:

  * finish: the mission succeeded; the user gets a push with the summary.
  * wait: nothing happens until the given number of seconds (at most an hour) has passed.
  * exec_shell: run a command on one of the user's devices. risk_policy rates it first; danger or
    critical (and warn, when the user turned auto_approve_safe off) pauses the mission in
    waiting_approval and pushes a one-tap approval link, else the command is sent to an online
    device right away (device_dispatch). The next steps wait for the device to report back and
    record its exit code and output.

steps, context and pending_action are JSONB; every change to them is flagged so it is saved.
An unusable model reply is retried with growing pauses (1, 2, 4, 8 minutes); the mission fails after
MAX_DECISION_FAILURES of them in a row, or after MAX_STEPS steps, so a stuck one does not call the
model forever. last_heartbeat moves on every step, which is how pulse takes turns between missions.
"""

from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from ..config import settings
from ..db.models import AgentMission, DeviceTask, Machine, User
from .ai_provider import call_plain_chat
from .device_dispatch import deliver_task, ws_alias
from .notify_service import notify_user
from .risk_policy import classify_shell_command
from .user_filter import normalize_device_name

logger = logging.getLogger("server.mission_service")

MAX_WAIT_SECONDS = 3600
# No online device: try again after this long instead of asking the model every minute.
OFFLINE_RETRY_SECONDS = 300
MAX_DECISION_FAILURES = 5
MAX_STEPS = 60
SHELL_TIMEOUT_SECONDS = 600
OPEN_TASK_STATUSES = ("queued", "running", "still_running")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _missions_url() -> str:
    path = "/profile?tab=proactive"
    return f"{settings.public_url.rstrip('/')}{path}" if settings.public_url else path


def _add_step(mission: AgentMission, step: dict[str, Any]) -> None:
    mission.current_step += 1
    mission.steps = [*(mission.steps or []), {"step": mission.current_step, **step}]


def _set_context(mission: AgentMission, **changes: Any) -> None:
    """Set keys (None removes one) and save the dict."""
    ctx = dict(mission.context or {})
    for k, v in changes.items():
        if v is None:
            ctx.pop(k, None)
        else:
            ctx[k] = v
    mission.context = ctx
    flag_modified(mission, "context")


def _parse_decision(reply: str) -> dict[str, Any]:
    """The JSON object in a model reply, with or without a code fence around it."""
    text = reply.strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the reply")
    decision = json.loads(text[start:end + 1])
    if not isinstance(decision, dict):
        raise ValueError("the reply is not a JSON object")
    return decision


def _wait_until(mission: AgentMission) -> datetime | None:
    raw = (mission.context or {}).get("wait_until")
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(str(raw))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def create_mission(
    db: AsyncSession,
    user: User,
    title: str,
    goal: str,
    context: dict[str, Any] | None = None,
    risk_level: str = "low",
) -> AgentMission:
    """Create a running mission; the pulse loop takes its first step within a minute."""
    now = _now()
    mission = AgentMission(
        id=uuid.uuid4(),
        user_id=user.id,
        title=title.strip()[:250],
        goal=goal.strip(),
        status="running",
        risk_level=risk_level,
        current_step=0,
        steps=[{
            "step": 0,
            "type": "init",
            "message": f"任务已创建并启动: {title}",
            "created_at": now.isoformat(),
        }],
        context=context or {},
        created_at=now,
        updated_at=now,
        last_heartbeat=now,
    )
    db.add(mission)
    await db.commit()
    await db.refresh(mission)
    logger.info("Created autonomous mission %s for user %s: %s", mission.id, user.id, title)
    return mission


async def _fail(db: AsyncSession, mission: AgentMission, error: str) -> None:
    mission.status = "failed"
    mission.error = error
    _add_step(mission, {"type": "error", "message": error, "timestamp": _now().isoformat()})
    await db.commit()
    await notify_user(
        mission.user_id,
        kind="task_done",
        title=f"任务未完成: {mission.title}",
        body=error[:200],
        url=_missions_url(),
    )


async def step_mission(db: AsyncSession, mission: AgentMission) -> bool:
    """Advance a running mission by one step; True if something happened (a decision or a recorded result)."""
    if mission.status != "running":
        return False
    now = _now()

    user = (await db.execute(select(User).where(User.id == mission.user_id))).scalar_one_or_none()
    if not user:
        mission.status = "failed"
        mission.error = "User not found"
        await db.commit()
        return False
    mission.last_heartbeat = now

    # A command sent to a device: wait for it, then record how it went.
    recorded = False
    task_id = (mission.context or {}).get("active_device_task_id")
    if task_id:
        dev_task = (await db.execute(select(DeviceTask).where(DeviceTask.id == uuid.UUID(task_id)))).scalar_one_or_none()
        if dev_task and dev_task.status in OPEN_TASK_STATUSES:
            await db.commit()
            return False
        if dev_task:
            _add_step(mission, {
                "type": "device_task_result",
                "device_task_id": str(dev_task.id),
                "exit_code": dev_task.exit_code,
                "status": dev_task.status,
                "output_preview": (dev_task.stdout or dev_task.stderr or dev_task.error or "")[:500],
                "completed_at": now.isoformat(),
            })
        _set_context(mission, active_device_task_id=None)
        mission.updated_at = now
        await db.commit()
        recorded = True

    wait_until = _wait_until(mission)
    if wait_until and now < wait_until:
        await db.commit()
        return recorded
    if wait_until:
        _set_context(mission, wait_until=None)

    if mission.current_step >= MAX_STEPS:
        await _fail(db, mission, f"已执行 {MAX_STEPS} 步仍未完成，任务已停止")
        return True

    mission.updated_at = now

    prompt = f"""你是一个运行在服务器后台的全天候自主 AI 助手。
你正在全天候为用户执行一项后台长任务：
任务标题: {mission.title}
最终目标: {mission.goal}
当前执行步骤进度: {mission.current_step}

已执行的历史步骤:
{json.dumps((mission.steps or [])[-5:], ensure_ascii=False, indent=2)}

请决策下一步动作，严格返回 JSON 对象，格式如下：
如果目标已达成：
{{
  "action": "finish",
  "summary": "详细说明达成结果"
}}

如果需要执行远程终端命令（或查询系统）：
{{
  "action": "exec_shell",
  "command": "具体命令，如 git status / pytest / curl 等",
  "reason": "为何执行该命令",
  "device_id": "可选的目标设备名或留空自动选择"
}}

如果需要休眠等待一段时间后再次检查（如等待构建/编译）：
{{
  "action": "wait",
  "seconds": 60,
  "reason": "等待编译完成"
}}

请直接输出合法 JSON，不要加多余修饰："""

    decision: dict[str, Any] | None = None
    try:
        reply = await call_plain_chat([{"role": "user", "content": prompt}], user=user, background=True)
        if reply:
            decision = _parse_decision(reply)
    except Exception as e:
        logger.warning("Mission %s LLM decision failed: %s", mission.id, e)

    action = (decision or {}).get("action")
    if action not in ("finish", "wait", "exec_shell") or (
        action == "exec_shell" and not str((decision or {}).get("command") or "").strip()
    ):
        failures = int((mission.context or {}).get("decision_failures", 0)) + 1
        if failures >= MAX_DECISION_FAILURES:
            await _fail(db, mission, f"连续 {failures} 次没能从模型拿到可执行的下一步，任务已停止")
            return True
        retry_at = now + timedelta(seconds=60 * 2 ** (failures - 1))
        _set_context(mission, decision_failures=failures, wait_until=retry_at.isoformat())
        await db.commit()
        return recorded
    _set_context(mission, decision_failures=None)
    assert decision is not None

    if action == "finish":
        mission.status = "succeeded"
        mission.summary = str(decision.get("summary") or "任务已顺利完成")
        _add_step(mission, {"type": "finish", "summary": mission.summary, "finished_at": now.isoformat()})
        await db.commit()
        await notify_user(
            mission.user_id,
            kind="task_done",
            title=f"✅ 任务完成: {mission.title}",
            body=mission.summary[:200],
            url=_missions_url(),
        )
        return True

    if action == "wait":
        try:
            wait_sec = int(decision.get("seconds", 60))
        except (TypeError, ValueError):
            wait_sec = 60
        wait_sec = max(0, min(wait_sec, MAX_WAIT_SECONDS))
        _add_step(mission, {
            "type": "wait",
            "seconds": wait_sec,
            "reason": decision.get("reason", "等待中"),
            "timestamp": now.isoformat(),
        })
        _set_context(mission, wait_until=(now + timedelta(seconds=wait_sec)).isoformat())
        await db.commit()
        return True

    cmd = str(decision.get("command")).strip()
    reason = str(decision.get("reason") or "")
    device_hint = str(decision.get("device_id") or "").strip() or None
    risk = classify_shell_command(cmd)
    risk_level = risk.level if risk else "low"
    risk_reasons = risk.reasons if risk else []
    auto_approve_warn = (user.proactive_settings or {}).get("auto_approve_safe", True)
    requires_approval = risk_level in ("danger", "critical") or (risk_level == "warn" and not auto_approve_warn)

    if not requires_approval:
        return await _dispatch_remote_shell(db, mission, user, cmd, reason, device_hint)

    token = secrets.token_urlsafe(32)
    mission.status = "waiting_approval"
    mission.approval_token = token
    mission.pending_action = {
        "action": "exec_shell",
        "command": cmd,
        "reason": reason,
        "device_id": device_hint,
        "risk_level": risk_level,
        "risk_reasons": risk_reasons,
    }
    flag_modified(mission, "pending_action")
    _add_step(mission, {
        "type": "waiting_approval",
        "command": cmd,
        "risk_level": risk_level,
        "risk_reasons": risk_reasons,
        "requested_at": now.isoformat(),
    })
    await db.commit()

    path = f"/api/missions/{mission.id}/approve?token={token}"
    await notify_user(
        mission.user_id,
        kind="risky",
        title=f"🚨 任务需要授权: {mission.title}",
        body=f"AI 拟执行高危命令: {cmd}\n原因: {reason or '继续执行任务'}",
        url=f"{settings.public_url.rstrip('/')}{path}" if settings.public_url else path,
    )
    return True


async def _pick_machine(db: AsyncSession, user: User, device_hint: str | None) -> tuple[list[Machine], Machine | None]:
    """The user's active devices, and the one to run on: the named one if it is online, else the
    most recently seen online one. None when no device is online."""
    machines = list((await db.execute(
        select(Machine)
        .where(
            Machine.user_id == user.id,
            Machine.merged_into.is_(None),
            Machine.is_archived.is_not(True),
        )
        .order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().all())
    online = [m for m in machines if ws_alias(m.collector_token_hash, m)]
    if device_hint:
        hint = device_hint.lower()
        named = [
            m for m in online
            if hint in {(m.name or "").lower(), normalize_device_name(m.name).lower(), m.collector_token_hash.lower(), str(m.id)}
        ]
        if named:
            return machines, named[0]
    return machines, (online[0] if online else None)


async def _dispatch_remote_shell(
    db: AsyncSession,
    mission: AgentMission,
    user: User,
    command: str,
    reason: str,
    device_hint: str | None = None,
) -> bool:
    """Send the command to one of the user's online devices and remember the task to wait for.
    With no device online, record why and look again after OFFLINE_RETRY_SECONDS."""
    now = _now()
    machines, target = await _pick_machine(db, user, device_hint)
    if target is None:
        _add_step(mission, {
            "type": "error",
            "message": "无法执行命令：用户未绑定任何终端设备" if not machines else "无法执行命令：没有在线的设备，稍后再试",
            "command": command,
            "timestamp": now.isoformat(),
        })
        _set_context(mission, wait_until=(now + timedelta(seconds=OFFLINE_RETRY_SECONDS)).isoformat())
        await db.commit()
        return False

    dev_task = DeviceTask(
        id=uuid.uuid4(),
        device_id=target.collector_token_hash,
        machine_id=target.id,
        user_id=user.id,
        action="shell",
        payload={"command": command, "mission_id": str(mission.id)},
        timeout_seconds=SHELL_TIMEOUT_SECONDS,
        status="queued",
        created_at=now,
    )
    db.add(dev_task)
    _set_context(mission, active_device_task_id=str(dev_task.id))
    _add_step(mission, {
        "type": "exec_shell",
        "command": command,
        "reason": reason,
        "device_name": target.name,
        "device_task_id": str(dev_task.id),
        "dispatched_at": now.isoformat(),
    })
    await db.commit()
    # Not sent means the task is already failed; the next step records that like any other result.
    sent = await deliver_task(db, dev_task, target)
    logger.info("Mission %s %s shell on %s: %s", mission.id, "sent" if sent else "could not send", target.name, command)
    return True


async def approve_mission(db: AsyncSession, mission_id: uuid.UUID, token: str | None, user_id: uuid.UUID | None) -> bool:
    """Approve the pending command (by the link's token, or as the mission's owner) and send it."""
    mission = (await db.execute(select(AgentMission).where(AgentMission.id == mission_id))).scalar_one_or_none()
    if not mission or mission.status != "waiting_approval":
        return False

    token_valid = token and mission.approval_token and secrets.compare_digest(token, mission.approval_token)
    user_valid = user_id and mission.user_id == user_id
    if not (token_valid or user_valid):
        return False

    pending = mission.pending_action or {}
    mission.status = "running"
    mission.approval_token = None
    mission.pending_action = None
    flag_modified(mission, "pending_action")
    _add_step(mission, {"type": "approved", "action": pending, "approved_at": _now().isoformat()})
    await db.commit()

    user = (await db.execute(select(User).where(User.id == mission.user_id))).scalar_one_or_none()
    if user and pending.get("action") == "exec_shell" and pending.get("command"):
        await _dispatch_remote_shell(
            db, mission, user, pending["command"], pending.get("reason") or "用户已审批放行", pending.get("device_id"),
        )
    return True


async def reject_mission(
    db: AsyncSession, mission_id: uuid.UUID, token: str | None, user_id: uuid.UUID | None, reason: str = "用户驳回"
) -> bool:
    """Reject the pending command; the mission is cancelled."""
    mission = (await db.execute(select(AgentMission).where(AgentMission.id == mission_id))).scalar_one_or_none()
    if not mission or mission.status != "waiting_approval":
        return False

    token_valid = token and mission.approval_token and secrets.compare_digest(token, mission.approval_token)
    user_valid = user_id and mission.user_id == user_id
    if not (token_valid or user_valid):
        return False

    mission.status = "cancelled"
    mission.approval_token = None
    mission.pending_action = None
    mission.summary = f"任务已由用户驳回取消: {reason}"
    flag_modified(mission, "pending_action")
    _add_step(mission, {"type": "rejected", "reason": reason, "rejected_at": _now().isoformat()})
    await db.commit()
    return True
