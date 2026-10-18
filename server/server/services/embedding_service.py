"""Embeddings for documents: chunk the text, embed only the chunks that changed.

Where the vectors come from (``MEMENTO_EMBEDDING_PROVIDER``):

* ``local``  — the BGE-M3 HTTP server: POST ``{MEMENTO_EMBEDDING_SERVER_URL}/embed``
  with ``{"texts": [...]}``.
* ``openai`` — an OpenAI-compatible ``/embeddings`` API, e.g. SiliconFlow's
  ``BAAI/bge-m3`` (``MEMENTO_EMBEDDING_API_URL``, ``MEMENTO_EMBEDDING_API_KEY``,
  ``MEMENTO_EMBEDDING_MODEL``).

Both serve BGE-M3 and vectors are L2-normalized here, so either kind sits in
the same table (SiliconFlow's and the local model's agree to cosine 0.9999).

Documents are not embedded while they sync. Ingest marks them ``pending`` and
the sweep (``embed_pending_documents``, Celery beat every minute) embeds the
ones that went quiet or waited too long, sending only chunks whose text
changed. A conversation grows at its end, so a sync costs a chunk or two;
re-sending whole conversations on every sync used to keep the CPU server
saturated, time requests out and mark documents failed for good.
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import delete, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import load_only

from ..db.models import ConversationMessage, Document, DocumentEmbedding

logger = logging.getLogger("embedding_service")

EMBEDDING_DIM = int(os.environ.get("MEMENTO_EMBEDDING_DIM", "1024"))
EMBEDDING_PROVIDER = os.environ.get("MEMENTO_EMBEDDING_PROVIDER", "local").strip().lower()
# local: the BGE-M3 HTTP server
EMBEDDING_SERVER_URL = os.environ.get(
    "MEMENTO_EMBEDDING_SERVER_URL",
    "http://host.docker.internal:8002",
)
# openai: an OpenAI-compatible embeddings API
EMBEDDING_API_URL = os.environ.get("MEMENTO_EMBEDDING_API_URL", "https://api.siliconflow.cn/v1").rstrip("/")
EMBEDDING_API_KEY = os.environ.get("MEMENTO_EMBEDDING_API_KEY", "")
EMBEDDING_MODEL = os.environ.get("MEMENTO_EMBEDDING_MODEL", "BAAI/bge-m3")

CHUNK_SIZE = 2000  # chars per chunk
CHUNK_OVERLAP = 200
# A guard against runaway documents (~40M chars), not a budget: with only
# changed chunks embedded, a long conversation costs its length once.
MAX_CHUNKS = 20_000
# Only these get vectors (other categories are config, extensions, …)
EMBED_CATEGORIES = ("conversation", "memory", "learning", "plan", "identity")
QUIET_SECONDS = 120  # a document still being written waits until it goes quiet...
MAX_WAIT_SECONDS = 1800  # ...or until its last embedding is this old
SLICE = 128  # chunks embedded and committed together
MAX_BACKOFF_MINUTES = 360

_server_available: bool | None = None  # None = not checked yet
_last_check_time: float = 0  # Retry every 60s after failure


class EmbeddingRateLimited(Exception):
    """The provider asked us to slow down: not the document's fault."""


def _chunk_text(text: str, chunk_chars: int = CHUNK_SIZE, overlap_chars: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks with smart boundary detection.

    Chunks are cut from the start, so appending text only changes the last
    chunk or two: everything before stays byte-identical and is not re-embedded.
    """
    if len(text) <= chunk_chars:
        return [text]

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_chars
        if end < len(text):
            for sep in ("\n\n", "\n", ". ", "。", "；"):
                break_pos = text.rfind(sep, start + chunk_chars // 2, end)
                if break_pos != -1:
                    end = break_pos + len(sep)
                    break
        chunks.append(text[start:end].strip())
        if end >= len(text):
            break
        start = end - overlap_chars
    return [c for c in chunks if len(c) > 50]


def changed_chunks(chunks: list[str], stored: dict[int, str]) -> list[int]:
    """Indexes of chunks whose text isn't stored yet."""
    return [i for i, c in enumerate(chunks) if stored.get(i) != c]


def retry_delay(attempts: int) -> timedelta:
    """Wait after the n-th failure in a row: 2, 4, 8 … minutes, at most 6 hours."""
    return timedelta(minutes=min(2 ** min(max(attempts, 1), 12), MAX_BACKOFF_MINUTES))


def _normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / norm for x in vec]


