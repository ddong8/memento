"""24/7 Always-On Proactive Agent Pulse Service.

Continuously runs in the background. Coordinates:
- Morning briefings (todos, active devices, focus tasks)
- Evening reflections (what the day added; the 03:00 dreaming task consolidates it)
- Device heartbeat & infrastructure health monitoring
- Autonomous background mission progression
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import (
    CHAT_MESSAGE, AgentMission, ConversationMessage, CorrectionEvent, CorrectionTopic, Document, Machine, Todo, User,
    UserMemory,
)
from ..db.session import async_session_factory
from . import ai_health, mission_service
from .cluster import cluster
from .ai_provider import call_plain_chat
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
            # One replica runs the pulse (briefs, missions, device alerts); another
            # takes over if it goes away
            async with cluster.leased("pulse") as mine:
                if mine:
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
                    await ai_health.put_json(key, {"sent_at": now_utc.isoformat()})
                    await _send_morning_brief(db, user, user_now)

        # 3. Evening Reflection & Self-evolution (Memory Dreaming)
        if prefs.get("evening_reflection_enabled", True):
            target_time = prefs.get("evening_reflection_time", "22:30")
            if user_time_str >= target_time and user_time_str <= "23:59":
                key = f"proactive:evening:{user.id}:{user_date_str}"
                already_sent = await ai_health.get_json(key)
                if not already_sent:
                    await ai_health.put_json(key, {"sent_at": now_utc.isoformat()})
                    await _send_evening_reflection(db, user, user_now)

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


def evening_summary_text(stats: dict[str, int]) -> str | None:
    """The evening push from the day's counts, or None on a day with nothing in it."""
    parts = []
    if stats["chats"]:
        parts.append(f"今天在 {stats['chats']} 个会话里工作")
    if stats["memories"]:
        parts.append(f"新记下 {stats['memories']} 条记忆")
    if stats["corrections"]:
        repeats = f"（其中 {stats['repeats']} 次是学过还犯）" if stats["repeats"] else ""
        parts.append(f"纠正了 AI {stats['corrections']} 次{repeats}")
    if stats["todos_done"]:
        parts.append(f"完成 {stats['todos_done']} 条待办")
    if not parts:
        return None
    if stats["todos_open"]:
        parts.append(f"还有 {stats['todos_open']} 条待办没做完")
    return "；".join(parts) + "。凌晨 3 点会把今天的内容整理进长期记忆，并更新画像草稿。"


async def _evening_stats(db: AsyncSession, user: User, day_start: datetime, now: datetime) -> dict[str, int]:
    from .user_filter import user_machine_ids

    mids = await user_machine_ids(db, user)
    chats = (
        select(func.count(func.distinct(ConversationMessage.document_id)))
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(
            ConversationMessage.timestamp >= day_start,
            ConversationMessage.timestamp < now,
            CHAT_MESSAGE,
            ~Document.relative_path.like("%/subagents/%"),
        )
    )
    if mids is not None:
        chats = chats.where(Document.machine_id.in_(mids))
    # Same count as correction_stats: dismissed topics were never corrections, and "learned yet
    # repeated" is already_learned (repeat only means the topic came up before).
    corrections = (await db.execute(
        select(func.count(), func.count().filter(CorrectionEvent.already_learned.is_(True)))
        .join(CorrectionTopic, CorrectionTopic.id == CorrectionEvent.topic_id)
        .where(
            CorrectionEvent.user_id == user.id, CorrectionEvent.said_at >= day_start, CorrectionEvent.said_at < now,
            CorrectionTopic.status != "dismissed",
        )
    )).one()
    return {
        "chats": (await db.execute(chats)).scalar() or 0,
        "memories": (await db.execute(select(func.count()).where(
            UserMemory.user_id == user.id, UserMemory.created_at >= day_start, UserMemory.created_at < now,
            UserMemory.status == "active",
        ))).scalar() or 0,
        "corrections": corrections[0] or 0,
        "repeats": corrections[1] or 0,
        "todos_done": (await db.execute(select(func.count()).where(
            Todo.user_id == user.id, Todo.status == "done", Todo.closed_at >= day_start, Todo.closed_at < now,
        ))).scalar() or 0,
        "todos_open": (await db.execute(select(func.count()).where(
            Todo.user_id == user.id, Todo.status == "open",
        ))).scalar() or 0,
    }


async def _send_evening_reflection(db: AsyncSession, user: User, user_now: datetime) -> str | None:
    """Push what the day added and return the text (None on an empty day or a failure).
    Consolidating it is the nightly dreaming task's job (03:00): running the dreaming pipeline
    here too gave two journals a night over overlapping windows and promoted the same memories
    twice (2026-10-07 to 10-26)."""
    try:
        now = datetime.now(timezone.utc)
        local_midnight = user_now.replace(hour=0, minute=0, second=0, microsecond=0)
        day_start = now - (user_now - local_midnight)
        body = evening_summary_text(await _evening_stats(db, user, day_start, now))
        if body is None:
            return None
        await notify_user(
            user.id,
            kind="learning",
            title=f"🌙 今日复盘 · {user_now.strftime('%m/%d')}",
            body=body,
            url=f"{settings.public_url.rstrip('/')}/daily" if settings.public_url else "/daily",
        )
        logger.info("Sent evening reflection to user %s", user.id)
        return body
    except Exception as e:
        await db.rollback()
        logger.warning("Failed to send evening reflection for user %s: %s", user.id, e)
        return None


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
