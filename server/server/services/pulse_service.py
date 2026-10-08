"""24/7 Always-On Proactive Agent Pulse Service.

Continuously runs in the background. Coordinates:
- Morning briefings (todos, active devices, focus tasks)
- Evening reflections & memory dreaming (evolving personas & skills)
- Device heartbeat & infrastructure health monitoring
- Autonomous background mission progression
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import AgentMission, Machine, Todo, User
from ..db.session import async_session_factory
from . import ai_health, mission_service
from .ai_provider import call_plain_chat
from .dreaming_service import run_dreaming_pipeline
from .notify_service import notify_user

logger = logging.getLogger("server.pulse")

_pulse_task: asyncio.Task | None = None
_running = False

DEFAULT_PROACTIVE_SETTINGS = {
    "enabled": True,
    "morning_brief_enabled": True,
    "morning_brief_time": "08:30",
    "evening_reflection_enabled": True,
    "evening_reflection_time": "22:30",
    "device_alert_enabled": True,
    "quiet_hours_start": "23:30",
    "quiet_hours_end": "07:30",
    "timezone_offset_hours": 8,  # Default Asia/Shanghai UTC+8
    "auto_approve_safe": True,
}


def get_user_settings(user: User) -> dict[str, Any]:
    raw = user.proactive_settings or {}
    merged = dict(DEFAULT_PROACTIVE_SETTINGS)
    merged.update(raw)
    return merged


def is_in_quiet_hours(user_time: datetime, quiet_start: str, quiet_end: str) -> bool:
    """Check if the given local time falls within quiet hours (e.g. 23:30 to 07:30)."""
    try:
        sh, sm = map(int, quiet_start.split(":"))
        eh, em = map(int, quiet_end.split(":"))
        curr = user_time.hour * 60 + user_time.minute
        start = sh * 60 + sm
        end = eh * 60 + em

        if start <= end:
            return start <= curr <= end
        # Overnight wrap (e.g. 23:30 to 07:30)
        return curr >= start or curr <= end
    except Exception:
        return False


async def start_proactive_pulse() -> None:
    """Start the 24/7 background pulse daemon."""
    global _pulse_task, _running
    if _running:
        return
    _running = True
    _pulse_task = asyncio.create_task(_pulse_loop())
    logger.info("24/7 Proactive Agent Pulse service started.")


async def stop_proactive_pulse() -> None:
    """Stop the background pulse daemon."""
    global _pulse_task, _running
    _running = False
    if _pulse_task:
        _pulse_task.cancel()
        try:
            await _pulse_task
        except asyncio.CancelledError:
            pass
        _pulse_task = None
    logger.info("24/7 Proactive Agent Pulse service stopped.")


async def _pulse_loop() -> None:
    """Infinite loop executing the proactive agent heartbeat every 60 seconds."""
    # Warmup delay on server boot
    await asyncio.sleep(15)

    while _running:
        try:
            async with async_session_factory() as db:
                await _execute_pulse_cycle(db)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.exception("Error in proactive pulse cycle: %s", e)

        await asyncio.sleep(60)


async def _execute_pulse_cycle(db: AsyncSession) -> None:
    """Run one heartbeat check across all registered users."""
    users = (await db.execute(select(User).where(User.status.in_(["active", "pending"])))).scalars().all()
    now_utc = datetime.now(timezone.utc)

    for user in users:
        prefs = get_user_settings(user)
        if not prefs.get("enabled", True):
            continue

        offset = prefs.get("timezone_offset_hours", 8)
        user_now = now_utc + timedelta(hours=offset)
        user_date_str = user_now.strftime("%Y-%m-%d")
        user_time_str = user_now.strftime("%H:%M")
        in_quiet = is_in_quiet_hours(
            user_now, prefs.get("quiet_hours_start", "23:30"), prefs.get("quiet_hours_end", "07:30")
        )

        # 1. Autonomous Missions progression (runs 24/7 even during quiet hours)
        try:
            await _advance_user_missions(db, user)
        except Exception as e:
            logger.warning("Error advancing missions for user %s: %s", user.id, e)

        # Skip notifications during quiet hours
        if in_quiet:
            continue

        # 2. Morning Briefing
        if prefs.get("morning_brief_enabled", True):
            target_time = prefs.get("morning_brief_time", "08:30")
            if user_time_str >= target_time and user_time_str <= "11:30":
                key = f"proactive:morning:{user.id}:{user_date_str}"
                already_sent = await ai_health.get_json(key)
                if not already_sent:
                    await _send_morning_brief(db, user, user_now)
                    await ai_health.put_json(key, {"sent_at": now_utc.isoformat()})

        # 3. Evening Reflection & Self-evolution (Memory Dreaming)
        if prefs.get("evening_reflection_enabled", True):
            target_time = prefs.get("evening_reflection_time", "22:30")
            if user_time_str >= target_time and user_time_str <= "23:59":
                key = f"proactive:evening:{user.id}:{user_date_str}"
                already_sent = await ai_health.get_json(key)
                if not already_sent:
                    await _send_evening_reflection(db, user, user_now)
                    await ai_health.put_json(key, {"sent_at": now_utc.isoformat()})

        # 4. Device Status Monitoring
        if prefs.get("device_alert_enabled", True):
            await _check_device_alerts(db, user, now_utc)


async def _advance_user_missions(db: AsyncSession, user: User) -> None:
    """Step active background missions for a user."""
    missions = (await db.execute(
        select(AgentMission)
        .where(AgentMission.user_id == user.id, AgentMission.status == "running")
        .order_by(AgentMission.last_heartbeat.asc())
        .limit(3)
    )).scalars().all()

    for m in missions:
        try:
            await mission_service.step_mission(db, m)
        except Exception as e:
            logger.warning("Failed to step mission %s: %s", m.id, e)


async def _send_morning_brief(db: AsyncSession, user: User, user_now: datetime) -> None:
    """Generate and push a concise morning brief."""
    # Gather open todos
    open_todos = (await db.execute(
        select(Todo)
        .where(Todo.user_id == user.id, Todo.status == "open")
        .order_by(Todo.due_at.asc().nulls_last())
        .limit(5)
    )).scalars().all()

    # Gather machines
    machines = (await db.execute(
        select(Machine).where(Machine.user_id == user.id)
    )).scalars().all()
    now_ts = user_now.timestamp() * 1000
    online_count = sum(
        1 for m in machines
        if m.last_heartbeat and (datetime.now(timezone.utc) - m.last_heartbeat).total_seconds() < 180
    )

    todo_lines = [
        f"- {t.title}" + (f" (截止: {t.due_at.strftime('%m/%d %H:%M')})" if t.due_at else "")
        for t in open_todos
    ]
    todo_text = "\n".join(todo_lines) if todo_lines else "暂无逾期待办事项，今天状态很好！"

    prompt = f"""你是用户的全天候私人 AI 执事。现在是早上，请为用户撰写今日晨间简报。
