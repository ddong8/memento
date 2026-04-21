"""Search API — full-text search across all synced content."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("")
async def search(
    q: str = Query(..., min_length=1, max_length=500),
    tool: str | None = None,
    category: str | None = None,
    device_id: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Search documents by title and path (fast, trgm-indexed).

    Content search goes through embedding/semantic search (/api/memory/search).
    """
    mids = await user_machine_ids(db, _user)
    search_term = f"%{q}%"

    query = select(Document).where(
        or_(
            Document.title.ilike(search_term),
            Document.relative_path.ilike(search_term),
        )
    )

    if tool:
        query = query.where(Document.tool_id == tool)
    if category:
        query = query.where(Document.category == category)
    if device_id:
        query = query.where(Document.machine_id.in_(
            select(Machine.id).where(Machine.collector_token_hash == device_id)
        ))
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

    items = []
    for d in docs:
        # Extract a snippet around the match
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

        items.append({
            "id": str(d.id),
            "tool_id": d.tool_id,
            "relative_path": d.relative_path,
            "category": d.category,
            "title": d.title,
            "snippet": snippet,
            "file_size_bytes": d.file_size_bytes,
            "synced_at": d.synced_at.isoformat(),
        })

    return {
        "query": q,
        "total": total,
        "offset": offset,
        "limit": limit,
        "results": items,
    }
