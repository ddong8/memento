"""Celery task: retry documents whose knowledge-graph extraction failed.

Mirrors the embedding_retry pattern. The post-ingest extract call runs
through an OpenAI-compatible LLM and is **much** flakier than embedding
(network blips, API-key expiry, rate limiting, JSON parse glitches).
Without this task a single LLM hiccup at ingest time drops a doc out of
the knowledge graph forever — and a doc not in the graph never appears
in the shared "memory" share-link, in `memory_graph()` MCP results, or
in exported `.md` knowledge-graph appendices.

Note: BATCH_SIZE is intentionally smaller than embedding_retry (which
runs at 20) because the LLM is the bottleneck — pushing 20 docs in
parallel hits rate limits before it helps throughput.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from ..db.models import Document
from ..db.session import async_session_factory
from ..services.graph_service import extract_knowledge_from_document
from .celery_app import celery_app

logger = logging.getLogger("knowledge_retry")

# LLM failures are sticky (API key expired) more often than transient,
# so we don't keep hammering a doc forever. After this many attempts
# the doc stays 'failed' until manual intervention.
MAX_ATTEMPTS = 5
BATCH_SIZE = 8


async def _run() -> dict:
    async with async_session_factory() as db:
        docs = (await db.execute(
            select(Document)
            .where(
                # Both 'pending' (post-ingest task never ran — e.g. server
                # restarted mid-ingest) and 'failed' (LLM errored) are
                # retry candidates. 'ok' / 'skipped' stay put.
                Document.knowledge_status.in_(("failed", "pending")),
                Document.knowledge_attempts < MAX_ATTEMPTS,
            )
            .limit(BATCH_SIZE)
        )).scalars().all()

        retried = 0
        recovered = 0
        for doc in docs:
            try:
                n = await extract_knowledge_from_document(db, doc)
                retried += 1
                if n > 0 or doc.knowledge_status == "ok":
                    recovered += 1
                await db.commit()
            except Exception as e:
                await db.rollback()
                logger.warning("Knowledge retry crashed for %s: %s", doc.relative_path, e)

        return {"scanned": len(docs), "retried": retried, "recovered": recovered}


@celery_app.task(
    name="server.tasks.knowledge_retry.retry_failed_knowledge",
    # No autoretry — beat re-fires every 15 min anyway and chained
    # autoretries hit the same loop-disposal issue documented in
    # embedding_retry.py.
    acks_late=True,
)
def retry_failed_knowledge() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.warning("retry_failed_knowledge errored: %s", e)
        return {"scanned": 0, "retried": 0, "recovered": 0, "error": str(e)[:200]}
