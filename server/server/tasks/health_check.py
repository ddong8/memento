"""Celery task: push to the phone when AI calls start failing.

Background jobs (graph extraction, summaries, dreaming, the profile draft) fail
quietly by design, so without this nobody notices until the memory stops
getting better. Checks the last hour every 30 minutes; one push per 6 hours.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..db.models import User
from ..db.session import async_session_factory
from ..services import ai_health
from ..services.health_service import ai_failing, top_reasons
from ..services.notify_service import notify_user
from .celery_app import celery_app

logger = logging.getLogger("health_check")

ALERT_COOLDOWN = 6 * 3600


async def _run() -> dict:
    last_hour = await ai_health.summary(1)
    if not ai_failing(last_hour) or not await ai_health.claim_alert("ai_failing", ALERT_COOLDOWN):
        return {"alerted": 0}
    calls = last_hour["calls"]
    reasons = top_reasons(last_hour)
    body = f"最近 1 小时 {calls['failed']}/{calls['total']} 次 AI 调用失败" + (f"，主要原因：{reasons}" if reasons else "")
    body += "。在 Memento「设备 → 系统健康」查看详情。"
    async with async_session_factory() as db:
        users = (await db.execute(select(User.id).where(User.status == "active"))).scalars().all()
    sent = 0
    for uid in users:
        sent += bool(await notify_user(uid, "health", "Memento AI 调用异常", body, url="/profile?tab=health"))
    return {"alerted": sent}


@celery_app.task(name="server.tasks.health_check.check_health", acks_late=True)
def check_health() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("check_health errored: %s", e)
        return {"alerted": 0, "error": str(e)[:200]}
