"""Search API — hybrid (keyword + semantic) search across all synced content."""

from __future__ import annotations

import asyncio
from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select, func
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, DocumentEmbedding, Machine, User
from ..db.session import get_db, async_session_factory
from ..middleware.auth import get_current_user
from ..services.cache import cache_get, cache_set
from ..services.tokenize import tokenize_for_query
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
        from ..services.embedding_service import _call_embedding_server, widen_hnsw_scan

        # 30s matches /api/memory/semantic — see the note there: BGE-M3 is
        # CPU-only on Apple Silicon and a cold cache + Chinese tokenize can
        # take 5-12s. A shorter ceiling produces false "unavailable" and
        # silently drops users back to keyword-only on a healthy server.
        embeds = await _call_embedding_server([q], timeout=30.0)
        if not embeds or not embeds[0]:
            return [], {}

        dist_col = DocumentEmbedding.embedding.cosine_distance(embeds[0]).label("dist")
        has_doc_filter = bool(tool or category or days or mids is not None)
        stmt = select(
            DocumentEmbedding.document_id,
            DocumentEmbedding.chunk_text,
            dist_col,
        )
        if has_doc_filter:
            stmt = stmt.join(Document, DocumentEmbedding.document_id == Document.id)
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

        stmt = (
            stmt.order_by(dist_col.asc())
            # Overfetch: a document contributes many chunks, and we dedup down
            # to one row per document below.
            .limit(want * 4)
        )

        await widen_hnsw_scan(db, want * 4)

        order: list = []
        snippets: dict = {}
        similarities: dict = {}
        for doc_id, chunk, dist in (await db.execute(stmt)).all():
            if doc_id in snippets:
                continue  # keep only the best-scoring chunk per document
            snippets[doc_id] = (chunk or "")[:400]
            sim = max(0.0, 1.0 - float(dist)) if dist is not None else 0.5
            similarities[doc_id] = sim
            order.append(doc_id)
            if len(order) >= want:
                break
        return order, snippets, similarities
    except Exception:
        # Embedding server down, pgvector missing, timeout — all non-fatal.
        return [], {}, {}


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
    clean_q = q.strip()
    if hasattr(semantic, "default"):
        semantic = semantic.default
    semantic = bool(semantic)
    if hasattr(days, "default"):
        days = days.default
    if hasattr(offset, "default"):
        offset = offset.default
    offset = int(offset)
    if hasattr(limit, "default"):
        limit = limit.default
    limit = int(limit)
    cache_key = f"search:{_user.id}:{clean_q.lower()}:{tool or ''}:{category or ''}:{device_id or ''}:{days or ''}:{offset}:{limit}:{int(semantic)}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)
    search_term = f"%{clean_q}%"
    tsquery = tokenize_for_query(clean_q)

    conds = [
        Document.title.ilike(search_term),
        Document.relative_path.ilike(search_term),
    ]
    if tsquery:
        conds.append(Document.content_tsv.op("@@")(func.to_tsquery("simple", tsquery)))

    query = (
        select(Document)
        .options(
            defer(Document.content),
            defer(Document.content_tsv),
            defer(Document.metadata_),
            defer(Document.rendered_html),
        )
        .where(or_(*conds))
    )

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
    async def _fetch_paged():
        async with async_session_factory() as paged_db:
            res = (await paged_db.execute(paged)).all()
            return [r[0] for r in res], (res[0][-1] if res else 0)

    async def _fetch_sem():
        if semantic and offset == 0 and not device_id:
            from ..services.mind_resonance_service import expand_query_for_search
            expanded_q = expand_query_for_search(q)
            async with async_session_factory() as sem_db:
                return await _semantic_doc_ranks(
                    sem_db, expanded_q, mids, tool, category, days, want=limit
                )
        return [], {}, {}

    (docs, total), sem_res = await asyncio.gather(_fetch_paged(), _fetch_sem())
    if len(sem_res) == 3:
        sem_order, sem_snippets, sem_sims = sem_res
    else:
        sem_order, sem_snippets = sem_res
        sem_sims = {}

    if sem_order:
        kw_rank = {d.id: i for i, d in enumerate(docs)}
        sem_rank = {doc_id: i for i, doc_id in enumerate(sem_order)}

        # Semantic hits absent from the keyword page must be loaded before we
        # can render them.
        missing = [doc_id for doc_id in sem_order if doc_id not in kw_rank]
        if missing:
            extra_q = (
                select(Document)
                .options(
                    defer(Document.content),
                    defer(Document.content_tsv),
                    defer(Document.metadata_),
                    defer(Document.rendered_html),
                )
                .where(Document.id.in_(missing))
            )
            extra_q = apply_user_filter(extra_q, mids, Document.machine_id)
            extra = (await db.execute(extra_q)).scalars().all()
            docs = docs + list(extra)
            # These are genuinely new matches the keyword count never saw.
            total += len(extra)

        clean_q_lower = clean_q.lower().strip()

        def rrf(d) -> float:
            score = 0.0
            in_kw = d.id in kw_rank
            in_sem = d.id in sem_rank
            if in_kw:
                score += 1.0 / (RRF_K + kw_rank[d.id] + 1)
            if in_sem:
                score += 1.0 / (RRF_K + sem_rank[d.id] + 1)
            # Dual-hit synergy bonus: documents matching both keyword and semantic intent
            if in_kw and in_sem:
                score *= 1.25
            # Semantic similarity weighting
            sim = sem_sims.get(d.id, 0.0)
            if sim > 0:
                score += sim * 0.02
            # Title / relative path match bonus if query keyword directly appears
            title_lower = (d.title or "").lower()
            path_lower = (d.relative_path or "").lower()
            if clean_q_lower and (clean_q_lower in title_lower or clean_q_lower in path_lower):
                score *= 1.15
            return score

        docs.sort(key=rrf, reverse=True)
        docs = docs[:limit]

    # Batch fetch only the first 32KB of content for the final page candidates
    # instead of decompressing and transferring tens of megabytes of raw TOAST blocks.
    content_samples: dict = {}
    if docs:
        sample_stmt = select(Document.id, func.substr(Document.content, 1, 32768)).where(
            Document.id.in_([d.id for d in docs])
        )
        sample_res = await db.execute(sample_stmt)
        content_samples = {r[0]: (r[1] or "") for r in sample_res.all()}

    items = []
    lower_q = clean_q.lower()
    for d in docs:
        snippet = ""
        sample = content_samples.get(d.id, "")
        if sample:
            lower_sample = sample.lower()
            idx = lower_sample.find(lower_q)
            if idx >= 0:
                start = max(0, idx - 100)
                end = min(len(sample), idx + len(clean_q) + 100)
                snippet = sample[start:end]
                if start > 0:
                    snippet = "..." + snippet
                if end < (d.file_size_bytes or len(sample)):
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
            "synced_at": d.synced_at.isoformat() if d.synced_at else None,
            "matched_semantically": d.id in sem_snippets,
        })

    payload = {
        "query": q,
        "total": total,
        "offset": offset,
        "limit": limit,
        "semantic_used": bool(sem_order),
        "results": items,
    }
    await cache_set(cache_key, payload, ttl_seconds=300)
    return payload
