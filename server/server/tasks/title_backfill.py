"""Celery task: re-derive titles for documents left with junk titles.

The ingest-time title healer (ingest_service._is_junk_or_uuid_title +
_title_from_user_messages) only runs when a document is (re-)ingested. Rows
that were ingested before the healer — or before a given junk pattern was
recognized — keep their raw worker-ID titles (agent-*, wf_*, UUIDs, the
compaction preamble, …) forever. This backfills them from the conversation
messages already stored for each doc.

Idempotent: only scans docs whose current title is junk, and only writes when
it finds a genuinely better title, so re-running it is cheap and safe.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select, update

from ..db.models import ConversationMessage, Document
from ..db.session import async_session_factory
from ..services.ingest_service import (
    _is_junk_or_uuid_title,
    _title_from_user_messages,
)
from .celery_app import celery_app

logger = logging.getLogger("title_backfill")

BATCH_SIZE = 200
# How many user messages to pull per doc when hunting for a real title. The
# usable prompt is at the top; a compacted session buries it behind at most a
# couple of preamble/system turns, so a small window is plenty.
USER_MSG_LOOKAHEAD = 8


async def _run() -> dict:
    scanned = 0
    healed = 0
    # Track the last id seen so a doc we scan-but-don't-heal doesn't wedge the
    # cursor: filtering only on "junk title" would re-select it every batch.
    last_id = None

    async with async_session_factory() as db:
        while True:
            q = select(Document.id, Document.title, Document.metadata_).order_by(Document.id).limit(BATCH_SIZE)
            if last_id is not None:
                q = q.where(Document.id > last_id)
            rows = (await db.execute(q)).all()
            if not rows:
                break

            for did, title, meta in rows:
                last_id = did
                sid = (meta or {}).get("session_id") if isinstance(meta, dict) else None
                if not _is_junk_or_uuid_title(title, sid):
                    continue
                scanned += 1

                # Metadata fallback first (Codex state_5.sqlite first prompt),
                # then the stored user messages in order.
                cand = None
                if isinstance(meta, dict):
                    fum = (meta.get("first_user_message") or "").strip()
                    if fum:
                        cand = _title_from_user_messages([fum], sid)

                if not cand:
                    msgs = (await db.execute(
                        select(ConversationMessage.content)
                        .where(
                            ConversationMessage.document_id == did,
                            ConversationMessage.role == "user",
                        )
                        .order_by(ConversationMessage.line_number)
                        .limit(USER_MSG_LOOKAHEAD)
                    )).scalars().all()
                    cand = _title_from_user_messages(list(msgs), sid)

                if cand and cand != title:
                    await db.execute(
                        update(Document).where(Document.id == did).values(title=cand)
                    )
                    healed += 1

            await db.commit()
            logger.info("title backfill: scanned %d junk-titled, healed %d", scanned, healed)

    return {"scanned": scanned, "healed": healed}


@celery_app.task(
    name="server.tasks.title_backfill.backfill_titles",
    acks_late=True,
)
def backfill_titles() -> dict:
    try:
        return asyncio.run(_run())
    except Exception as e:
        logger.exception("title backfill errored")
        return {"scanned": 0, "healed": 0, "error": str(e)[:200]}