_embedding_client: httpx.AsyncClient | None = None


def _get_embedding_client() -> httpx.AsyncClient:
    global _embedding_client
    if _embedding_client is None or _embedding_client.is_closed:
        _embedding_client = httpx.AsyncClient(
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=60.0),
        )
    return _embedding_client


async def _embed_batch(client: httpx.AsyncClient, batch: list[str], timeout: float) -> list[list[float]]:
    if EMBEDDING_PROVIDER == "openai":
        resp = await client.post(
            f"{EMBEDDING_API_URL}/embeddings",
            json={"model": EMBEDDING_MODEL, "input": batch, "encoding_format": "float"},
            headers={"Authorization": f"Bearer {EMBEDDING_API_KEY}"},
            timeout=timeout,
        )
        if resp.status_code == 429:
            raise EmbeddingRateLimited(resp.headers.get("retry-after") or "")
        resp.raise_for_status()
        data = sorted(resp.json().get("data", []), key=lambda d: d.get("index", 0))
        return [d["embedding"] for d in data]
    resp = await client.post(f"{EMBEDDING_SERVER_URL}/embed", json={"texts": batch}, timeout=timeout)
    resp.raise_for_status()
    return resp.json().get("embeddings", [])


_QUERY_EMBED_CACHE: dict[str, list[float]] = {}
_QUERY_CACHE_MAX_SIZE = 512


async def embed_texts(texts: list[str], timeout: float = 120.0, client: httpx.AsyncClient | None = None) -> list[list[float]]:
    """Normalized vectors for ``texts``; raises when the provider fails."""
    if not texts:
        return []
    batch_size = 16 if EMBEDDING_PROVIDER == "openai" else 10
    client = client or _get_embedding_client()
    batches = [texts[i:i + batch_size] for i in range(0, len(texts), batch_size)]
    if len(batches) == 1:
        vectors = await _embed_batch(client, batches[0], timeout)
        if len(vectors) != len(batches[0]):
            raise ValueError(f"got {len(vectors)} vectors for {len(batches[0])} texts")
        return [_normalize(v) for v in vectors]

    sem = asyncio.Semaphore(4)

    async def _fetch(b: list[str]) -> list[list[float]]:
        async with sem:
            vecs = await _embed_batch(client, b, timeout)
            if len(vecs) != len(b):
                raise ValueError(f"got {len(vecs)} vectors for {len(b)} texts")
            return vecs

    results = await asyncio.gather(*[_fetch(b) for b in batches])
    out: list[list[float]] = []
    for vecs in results:
        out.extend(_normalize(v) for v in vecs)
    return out


async def _call_embedding_server(texts: list[str], timeout: float = 120.0) -> list[list[float]] | None:
    """Vectors for ``texts``, or None while the provider is down.

    For queries (search, ``/api/memory/semantic``): pass a small timeout so a
    stuck provider doesn't stall the caller. After a failure, calls return
    None for 60s instead of piling onto a provider that is down.
    """
    global _server_available, _last_check_time, _embedding_client
    if _server_available is False and (time.time() - _last_check_time) < 60:
        return None

    is_single_query = len(texts) == 1 and len(texts[0]) <= 500
    if is_single_query:
        q_text = texts[0]
        cached_vec = _QUERY_EMBED_CACHE.get(q_text)
        if cached_vec is not None:
            return [[x for x in cached_vec]]

    try:
        vectors = await embed_texts(texts, timeout=timeout)
        _server_available = True
        if is_single_query and vectors and len(vectors) == 1:
            if len(_QUERY_EMBED_CACHE) >= _QUERY_CACHE_MAX_SIZE:
                first_k = next(iter(_QUERY_EMBED_CACHE))
                _QUERY_EMBED_CACHE.pop(first_k, None)
            _QUERY_EMBED_CACHE[texts[0]] = vectors[0]
        return vectors
    except Exception as e:
        if _embedding_client and not _embedding_client.is_closed:
            try:
                await _embedding_client.aclose()
            except Exception:
                pass
        _embedding_client = None
        _last_check_time = time.time()
        if _server_available is not True:
            logger.info("Embedding provider (%s) not available: %s", EMBEDDING_PROVIDER, e)
        else:
            logger.warning("Embedding call failed (%s): %s", EMBEDDING_PROVIDER, e)
        _server_available = False
        return None


