"""Search API — hybrid (keyword + semantic) search across all synced content."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, DocumentEmbedding, Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter

router = APIRouter(prefix="/api/search", tags=["search"])

# Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper
# (Cormack et al. 2009) and the de-facto default in Elasticsearch/Vespa: large
# enough that the top few ranks don't dominate outright, small enough that
# rank-1 still clearly outranks rank-10.
RRF_K = 60


async def _semantic_doc_ranks(
    db: AsyncSession,
    q: str,
    mids,
    tool: str | None,
    category: str | None,
    days: int | None,
    want: int,
) -> tuple[list, dict]:
    """Rank document ids by BGE-M3 cosine similarity. Returns ([doc_id...], {doc_id: snippet}).

    Returns ([], {}) on ANY failure — a missing/slow embedding server must
    degrade this endpoint to pure keyword search, never 500 it. The keyword
    branch is the floor; semantic is strictly additive.
    """
    try:
        from ..services.embedding_service import _call_embedding_server

        # 30s matches /api/memory/semantic — see the note there: BGE-M3 is
        # CPU-only on Apple Silicon and a cold cache + Chinese tokenize can
        # take 5-12s. A shorter ceiling produces false "unavailable" and
        # silently drops users back to keyword-only on a healthy server.
        embeds = await _call_embedding_server([q], timeout=30.0)
        if not embeds or not embeds[0]:
            return [], {}

        dist_col = DocumentEmbedding.embedding.cosine_distance(embeds[0]).label("dist")
        stmt = (
            select(
                DocumentEmbedding.document_id,
                DocumentEmbedding.chunk_text,
                dist_col,
            )
            .join(Document, DocumentEmbedding.document_id == Document.id)
            .order_by(dist_col.asc())
            # Overfetch: a document contributes many chunks, and we dedup down
            # to one row per document below.
            .limit(want * 4)
        )
        if tool:
            stmt = stmt.where(Document.tool_id == tool)
        if category:
            stmt = stmt.where(Document.category == category)
        if days:
            from datetime import datetime, timedelta, timezone

            stmt = stmt.where(
                Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days)
            )
        if mids is not None:
            stmt = stmt.where(Document.machine_id.in_(mids))

        order: list = []
        snippets: dict = {}
        for doc_id, chunk, _dist in (await db.execute(stmt)).all():
            if doc_id in snippets:
                continue  # keep only the best-scoring chunk per document
            snippets[doc_id] = (chunk or "")[:400]
            order.append(doc_id)
            if len(order) >= want:
                break
        return order, snippets
    except Exception:
        # Embedding server down, pgvector missing, timeout — all non-fatal.
        return [], {}


@router.get("")
async def search(
    q: str = Query(..., min_length=1, max_length=500),
    tool: str | None = None,
    category: str | None = None,
    device_id: str | None = None,
    days: int | None = Query(None, ge=1, le=3650),
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    semantic: bool = Query(True),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Hybrid search: keyword (trigram + jieba FTS) fused with BGE-M3 vectors.

    Keyword branch — three index-backed conditions in one OR:
    1. ``title.ilike`` + ``relative_path.ilike`` — trigram GIN, fast for
       path / filename lookups.
    2. ``content_tsv @@ to_tsquery('simple', ...)`` — jieba-tokenized
       full-text, fast for keyword-in-body matches (even Chinese) and
       avoids the TOAST-heap scan that raw ``content.ilike`` triggers.

    Semantic branch — pgvector cosine over ``document_embeddings``, so
    "那次部署卡住怎么解决的" finds the right conversation even when none of
    those characters appear in it.

    The two are fused with Reciprocal Rank Fusion (see ``RRF_K``), which
    needs only rank order and so avoids comparing a tsquery score against a
    cosine distance — two scales with no meaningful common unit.

    Fusion applies to the FIRST page only (``offset == 0``). Deeper pages are
    pure keyword: ``total`` and the offset window come from the keyword query,
    and mixing a fixed-size semantic set into arbitrary offsets would either
    duplicate or drop rows across page boundaries. ``semantic_used`` in the
    response says which mode actually ran.
    """
    from ..services.tokenize import tokenize_for_query

    mids = await user_machine_ids(db, _user)
    search_term = f"%{q}%"
    tsquery = tokenize_for_query(q)

    conds = [
        Document.title.ilike(search_term),
        Document.relative_path.ilike(search_term),
    ]
    if tsquery:
        conds.append(Document.content_tsv.op("@@")(func.to_tsquery("simple", tsquery)))

    query = select(Document).where(or_(*conds))

    if tool:
        query = query.where(Document.tool_id == tool)
    if category:
        query = query.where(Document.category == category)
    if device_id:
        query = query.where(Document.machine_id.in_(
            select(Machine.id).where(Machine.collector_token_hash == device_id)
        ))
    if days:
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        query = query.where(Document.synced_at >= cutoff)
    query = apply_user_filter(query, mids, Document.machine_id)

    # Fetch page + total in one query. COUNT(*) OVER () reuses the same bitmap
    # index plan as the page query, avoiding a separate seq-scan-based count.
    total_col = func.count().over().label("_total")
    paged = (
        query.add_columns(total_col)
        .order_by(Document.synced_at.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = (await db.execute(paged)).all()
    docs = [r[0] for r in rows]
    total = rows[0][-1] if rows else 0

    # ---- Semantic fusion (first page only) --------------------------------
    # device_id has no semantic equivalent: it filters by collector token hash
    # via a Machine subquery, and the vector branch resolves machines through
    # `mids` instead. Rather than return semantically-similar docs from the
    # wrong device, skip fusion whenever a device filter is active.
    sem_order: list = []
    sem_snippets: dict = {}
    if semantic and offset == 0 and not device_id:
        sem_order, sem_snippets = await _semantic_doc_ranks(
            db, q, mids, tool, category, days, want=limit
        )

    if sem_order:
        kw_rank = {d.id: i for i, d in enumerate(docs)}
        sem_rank = {doc_id: i for i, doc_id in enumerate(sem_order)}

        # Semantic hits absent from the keyword page must be loaded before we
        # can render them.
        missing = [doc_id for doc_id in sem_order if doc_id not in kw_rank]
        if missing:
            extra_q = select(Document).where(Document.id.in_(missing))
            extra_q = apply_user_filter(extra_q, mids, Document.machine_id)
            extra = (await db.execute(extra_q)).scalars().all()
            docs = docs + list(extra)
            # These are genuinely new matches the keyword count never saw.
            total += len(extra)

        def rrf(d) -> float:
            score = 0.0
            if d.id in kw_rank:
                score += 1.0 / (RRF_K + kw_rank[d.id] + 1)
            if d.id in sem_rank:
                score += 1.0 / (RRF_K + sem_rank[d.id] + 1)
            return score

        docs.sort(key=rrf, reverse=True)
        docs = docs[:limit]

    items = []
    for d in docs:
        # Prefer the keyword-match snippet (it shows the literal hit, which the
        # UI highlights); fall back to the best semantic chunk for docs that
        # matched only by meaning and contain no literal occurrence.
        snippet = ""
        if d.content:
            lower_content = d.content.lower()
            lower_q = q.lower()
            idx = lower_content.find(lower_q)
            if idx >= 0:
                start = max(0, idx - 100)
                end = min(len(d.content), idx + len(q) + 100)
                snippet = d.content[start:end]
                if start > 0:
                    snippet = "..." + snippet
                if end < len(d.content):
                    snippet = snippet + "..."
        if not snippet:
            snippet = sem_snippets.get(d.id, "")

        items.append({
            "id": str(d.id),
            "tool_id": d.tool_id,
            "relative_path": d.relative_path,
            "category": d.category,
            "title": d.title,
            "snippet": snippet,
            "file_size_bytes": d.file_size_bytes,
            "synced_at": d.synced_at.isoformat(),
            "matched_semantically": d.id in sem_snippets,
        })

    return {
        "query": q,
        "total": total,
        "offset": offset,
        "limit": limit,
        "semantic_used": bool(sem_order),
        "results": items,
    }
