"""24/7 Autonomous Agent Mission Service.

Manages persistent long-running missions across restarts, schedules steps,
evaluates risk policies, dispatches remote device execution, and manages human-in-the-loop approvals.
"""

from __future__ import annotations

import json
import logging
import secrets
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from ..config import settings
from ..db.models import AgentMission, DeviceTask, Machine, User
from .ai_provider import call_plain_chat
from .notify_service import notify_user
from .risk_policy import classify_shell_command

logger = logging.getLogger("server.mission_service")


async def create_mission(
    db: AsyncSession,
    user: User,
    title: str,
    goal: str,
    context: dict[str, Any] | None = None,
    risk_level: str = "low",
) -> AgentMission:
    """Create a new autonomous background mission and start it."""
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
            "created_at": datetime.now(timezone.utc).isoformat(),
        }],
        context=context or {},
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
        last_heartbeat=datetime.now(timezone.utc),
    )
    db.add(mission)
    await db.commit()
    await db.refresh(mission)
    logger.info("Created autonomous mission %s for user %s: %s", mission.id, user.id, title)
    return mission


async def step_mission(db: AsyncSession, mission: AgentMission) -> bool:
    """Advance one step of an autonomous mission.
    
    Returns True if work was performed, False if paused/waiting or completed.
    """
    if mission.status != "running":
        return False

    mission.last_heartbeat = datetime.now(timezone.utc)
    mission.updated_at = datetime.now(timezone.utc)

    # 1. Fetch user to check settings and notification preferences
    user = (await db.execute(select(User).where(User.id == mission.user_id))).scalar_one_or_none()
    if not user:
        mission.status = "failed"
        mission.error = "User not found"
        await db.commit()
        return False

    # 2. Check if there are active device tasks currently running for this mission
    if mission.context.get("active_device_task_id"):
        task_id = mission.context["active_device_task_id"]
        dev_task = (await db.execute(select(DeviceTask).where(DeviceTask.id == uuid.UUID(task_id)))).scalar_one_or_none()
        if dev_task:
            if dev_task.status in ("queued", "running"):
                # Still executing on device; wait for next pulse
                return False
            # Completed or failed
            res_summary = (dev_task.stdout or dev_task.stderr or dev_task.error or "")[:500]
            mission.steps.append({
                "step": mission.current_step + 1,
                "type": "device_task_result",
                "device_task_id": str(dev_task.id),
                "exit_code": dev_task.exit_code,
                "status": dev_task.status,
                "output_preview": res_summary,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            })
            mission.current_step += 1
            mission.context.pop("active_device_task_id", None)
            await db.commit()

    # 3. Planning & Next Action via LLM
    prompt = f"""你是一个运行在服务器后台的全天候自主 AI 助手。
你正在全天候为用户执行一项后台长任务：
任务标题: {mission.title}
最终目标: {mission.goal}
当前执行步骤进度: {mission.current_step}

已执行的历史步骤:
{json.dumps(mission.steps[-5:], ensure_ascii=False, indent=2)}

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

    try:
        reply = await call_plain_chat([{"role": "user", "content": prompt}], user=user, background=True)
        if not reply:
            return False
        # Parse JSON
        clean_text = reply.strip()
        if clean_text.startswith("```json"):
            clean_text = clean_text[7:]
        if clean_text.startswith("```"):
            clean_text = clean_text[3:]
        if clean_text.endswith("```"):
            clean_text = clean_text[:-3]
        decision = json.loads(clean_text.strip())
    except Exception as e:
        logger.warning("Mission %s LLM decision failed: %s", mission.id, e)
        return False

    action = decision.get("action")

    if action == "finish":
        mission.status = "succeeded"
        mission.summary = decision.get("summary", "任务已顺利完成")
        mission.steps.append({
            "step": mission.current_step + 1,
            "type": "finish",
            "summary": mission.summary,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })
        mission.current_step += 1
        flag_modified(mission, "steps")
        await db.commit()
        # Push notification to user
        await notify_user(
            mission.user_id,
            kind="task_done",
            title=f"✅ 任务完成: {mission.title}",
            body=mission.summary[:200],
            url=f"{settings.public_url.rstrip('/')}/tasks" if settings.public_url else "/tasks",
        )
        return True

    elif action == "wait":
        wait_sec = min(int(decision.get("seconds", 60)), 3600)
        mission.steps.append({
            "step": mission.current_step + 1,
            "type": "wait",
            "seconds": wait_sec,
            "reason": decision.get("reason", "等待中"),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        mission.current_step += 1
        flag_modified(mission, "steps")
        await db.commit()
        return True

    elif action == "exec_shell":
        cmd = decision.get("command", "").strip()
        if not cmd:
            return False

        # Classify risk safely
        risk = classify_shell_command(cmd)
        risk_level = risk.level if risk else "low"
        risk_reasons = risk.reasons if risk else []
        requires_approval = risk_level in ("danger", "critical") or (
            risk_level == "warn" and not user.proactive_settings.get("auto_approve_safe", True)
        )

        if requires_approval:
            # High risk: pause mission and ask for approval
            token = secrets.token_urlsafe(32)
            mission.status = "waiting_approval"
            mission.approval_token = token
            mission.pending_action = {
                "action": "exec_shell",
                "command": cmd,
                "reason": decision.get("reason", ""),
                "risk_level": risk_level,
                "risk_reasons": risk_reasons,
            }
            mission.steps.append({
                "step": mission.current_step + 1,
                "type": "waiting_approval",
                "command": cmd,
                "risk_level": risk_level,
                "risk_reasons": risk_reasons,
                "requested_at": datetime.now(timezone.utc).isoformat(),
            })
            mission.current_step += 1
            flag_modified(mission, "pending_action")
            flag_modified(mission, "steps")
            await db.commit()

            # Push approval notification to user's phone
            approve_url = (
                f"{settings.public_url.rstrip('/')}/api/missions/{mission.id}/approve?token={token}"
                if settings.public_url else f"/api/missions/{mission.id}/approve?token={token}"
            )
            await notify_user(
                mission.user_id,
                kind="risky",
                title=f"🚨 任务需要授权: {mission.title}",
                body=f"AI 拟执行高危命令: {cmd}\n原因: {decision.get('reason', '继续执行任务')}",
                url=approve_url,
            )
            return True
        else:
            # Low/Safe risk: dispatch directly to an online device
            return await _dispatch_remote_shell(db, mission, user, cmd, decision.get("reason", ""))

    return False


async def _dispatch_remote_shell(
    db: AsyncSession,
    mission: AgentMission,
    user: User,
    command: str,
    reason: str,
) -> bool:
    """Find an online machine of the user and dispatch a DeviceTask."""
    machines = (await db.execute(
        select(Machine)
        .where(Machine.user_id == user.id)
        .order_by(Machine.last_heartbeat.desc().nulls_last())
    )).scalars().all()

    if not machines:
        mission.steps.append({
            "step": mission.current_step + 1,
            "type": "error",
            "message": "无法执行命令：用户未绑定任何终端设备",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        mission.current_step += 1
        await db.commit()
        return False

    target_machine = machines[0]
    dev_task = DeviceTask(
        id=uuid.uuid4(),
        device_id=target_machine.collector_token_hash,
        machine_id=target_machine.id,
        user_id=user.id,
        action="shell",
        payload={"command": command, "cwd": None},
        status="queued",
        created_at=datetime.now(timezone.utc),
    )
    db.add(dev_task)

    mission.context["active_device_task_id"] = str(dev_task.id)
    mission.steps.append({
        "step": mission.current_step + 1,
        "type": "exec_shell",
        "command": command,
        "reason": reason,
        "device_name": target_machine.name,
        "device_task_id": str(dev_task.id),
        "dispatched_at": datetime.now(timezone.utc).isoformat(),
    })
    mission.current_step += 1
    flag_modified(mission, "context")
    flag_modified(mission, "steps")
    await db.commit()
    logger.info("Mission %s dispatched remote shell on %s: %s", mission.id, target_machine.name, command)
    return True


async def approve_mission(db: AsyncSession, mission_id: uuid.UUID, token: str | None, user_id: uuid.UUID | None) -> bool:
    """Approve a pending risky action on a mission and resume execution."""
    mission = (await db.execute(select(AgentMission).where(AgentMission.id == mission_id))).scalar_one_or_none()
    if not mission or mission.status != "waiting_approval":
        return False

    # Check token or user_id match
    token_valid = token and mission.approval_token and secrets.compare_digest(token, mission.approval_token)
    user_valid = user_id and mission.user_id == user_id

    if not (token_valid or user_valid):
        return False

    pending = mission.pending_action or {}
    mission.status = "running"
    mission.approval_token = None
    mission.pending_action = None
    mission.steps.append({
        "step": mission.current_step + 1,
        "type": "approved",
        "action": pending,
        "approved_at": datetime.now(timezone.utc).isoformat(),
    })
    mission.current_step += 1
    flag_modified(mission, "pending_action")
    flag_modified(mission, "steps")
    await db.commit()

    # Immediately execute the approved action
    user = (await db.execute(select(User).where(User.id == mission.user_id))).scalar_one_or_none()
    if user and pending.get("action") == "exec_shell":
        await _dispatch_remote_shell(db, mission, user, pending.get("command", ""), pending.get("reason", "用户已审批放行"))

    return True


async def reject_mission(
    db: AsyncSession, mission_id: uuid.UUID, token: str | None, user_id: uuid.UUID | None, reason: str = "用户驳回"
) -> bool:
    """Reject a pending risky action on a mission and cancel or pause it."""
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
    mission.steps.append({
        "step": mission.current_step + 1,
        "type": "rejected",
        "reason": reason,
        "rejected_at": datetime.now(timezone.utc).isoformat(),
    })
    mission.current_step += 1
    flag_modified(mission, "pending_action")
    flag_modified(mission, "steps")
    await db.commit()
    return True
