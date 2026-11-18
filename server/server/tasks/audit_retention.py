"""Celery task: drop audit log entries older than MEMENTO_AUDIT_RETENTION_DAYS (0 keeps them all)."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete

from ..config import settings
from ..db.models import AccessLog
from ..db.session import async_session_factory, engine
from .celery_app import celery_app

logger = logging.getLogger("audit_retention")


async def _run() -> dict:
    days = int(settings.audit_retention_days or 0)
    if days <= 0:
        return {"kept": "all"}
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    try:
        async with async_session_factory() as db:
            res = await db.execute(delete(AccessLog).where(AccessLog.created_at < cutoff))
            await db.commit()
        removed = res.rowcount or 0
        if removed:
            logger.info("removed %d audit entries older than %d days", removed, days)
        return {"removed": removed, "days": days}
    finally:
        await engine.dispose()


@celery_app.task(name="server.tasks.audit_retention.purge_old_audit_entries", acks_late=True, expires=3000)
def purge_old_audit_entries() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("purge_old_audit_entries errored: %s", e)
        return {"error": str(e)[:200]}
