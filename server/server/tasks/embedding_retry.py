"""Celery task: the embedding sweep.

Ingest marks changed documents ``pending``; every minute this embeds the ones
that went quiet (or waited too long) and retries failures with backoff, see
``embedding_service.embed_pending_documents``. Nothing is given up on: a
document that keeps failing is retried every few hours.
"""

from __future__ import annotations

import asyncio
import logging

from ..db.session import async_session_factory, engine
from ..services.embedding_service import embed_pending_documents
from .celery_app import celery_app

logger = logging.getLogger("embedding_retry")


@celery_app.task(
    name="server.tasks.embedding_retry.retry_failed_embeddings",
    # No autoretry: the beat re-fires every minute, and autoretry caused
    # asyncio event-loop conflicts when the retry queued before the previous
    # run's engine/connection pool had finished teardown ("Future attached to
    # a different loop" / "another operation is in progress").
    acks_late=True,
    # A run that waited longer than its own budget is stale; the next tick covers it.
    expires=55,
)
def retry_failed_embeddings() -> dict:
    try:
        stats = asyncio.run(embed_pending_documents(async_session_factory, engine, budget_seconds=50.0))
        if stats.get("chunks") or stats.get("failed"):
            logger.info("Embedding sweep: %s", stats)
        return stats
    except Exception as e:
        logger.warning("Embedding sweep errored: %s", e)
        return {"error": str(e)[:200]}