语气：沉稳、干练、温暖有力量。不要说废话，控制在 100-140 字内。

【今日信息】
日期：{user_now.strftime('%Y年%m月%d日')}
在线设备数：{online_count} 台 (总设备 {len(machines)} 台)
当前未完成待办：
{todo_text}

请直接输出晨报正文，适合手机推送阅读："""

    try:
        body = await call_plain_chat([{"role": "user", "content": prompt}], background=True, user=user)
        title = f"🌅 早上好！今日晨间简报 · {user_now.strftime('%m/%d')}"
        await notify_user(
            user.id,
            kind="todo",
            title=title,
            body=body.strip(),
            url=f"{settings.public_url.rstrip('/')}/daily" if settings.public_url else "/daily",
        )
        logger.info("Sent morning brief to user %s", user.id)
    except Exception as e:
        logger.warning("Failed to generate morning brief for user %s: %s", user.id, e)


async def _send_evening_reflection(db: AsyncSession, user: User, user_now: datetime) -> None:
    """Trigger nightly memory dreaming pipeline and push evening reflection summary."""
    try:
        # Run dreaming pipeline to distill memories, persona, and daily summary
        target_date = user_now.date()
        result = await run_dreaming_pipeline(
            db, user, start_date=target_date, end_date=target_date, tag="nightly"
        )

        distilled_count = 0
        if hasattr(result, "stage_metrics") and isinstance(result.stage_metrics, dict):
            distilled_count = result.stage_metrics.get("promoted_count", 0)
        elif isinstance(result, dict):
            distilled_count = result.get("memories_distilled", result.get("promoted_count", 0))
        title = "🌌 晚间梦境自进化完成"
        body = (
            f"今日工作沉淀已完成！已自动吸收碎片记忆，更新画像偏好与避坑规则（提炼 {distilled_count} 条核心洞察）。"
            "辛苦了一天，好好休息！"
        )

        await notify_user(
            user.id,
            kind="learning",
            title=title,
            body=body,
            url=f"{settings.public_url.rstrip('/')}/daily" if settings.public_url else "/daily",
        )
        logger.info("Executed evening reflection dreaming for user %s", user.id)
    except Exception as e:
        logger.warning("Failed to execute evening reflection for user %s: %s", user.id, e)


async def _check_device_alerts(db: AsyncSession, user: User, now_utc: datetime) -> None:
    """Check for devices that unexpectedly dropped offline."""
    machines = (await db.execute(
        select(Machine).where(Machine.user_id == user.id)
    )).scalars().all()

    for m in machines:
        if not m.last_heartbeat:
            continue
        offline_sec = (now_utc - m.last_heartbeat).total_seconds()
        # If offline between 5 and 15 minutes, send an alert once
        if 300 < offline_sec < 900:
            key = f"alert:device_offline:{m.id}:{now_utc.strftime('%Y%m%d%H')}"
            already_alerted = await ai_health.get_json(key)
            if not already_alerted:
                await notify_user(
                    user.id,
                    kind="health",
                    title="⚠️ 设备离线提醒",
                    body=f"终端设备「{m.name}」已超过 5 分钟未上报心跳，部分后台任务可能挂起。",
                    url=f"{settings.public_url.rstrip('/')}/profile?tab=devices" if settings.public_url else "/profile?tab=devices",
                )
                await ai_health.put_json(key, {"alerted_at": now_utc.isoformat()})
