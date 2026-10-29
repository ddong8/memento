"""Appending to a big conversation without rewriting it on every sync.

Appending a delta to documents.content rewrites the whole value: PostgreSQL keeps a long text out of
line (TOAST) and never edits it in place. A 1.5 KB delta to an 8.6 MB Antigravity conversation wrote
its 2.5 MB compressed copy again, every 15 s while the session ran: on 10-27, 3106 syncs of the four
conversations over 4 MB rewrote 24 GB in a day. Deltas to a conversation already past what the
full-text index reads (past_index; STAGE_MIN_BYTES or more is past it without fetching the text) go
to document_pending_deltas instead, and are appended in one write once the conversation goes quiet
or the oldest has waited MAX_WAIT_SECONDS.

What readers see meanwhile: a conversation's messages (the conversation page, search, embedding,
resume) are extracted from each delta as it arrives, not from documents.content; the content of a
conversation this big serves its start (title, full-text index, previews), which staging never
changes. The document view and the export add the pending tail (with_pending).

The deltas waiting can add up to far more than a text keeps (MAX_CONTENT_CHARS): on 10-30 a 150 MB
log sent again from the start waited in 450 deltas, and the merge that read them all at once was
killed past the worker's 2 GB, every minute. Joining them (_joined) reads only the deltas it keeps.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import timedelta

from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, DocumentPendingDelta
from .tokenize import _MAX_INPUT_CHARS as _MAX_INDEX_INPUT_CHARS

logger = logging.getLogger("content_staging")

# octet_length reads the size from the TOAST pointer without fetching the text. At 4 bytes a
# character at most, 1 MB is over 260k characters: past what the full-text index reads, so
# appending to a staged conversation never changes its index.
STAGE_MIN_BYTES = 1 << 20
assert STAGE_MIN_BYTES // 4 >= _MAX_INDEX_INPUT_CHARS
QUIET_SECONDS = 120
MAX_WAIT_SECONDS = 600

# A conversation's text stops growing here: its start and its latest part are kept. Only the start
# feeds the index and the previews; the messages table holds the whole conversation.
MAX_CONTENT_CHARS = 10_000_000
HEAD_CHARS = 1_000_000


def cap_content(content: str) -> str:
    """The content within MAX_CONTENT_CHARS: whole lines from its start and from its end."""
    if len(content) <= MAX_CONTENT_CHARS:
        return content
    head_end = content.rfind("\n", 0, HEAD_CHARS)
    if head_end <= 0:
        head_end = HEAD_CHARS
    tail_from = len(content) - (MAX_CONTENT_CHARS - head_end - 1)
    line_start = content.find("\n", tail_from) + 1
    if 0 < line_start < len(content):
        tail_from = line_start
    return content[:head_end] + "\n" + content[tail_from:]


def append(content: str | None, delta: str) -> str:
    """The content with a delta appended, as ingest always joined them."""
    return cap_content(content + "\n" + delta) if content else delta


def past_index(content: str | None) -> bool:
    """Whether appending to this text leaves what the full-text index reads as it is."""
    return content is not None and len(content) >= _MAX_INDEX_INPUT_CHARS


async def should_stage(db: AsyncSession, doc_id: uuid.UUID) -> bool:
    """Whether a delta to this conversation is staged, told without fetching its text: it is big, or
    deltas are already waiting. Smaller ones the caller fetches anyway, and checks with past_index."""
    size = await db.scalar(select(func.octet_length(Document.content)).where(Document.id == doc_id))
    if (size or 0) >= STAGE_MIN_BYTES:
        return True
    return await db.scalar(
        select(DocumentPendingDelta.id).where(DocumentPendingDelta.document_id == doc_id).limit(1)
    ) is not None


async def stage_delta(db: AsyncSession, doc_id: uuid.UUID, delta: str) -> None:
    # The row lock orders deltas: ids are taken and committed in lock order, and a merge holding
    # the lock sees every delta committed before it.
    await db.execute(select(Document.id).where(Document.id == doc_id).with_for_update())
    db.add(DocumentPendingDelta(document_id=doc_id, content=delta))
    await db.flush()


async def drop_pending(db: AsyncSession, doc_id: uuid.UUID) -> None:
    """A full upload replaces the content: deltas still waiting are part of it."""
    await db.execute(delete(DocumentPendingDelta).where(DocumentPendingDelta.document_id == doc_id))


async def pending_ids(db: AsyncSession, doc_ids) -> set:
    """Which of these documents have deltas waiting."""
    ids = list(doc_ids)
    if not ids:
        return set()
    return set((await db.execute(
        select(DocumentPendingDelta.document_id).where(DocumentPendingDelta.document_id.in_(ids)).distinct()
    )).scalars().all())


async def _pending_sizes(db: AsyncSession, doc_id: uuid.UUID) -> list[tuple[int, int]]:
    """A document's waiting deltas in order, (id, characters), without fetching them."""
    return [(i, n) for i, n in (await db.execute(
        select(DocumentPendingDelta.id, func.char_length(DocumentPendingDelta.content))
        .where(DocumentPendingDelta.document_id == doc_id)
        .order_by(DocumentPendingDelta.id)
    )).all()]


def _fetcher(db: AsyncSession) -> Callable[[list[int]], Awaitable[list[str]]]:
    async def fetch(ids: list[int]) -> list[str]:
        if not ids:
            return []
        rows = dict((await db.execute(
            select(DocumentPendingDelta.id, DocumentPendingDelta.content).where(DocumentPendingDelta.id.in_(ids))
        )).all())
        return [rows[i] for i in ids]
    return fetch


