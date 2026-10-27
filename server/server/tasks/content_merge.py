"""Celery task: append the deltas staged for big conversations, see services/content_staging.py."""

from __future__ import annotations

import asyncio
import logging

from ..db.session import async_session_factory, engine
from ..services.content_staging import merge_due
from .celery_app import celery_app

logger = logging.getLogger("content_merge")


async def _run() -> dict:
    try:
        return await merge_due(async_session_factory, engine, budget_seconds=50.0)
    finally:
        # Each run has its own event loop: pooled connections from this one can't be reused.
        await engine.dispose()


@celery_app.task(name="server.tasks.content_merge.merge_staged_deltas", acks_late=True, expires=55)
def merge_staged_deltas() -> dict:
    try:
        stats = asyncio.run(_run())
        if stats.get("documents"):
            logger.info("Merged staged deltas: %s", stats)
        return stats
    except Exception as e:
        logger.warning("merge_staged_deltas errored: %s", e)
        return {"error": str(e)[:200]}
