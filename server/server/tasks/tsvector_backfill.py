"""Celery task: give every document a full-text index row (document_search).

Ingest writes it as documents sync; this fills in documents that have none
(created before the index existed, or whose ingest failed half way).
Idempotent — only touches documents without a row. Batches to keep memory
flat and commit frequency high.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..db.models import Document, DocumentSearch
from ..db.session import async_session_factory
from ..services.tokenize import tokenize_for_index
from .celery_app import celery_app

logger = logging.getLogger("tsvector_backfill")

BATCH_SIZE = 100


async def _run() -> dict:
    total = 0
    touched = 0
    async with async_session_factory() as db:
        while True:
            rows = (await db.execute(
                select(Document.id, Document.title, func.substr(Document.content, 1, 200_000))
                .outerjoin(DocumentSearch, DocumentSearch.document_id == Document.id)
                .where(DocumentSearch.document_id.is_(None))
                .limit(BATCH_SIZE)
            )).all()
            if not rows:
                break
            for did, title, content in rows:
                total += 1
                tsv_input = await asyncio.to_thread(tokenize_for_index, f"{title or ''} {content or ''}")
                await db.execute(
                    pg_insert(DocumentSearch)
                    .values(document_id=did, content_tsv=func.to_tsvector("simple", tsv_input))
                    .on_conflict_do_nothing(index_elements=[DocumentSearch.document_id])
                )
                touched += 1
            await db.commit()
            logger.info("tsvector backfill: %d done", total)

    return {"scanned": total, "updated": touched}


@celery_app.task(
    name="server.tasks.tsvector_backfill.backfill_content_tsv",
    acks_late=True, time_limit=1800, soft_time_limit=1700,
)
def backfill_content_tsv() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.exception("backfill errored")
        return {"scanned": 0, "updated": 0, "error": str(e)[:200]}
