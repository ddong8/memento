"""Celery task: check conversation_messages against the conversations' texts, see services/message_audit.py."""

from __future__ import annotations

import asyncio
import logging

from ..config import settings
from ..db.session import async_session_factory, engine
from ..services.message_audit import audit_due
from .celery_app import celery_app

logger = logging.getLogger("message_audit")


async def _run() -> dict:
    import redis.asyncio as aioredis

    # services/cluster.py isn't started in a worker: a client of its own, for asking devices to resend
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    try:
        return await audit_due(async_session_factory, engine, settings.message_audit_mode, redis, budget_seconds=120.0)
    finally:
        await redis.aclose()
        # Each run has its own event loop: pooled connections from this one can't be reused.
        await engine.dispose()


@celery_app.task(name="server.tasks.message_audit.audit_messages", acks_late=True, expires=240)
def audit_messages() -> dict:
    try:
        stats = asyncio.run(_run())
        if len(stats) > 1:
            logger.info("Audited conversation messages: %s", stats)
        return stats
    except Exception as e:
        logger.warning("audit_messages errored: %s", e)
        return {"error": str(e)[:200]}