async def _document_text(db: AsyncSession, doc: Document) -> str:
    """What gets embedded: a conversation's user and assistant turns, else the content."""
    if doc.category == "conversation":
        msgs = (await db.execute(
            select(ConversationMessage.role, ConversationMessage.content)
            .where(ConversationMessage.document_id == doc.id)
            .where(ConversationMessage.role.in_(("user", "assistant")))
            .order_by(ConversationMessage.line_number)
        )).all()
        if msgs:
            return "\n\n".join(
                f"{'用户' if r == 'user' else '助手'}: {c.strip()}"
                for r, c in msgs if c and c.strip()
            )
    return (await db.scalar(select(Document.content).where(Document.id == doc.id))) or ""


async def _finish(db: AsyncSession, doc: Document, status: str, seen_synced_at) -> None:
    """Record a finished embedding. A sync that landed meanwhile keeps the
    document pending, so its new text is embedded on a later sweep."""
    now = datetime.now(timezone.utc)
    await db.execute(
        update(Document).where(Document.id == doc.id)
        .values(embedded_at=now, embedding_attempts=0, embedding_next_at=None)
    )
    await db.execute(
        update(Document).where(Document.id == doc.id, Document.synced_at == seen_synced_at)
        .values(embedding_status=status)
    )
    await db.commit()


async def embed_document(
    db: AsyncSession, doc: Document, *, deadline: float | None = None, client: httpx.AsyncClient | None = None,
) -> tuple[str, int]:
    """Embed what changed in one document: ('ok' | 'skipped' | 'partial', chunks sent).

    'partial' means the deadline came first; the document stays pending and
    the next sweep picks up from there (sent chunks are already stored).
    Raises when the provider fails.
    """
    seen_synced_at = doc.synced_at
    if doc.content_type in ("sqlite", "sqlite_export", "binary"):
        await _finish(db, doc, "skipped", seen_synced_at)
        return "skipped", 0
    body = await _document_text(db, doc)
    chunks = _chunk_text(body)[:MAX_CHUNKS] if len(body) >= 100 else []
    if not chunks:
        await _finish(db, doc, "skipped", seen_synced_at)
        return "skipped", 0

    stored = dict((await db.execute(
        select(DocumentEmbedding.chunk_index, DocumentEmbedding.chunk_text)
        .where(DocumentEmbedding.document_id == doc.id)
    )).all())
    todo = changed_chunks(chunks, stored)

    from sqlalchemy.dialects.postgresql import insert as pg_insert
    sent = 0
    for start in range(0, len(todo), SLICE):
        if deadline is not None and time.monotonic() >= deadline:
            return "partial", sent
        idx = todo[start:start + SLICE]
        vectors = await embed_texts([chunks[i] for i in idx], client=client)
        if vectors and len(vectors[0]) != EMBEDDING_DIM:
            raise ValueError(f"embedding dim {len(vectors[0])}, expected {EMBEDDING_DIM}")
        # ON CONFLICT keeps concurrent writers of the same chunk from failing each other.
        stmt = pg_insert(DocumentEmbedding).values([
            {"document_id": doc.id, "chunk_index": i, "chunk_text": chunks[i], "embedding": v}
            for i, v in zip(idx, vectors)
        ])
        stmt = stmt.on_conflict_do_update(
            index_elements=["document_id", "chunk_index"],
            set_={"chunk_text": stmt.excluded.chunk_text, "embedding": stmt.excluded.embedding},
        )
        await db.execute(stmt)
        await db.commit()
        sent += len(idx)

    # Fewer chunks than before (a rewritten file): drop the tail
    if any(i >= len(chunks) for i in stored):
        await db.execute(delete(DocumentEmbedding).where(
            DocumentEmbedding.document_id == doc.id,
            DocumentEmbedding.chunk_index >= len(chunks),
        ))
        await db.commit()
    await _finish(db, doc, "ok", seen_synced_at)
    if sent:
        logger.info("Embedded %d of %d chunks for %s/%s", sent, len(chunks), doc.tool_id, doc.relative_path)
    return "ok", sent


