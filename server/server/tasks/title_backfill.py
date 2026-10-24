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
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update

from ..db.models import ConversationMessage, Document
from ..db.session import async_session_factory
from ..services.ingest_service import (
    _extract_latest_ai_title,
    _is_junk_or_uuid_title,
    _parent_session_id_from_content,
    _title_from_user_messages,
)
from .celery_app import celery_app

logger = logging.getLogger("title_backfill")

BATCH_SIZE = 200
# Full transcripts are only read for documents that changed since the runs before (hourly, with margin):
# reading every Claude Code transcript each hour was a third of all the database's disk reads, for titles
# ingest already takes from the lines as they arrive.
CONTENT_WINDOW = timedelta(hours=3)
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

    recent_since = datetime.now(timezone.utc) - CONTENT_WINDOW
    async with async_session_factory() as db:
        while True:
            q = select(
                Document.id, Document.title, Document.metadata_, Document.relative_path, Document.updated_at
            ).order_by(Document.id).limit(BATCH_SIZE)
            if last_id is not None:
                q = q.where(Document.id > last_id)
            rows = (await db.execute(q)).all()
            if not rows:
                break

            for did, title, meta, rel_path, updated_at in rows:
                last_id = did
                recent = updated_at is not None and updated_at >= recent_since
                sid = (meta or {}).get("session_id") if isinstance(meta, dict) else None

                cand = None

                # Subagent (sidechain): the title Claude Code shows is the
                # PARENT conversation's, so inherit it — even when the current
                # title isn't junk. A subagent whose title is its own task
                # prompt ("你是对抗式审查者…") is technically non-junk but still
                # the wrong title, so this deliberately overrides it.
                parent_sid = meta.get("parent_session_id") if isinstance(meta, dict) else None
                # If the link isn't in metadata yet, recover it from the stored
                # transcript — this heals existing subagent docs without waiting
                # for a re-ingest. Only pull the (large) content for paths that
                # look like a subagent transcript, to avoid loading 1MB per doc.
                if not parent_sid and recent and rel_path and ("agent-" in rel_path or "rollout-" in rel_path):
                    doc_content = (await db.execute(
                        select(Document.content).where(Document.id == did)
                    )).scalar_one_or_none()
                    if doc_content:
                        parent_sid = _parent_session_id_from_content(doc_content)
                if parent_sid:
                    from sqlalchemy import or_
                    parent_title = (await db.execute(
                        select(Document.title)
                        .where(
                            or_(
                                Document.metadata_["session_id"].astext == parent_sid,
                                Document.relative_path.like(f"%{parent_sid}%"),
                            )
                        )
                        .limit(1)
                    )).scalar_one_or_none()
                    if parent_title and not _is_junk_or_uuid_title(parent_title, parent_sid):
                        cand = f"审核: {parent_title}" if (rel_path and "rollout-" in rel_path) else parent_title

                # Antigravity brain transcript session_id healing
                if (not sid or sid == "transcript") and rel_path and "brain/" in rel_path:
                    import re
                    bm = re.search(r"brain/([0-9a-fA-F-]+)/", rel_path)
                    if bm:
                        sid = bm.group(1)
                        if isinstance(meta, dict):
                            meta = {**meta, "session_id": sid}
                            await db.execute(update(Document).where(Document.id == did).values(metadata_=meta))

                # Claude Code main conversation: check if document has an aiTitle
                # in content that should take precedence over a raw user prompt
                if not cand and recent and rel_path and "projects/" in rel_path and rel_path.endswith(".jsonl") and not parent_sid:
                    doc_content = (await db.execute(
                        select(Document.content).where(Document.id == did)
                    )).scalar_one_or_none()
                    if doc_content:
                        ai_cand = _extract_latest_ai_title(doc_content)
                        if ai_cand and not _is_junk_or_uuid_title(ai_cand, sid):
                            cand = ai_cand

                # Antigravity main conversation: check if metadata or annotation doc has an official title
                if not cand and rel_path and "antigravity" in rel_path and ("brain/" in rel_path or "conversations/" in rel_path):
                    m_title = (meta or {}).get("title") if isinstance(meta, dict) else None
                    if m_title and not _is_junk_or_uuid_title(str(m_title), sid):
                        cand = str(m_title).strip()
                    if not cand and sid:
                        import re
                        ann_doc = (await db.execute(
                            select(Document).where(
                                Document.tool_id == "antigravity",
                                Document.category == "state",
                                Document.relative_path.like(f"%annotations/{sid}.pbtxt"),
                            ).limit(1)
                        )).scalar_one_or_none()
                        if ann_doc:
                            cand_ann = ann_doc.title
                            if not cand_ann and ann_doc.content:
                                m = re.search(r'title:\s*"([^"]+)"', ann_doc.content)
                                if m:
                                    cand_ann = m.group(1).strip()
                            if cand_ann and "(.*?)" not in cand_ann and not cand_ann.endswith(".pbtxt"):
                                if "\\" in cand_ann:
                                    try:
                                        cand_ann = cand_ann.encode("raw_unicode_escape").decode("unicode_escape")
                                    except Exception:
                                        pass
                                if not _is_junk_or_uuid_title(cand_ann, sid):
                                    cand = cand_ann

                # For non-sidechain docs, only touch junk titles (or Claude Code aiTitles / Antigravity official titles).
                if not cand and not _is_junk_or_uuid_title(title, sid):
                    continue
                scanned += 1

                # Metadata fallback (Codex state_5.sqlite name/title/first prompt),
                # then the stored user messages in order.
                if not cand and isinstance(meta, dict):
                    name_cand = (meta.get("name") or meta.get("title") or meta.get("first_user_message") or "").strip()
                    if name_cand:
                        cand = _title_from_user_messages([name_cand], sid)

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
