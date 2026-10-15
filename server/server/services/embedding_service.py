"""Embedding generation pipeline — calls external embedding HTTP server.

The embedding model (BGE-M3) runs on the host machine as a separate process,
not inside the Docker container. This avoids OOM issues.

Host server: python -m server.services.embedding_server --port 8002
API container calls: http://host.docker.internal:8002/embed
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, DocumentEmbedding

logger = logging.getLogger("embedding_service")

EMBEDDING_DIM = int(os.environ.get("MEMENTO_EMBEDDING_DIM", "1024"))
# URL of the embedding server (host machine)
EMBEDDING_SERVER_URL = os.environ.get(
    "MEMENTO_EMBEDDING_SERVER_URL",
    "http://host.docker.internal:8002",
)
CHUNK_SIZE = 2000  # chars per chunk
CHUNK_OVERLAP = 200

_server_available: bool | None = None  # None = not checked yet
_last_check_time: float = 0  # Retry every 60s after failure


def _chunk_text(text: str, chunk_chars: int = CHUNK_SIZE, overlap_chars: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks with smart boundary detection."""
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
        start = end - overlap_chars
    return [c for c in chunks if len(c) > 50]


_embedding_client: httpx.AsyncClient | None = None


def _get_embedding_client() -> httpx.AsyncClient:
    global _embedding_client
    import httpx
    if _embedding_client is None or _embedding_client.is_closed:
        _embedding_client = httpx.AsyncClient(
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=60.0),
        )
    return _embedding_client


async def _call_embedding_server(texts: list[str], timeout: float = 120.0) -> list[list[float]] | None:
    """Call the external embedding HTTP server.

    timeout: total request timeout per batch. Default 120s is for the
    ingest/retry path which tolerates long model loads; the interactive
    query path (``/api/memory/semantic``) should pass a small value (e.g.
    8s) so a stuck BGE-M3 server doesn't stall the MCP client past its
    own 30s ceiling, which surfaces as an empty-string ReadTimeout in
    the user's UI.
    """
    global _server_available, _last_check_time
    import time
    if _server_available is False and (time.time() - _last_check_time) < 60:
        return None

    try:
        all_embeddings: list[list[float]] = []
        batch_size = 10
        client = _get_embedding_client()
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            resp = await client.post(
                f"{EMBEDDING_SERVER_URL}/embed",
                json={"texts": batch},
                timeout=timeout,
            )
            if resp.status_code != 200:
                logger.warning("Embedding server returned %d", resp.status_code)
                return None
            data = resp.json()
            all_embeddings.extend(data.get("embeddings", []))
        _server_available = True
        return all_embeddings
    except Exception as e:
        global _embedding_client
        if _embedding_client and not _embedding_client.is_closed:
            try:
                await _embedding_client.aclose()
            except Exception:
                pass
        _embedding_client = None
        import time
        _last_check_time = time.time()
        if _server_available is not True:
            logger.info("Embedding server not available at %s: %s", EMBEDDING_SERVER_URL, e)
        else:
            logger.warning("Embedding call failed: %s", e)
        _server_available = False
        return None


async def generate_document_embeddings(db: AsyncSession, doc: Document) -> int:
    """Generate and store embeddings for a document. Returns count of chunks created.

    Writes ``doc.embedding_status`` via raw UPDATE statements (not ORM attribute
    assignment) so concurrent ingests of the same file don't trigger
    SQLAlchemy's stale-row detection — under load every collector resend used
    to roll back the whole transaction and lose the embeddings.
    """
    from sqlalchemy import update as _update

    async def _set_status(status: str, *, bump_attempts: bool = False) -> None:
        """Update embedding_status in its own short transaction.

        Critical: commits IMMEDIATELY so the documents-row write lock is
        released before any long-running await (BGE-M3 call can take 10+s).
        Without this, the doc row stays locked the whole time, heartbeat /
        ingest contention piles up and the connection pool dies.
        """
        values: dict = {"embedding_status": status}
        if bump_attempts:
            values["embedding_attempts"] = (doc.embedding_attempts or 0) + 1
        await db.execute(
            _update(Document).where(Document.id == doc.id).values(**values)
        )
        await db.commit()

    await _set_status(doc.embedding_status or "pending", bump_attempts=True)

    if not doc.content or len(doc.content) < 100:
        await _set_status("skipped")
        return 0

    if doc.content_type in ("sqlite", "sqlite_export", "binary"):
        await _set_status("skipped")
        return 0

    raw_text = doc.content
    if doc.category == "conversation":
        from ..db.models import ConversationMessage
        msgs = (await db.execute(
            select(ConversationMessage.role, ConversationMessage.content)
            .where(ConversationMessage.document_id == doc.id)
            .where(ConversationMessage.role.in_(("user", "assistant")))
            .order_by(ConversationMessage.line_number)
        )).all()
        if msgs:
            raw_text = "\n\n".join(
                f"{'用户' if r == 'user' else '助手'}: {c.strip()}"
                for r, c in msgs if c and c.strip()
            )

    chunks = _chunk_text(raw_text)
    if not chunks:
        await _set_status("skipped")
        return 0

    # Cap at 50 chunks per document (~100KB) to avoid overloading embedding server
    if len(chunks) > 50:
        chunks = chunks[:50]
    logger.info("Embedding %d chunks for %s", len(chunks), doc.relative_path)
    embeddings = await _call_embedding_server(chunks)
    if embeddings is None:
        await _set_status("failed")
        return 0

    if len(embeddings[0]) != EMBEDDING_DIM:
        logger.warning("Embedding dim mismatch: got %d, expected %d", len(embeddings[0]), EMBEDDING_DIM)
        await _set_status("failed")
        return 0

    # Upsert each chunk. Two concurrent post-ingest tasks on the same doc
    # used to race here: both ran DELETE(doc_embeddings WHERE doc_id=X)
    # → both saw empty → both INSERT → second one hit the
    # uq_doc_embedding_chunk unique violation and rolled back the whole
    # transaction. ON CONFLICT (document_id, chunk_index) DO UPDATE makes
    # each INSERT idempotent regardless of races, and naturally clobbers
    # stale chunks when content changes.
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    rows = [
        {
            "document_id": doc.id,
            "chunk_index": i,
            "chunk_text": chunk,
            "embedding": embedding,
        }
        for i, (chunk, embedding) in enumerate(zip(chunks, embeddings))
    ]
    stmt = pg_insert(DocumentEmbedding).values(rows)
    stmt = stmt.on_conflict_do_update(
        index_elements=["document_id", "chunk_index"],
        set_={
            "chunk_text": stmt.excluded.chunk_text,
            "embedding": stmt.excluded.embedding,
        },
    )
    await db.execute(stmt)

    # If we ended up with more chunks than this call produced (e.g. older
    # version of the same doc had more chunks), trim the tail. Same
    # transaction so concurrent readers never see a half-state.
    await db.execute(
        delete(DocumentEmbedding).where(
            DocumentEmbedding.document_id == doc.id,
            DocumentEmbedding.chunk_index >= len(chunks),
        )
    )

    await db.flush()
    await _set_status("ok")
    logger.info("Generated %d embeddings for %s/%s", len(chunks), doc.tool_id, doc.relative_path)
    return len(chunks)