def _due_query(now: datetime, limit: int):
    """Documents waiting for vectors: quiet for a while (or waiting too long), not backing off."""
    return (
        select(Document)
        .options(load_only(
            Document.id, Document.tool_id, Document.category, Document.content_type, Document.relative_path,
            Document.synced_at, Document.embedding_status, Document.embedding_attempts, Document.embedded_at,
        ))
        .where(
            Document.embedding_status.in_(("pending", "failed")),
            Document.category.in_(EMBED_CATEGORIES),
            or_(Document.embedding_next_at.is_(None), Document.embedding_next_at <= now),
            or_(
                Document.synced_at <= now - timedelta(seconds=QUIET_SECONDS),
                Document.embedded_at.is_(None),
                Document.embedded_at <= now - timedelta(seconds=MAX_WAIT_SECONDS),
            ),
        )
        # Fresh documents first, then the backlog of failures
        .order_by(Document.embedding_status.desc(), Document.synced_at.desc())
        .limit(limit)
    )


_SWEEP_LOCK = 0x6D656D62  # pg advisory lock key: one sweep at a time across workers


async def embed_pending_documents(session_factory, engine, budget_seconds: float = 50.0) -> dict:
    """Embed due documents until the time budget runs out."""
    deadline = time.monotonic() + budget_seconds
    stats = {"embedded": 0, "skipped": 0, "partial": 0, "failed": 0, "chunks": 0}
    async with engine.connect() as lock_conn:
        if not await lock_conn.scalar(text("SELECT pg_try_advisory_lock(:k)"), {"k": _SWEEP_LOCK}):
            return {**stats, "busy": True}
        try:
            async with httpx.AsyncClient(timeout=120.0) as client, session_factory() as db:
                tried: set = set()
                while time.monotonic() < deadline:
                    docs = [d for d in (await db.execute(_due_query(datetime.now(timezone.utc), 20))).scalars().all()
                            if d.id not in tried]
                    if not docs:
                        break
                    for doc in docs:
                        if time.monotonic() >= deadline:
                            break
                        # Read before trying: a rollback expires the instance
                        doc_id, attempts, path = doc.id, doc.embedding_attempts or 0, doc.relative_path
                        tried.add(doc_id)
                        try:
                            outcome, sent = await embed_document(db, doc, deadline=deadline, client=client)
                            stats["chunks"] += sent
                            stats["embedded" if outcome == "ok" else outcome] += 1
                        except EmbeddingRateLimited:
                            await db.rollback()
                            await _defer(db, doc_id, timedelta(minutes=1))
                            return {**stats, "rate_limited": True}
                        except Exception as e:
                            await db.rollback()
                            await _record_failure(db, doc_id, attempts)
                            stats["failed"] += 1
                            logger.warning("Embedding failed for %s: %s", path, e)
                            # A document the provider rejects (4xx) is that document's problem;
                            # anything else means the provider is down: stop for this round.
                            status = getattr(getattr(e, "response", None), "status_code", 0)
                            if not 400 <= status < 500:
                                return {**stats, "provider_error": str(e)[:200]}
        finally:
            await lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _SWEEP_LOCK})
    return stats


async def _defer(db: AsyncSession, doc_id, delay: timedelta) -> None:
    await db.execute(
        update(Document).where(Document.id == doc_id)
        .values(embedding_next_at=datetime.now(timezone.utc) + delay)
    )
    await db.commit()


async def _record_failure(db: AsyncSession, doc_id, previous_attempts: int) -> None:
    attempts = previous_attempts + 1
    await db.execute(
        update(Document).where(Document.id == doc_id).values(
            embedding_status="failed",
            embedding_attempts=attempts,
            embedding_next_at=datetime.now(timezone.utc) + retry_delay(attempts),
        )
    )
    await db.commit()
