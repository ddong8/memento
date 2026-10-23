"""Celery task: push to the phone when AI calls start failing, or are about to.

Background jobs (graph extraction, summaries, dreaming, the profile draft) fail
quietly by design, so without this nobody notices until the memory stops
getting better. Checks the last hour every 30 minutes; one push per 6 hours.
Also warns once a day while the DeepSeek balance is below MEMENTO_AI_BALANCE_ALERT.

Alerts go to the people who run this server (owner / admin), not to every
registered user: they are about the server, not about anyone's own data.
"""

from __future__ import annotations

import asyncio
import logging
import os
from urllib.parse import urlparse

import httpx
from sqlalchemy import select

from ..db.models import User
from ..db.session import async_session_factory, engine
from ..services import ai_health
from ..services.health_service import ai_failing, top_reasons
from ..services.notify_service import notify_user
from .celery_app import celery_app

logger = logging.getLogger("health_check")

ALERT_COOLDOWN = 6 * 3600
BALANCE_ALERT_COOLDOWN = 24 * 3600


def balance_alert_threshold() -> float:
    """Warn when the AI account balance falls below this (MEMENTO_AI_BALANCE_ALERT, in the account's currency)."""
    try:
        return float(os.environ.get("MEMENTO_AI_BALANCE_ALERT", "10"))
    except ValueError:
        return 10.0


async def deepseek_balance() -> tuple[float, str] | None:
    """(balance, currency) of the primary AI account when it is DeepSeek's own API, else None."""
    base = os.environ.get("MEMENTO_AI_BASE_URL", "").rstrip("/")
    key = os.environ.get("MEMENTO_AI_API_KEY", "").strip()
    if not key or urlparse(base).hostname != "api.deepseek.com":
        return None
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(f"{base}/user/balance", headers={"Authorization": f"Bearer {key}"})
        resp.raise_for_status()
        data = resp.json()
    infos = data.get("balance_infos") or []
    if not infos:
        return None
    return float(infos[0].get("total_balance") or 0), str(infos[0].get("currency") or "")


async def _admins() -> list:
    async with async_session_factory() as db:
        return list((await db.execute(
            select(User.id).where(User.status == "active", User.role.in_(("owner", "admin")))
        )).scalars().all())


async def _notify_admins(kind: str, title: str, body: str, url: str) -> int:
    sent = 0
    for uid in await _admins():
        sent += bool(await notify_user(uid, kind, title, body, url=url))
    return sent


async def _check_failures() -> int:
    last_hour = await ai_health.summary(1)
    if not ai_failing(last_hour) or not await ai_health.claim_alert("ai_failing", ALERT_COOLDOWN):
        return 0
    calls = last_hour["calls"]
    reasons = top_reasons(last_hour)
    body = f"最近 1 小时 {calls['failed']}/{calls['total']} 次 AI 调用失败" + (f"，主要原因：{reasons}" if reasons else "")
    body += "。在 Memento「设备 → 系统健康」查看详情。"
    return await _notify_admins("health", "Memento AI 调用异常", body, "/profile?tab=health")


async def _check_balance() -> int:
    try:
        found = await deepseek_balance()
    except Exception as e:
        logger.info("Reading the DeepSeek balance failed: %s", e)
        return 0
    threshold = balance_alert_threshold()
    if found is None or found[0] >= threshold:
        return 0
    if not await ai_health.claim_alert("ai_balance_low", BALANCE_ALERT_COOLDOWN):
        return 0
    balance, currency = found
    body = f"DeepSeek 账户余额只剩 {balance:.2f} {currency}（提醒线 {threshold:g}），用完后问答、知识抽取、摘要都会失败，请尽快充值。"
    return await _notify_admins("health", "Memento AI 余额不足", body, "/profile?tab=health")


async def _run() -> dict:
    try:
        return {"alerted": await _check_failures(), "balance_alerted": await _check_balance()}
    finally:
        # Each run has its own event loop: pooled connections from this one can't be reused.
        await engine.dispose()


@celery_app.task(name="server.tasks.health_check.check_health", acks_late=True)
def check_health() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("check_health errored: %s", e)
        return {"alerted": 0, "error": str(e)[:200]}