def _joined_size(length: int, deltas: list[tuple[int, int]]) -> int:
    """How long the content (`length` characters) is with the deltas appended, before capping."""
    return length + sum(n + 1 for _, n in deltas) - (0 if length else 1)


async def _joined(
    content: str | None, deltas: list[tuple[int, int]], fetch: Callable[[list[int]], Awaitable[list[str]]],
) -> str:
    """cap_content of the content with these deltas appended (as append() joins them), fetching only the
    deltas that end up in it: the head (when the content is shorter) and as many from the end as fill
    the rest."""
    content = content or ""
    # Each delta's share of the whole text: itself and the newline before it (none before the first
    # when there's no content)
    sizes = [n + 1 for _, n in deltas]
    if not content:
        sizes[0] -= 1

    def join(texts: list[str], first: int) -> str:
        joined = "".join("\n" + t for t in texts)
        return joined[1:] if first == 0 and not content else joined

    if len(content) + sum(sizes) <= MAX_CONTENT_CHARS:
        return content + join(await fetch([i for i, _ in deltas]), 0)

    head, k = content[:HEAD_CHARS], 0
    if len(head) < HEAD_CHARS:
        size = len(content)
        while k < len(deltas) and size < HEAD_CHARS:
            size += sizes[k]
            k += 1
        head = (content + join(await fetch([i for i, _ in deltas[:k]]), 0))[:HEAD_CHARS]
    head_end = head.rfind("\n", 0, HEAD_CHARS)
    if head_end <= 0:
        head_end = HEAD_CHARS

    # The tail cap_content keeps: its last `keep` characters, on from the next line start
    keep = MAX_CONTENT_CHARS - head_end - 1
    j, size = len(deltas), 0
    while j > 0 and size < keep:
        j -= 1
        size += sizes[j]
    tail = join(await fetch([i for i, _ in deltas[j:]]), j)
    if size < keep:
        tail = content[len(content) - (keep - size):] + tail
    tail = tail[len(tail) - keep:]
    nl = tail.find("\n")
    if nl != -1 and nl + 1 < len(tail):
        tail = tail[nl + 1:]
    return head[:head_end] + "\n" + tail


async def with_pending(db: AsyncSession, doc_id: uuid.UUID, content: str | None) -> str | None:
    """The content with the deltas waiting, for readers of the whole text."""
    deltas = await _pending_sizes(db, doc_id)
    if not deltas:
        return content
    return await _joined(content, deltas, _fetcher(db))


async def merge_pending(db: AsyncSession, doc_id: uuid.UUID) -> int:
    """Append a document's waiting deltas in one write. Returns how many; the caller commits."""
    locked = await db.scalar(
        select(Document.id).where(Document.id == doc_id).with_for_update(skip_locked=True)
    )
    if locked is None:
        return 0  # an ingest holds it: the next sweep merges
    deltas = await _pending_sizes(db, doc_id)
    if not deltas:
        return 0
    ids = [i for i, _ in deltas]
    length = await db.scalar(select(func.char_length(Document.content)).where(Document.id == doc_id)) or 0
    if length and _joined_size(length, deltas) <= MAX_CONTENT_CHARS:
        tail = "".join("\n" + t for t in await _fetcher(db)(ids))
        new_content = Document.content + tail  # appended by the database: the text never leaves it
    else:
        current = await db.scalar(select(Document.content).where(Document.id == doc_id)) if length else None
        new_content = await _joined(current, deltas, _fetcher(db))
    await db.execute(
        update(Document).where(Document.id == doc_id).values(content=new_content)
        .execution_options(synchronize_session=False)
    )
    await db.execute(delete(DocumentPendingDelta).where(DocumentPendingDelta.id.in_(ids)))
    return len(deltas)


def _due_query():
    quiet = func.max(DocumentPendingDelta.created_at) <= func.now() - timedelta(seconds=QUIET_SECONDS)
    waited = func.min(DocumentPendingDelta.created_at) <= func.now() - timedelta(seconds=MAX_WAIT_SECONDS)
    return (
        select(DocumentPendingDelta.document_id)
        .group_by(DocumentPendingDelta.document_id)
        .having(or_(quiet, waited))
    )


_MERGE_LOCK = 0x6D656D6D  # pg advisory lock key: one merge sweep at a time across workers


async def merge_due(session_factory, engine, budget_seconds: float = 50.0) -> dict:
    """Merge every conversation that went quiet or waited too long, until the budget runs out."""
    deadline = time.monotonic() + budget_seconds
    stats = {"documents": 0, "deltas": 0}
    async with engine.connect() as lock_conn:
        if not await lock_conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": _MERGE_LOCK}):
            return {**stats, "busy": True}
        try:
            async with session_factory() as db:
                due = (await db.execute(_due_query())).scalars().all()
                await db.rollback()
                for doc_id in due:
                    if time.monotonic() >= deadline:
                        break
                    try:
                        n = await merge_pending(db, doc_id)
                        await db.commit()
                    except Exception as e:
                        await db.rollback()
                        logger.warning("Merging pending deltas of %s failed: %s", doc_id, e)
                        continue
                    if n:
                        stats["documents"] += 1
                        stats["deltas"] += n
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _MERGE_LOCK})
    return stats
