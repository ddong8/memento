"""Conversations API — paginated message viewer with normalized parsing."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.conversation_parser import parse_conversation, count_conversation_messages
from ..services.user_filter import user_machine_ids

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("/{doc_id}")
async def get_conversation(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get conversation metadata and message count."""
    mids = await user_machine_ids(db, _user)

    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404)
    if mids is not None and doc.machine_id not in mids:
        raise HTTPException(status_code=404)

    # Count messages efficiently (no full parse)
    message_count = 0
    if doc.content:
        message_count = count_conversation_messages(doc.content, doc.tool_id)

    if message_count == 0:
        count_result = await db.execute(
            select(func.count()).where(ConversationMessage.document_id == doc_id)
        )
        message_count = count_result.scalar() or 0

    # Find related brain artifacts (same session_id)
    related_plans = []
    session_id = doc.metadata_.get("session_id") or doc.metadata_.get("cascade_id")
    if session_id and doc.tool_id == "antigravity":
        plans_q = (
            select(Document)
            .where(
                Document.tool_id == "antigravity",
                Document.category == "plan",
                Document.metadata_["session_id"].astext == session_id,
            )
            .order_by(Document.synced_at.desc())
        )
        # Scope related plans to same user — matching session_id alone could
        # surface another user's brain artifacts if they happened to share an ID.
        if mids is not None:
            plans_q = plans_q.where(Document.machine_id.in_(mids))
        plans_result = await db.execute(plans_q)
        for p in plans_result.scalars().all():
            # Skip resolved versions and metadata JSON
            if ".resolved" in p.relative_path or ".metadata.json" in p.relative_path:
                continue
            related_plans.append({
                "id": str(p.id),
                "title": p.title,
                "relative_path": p.relative_path,
                "category": p.category,
                "content_type": p.content_type,
                "content": p.content[:5000] if p.content else None,
                "file_size_bytes": p.file_size_bytes,
                "synced_at": p.synced_at.isoformat(),
            })

    return {
        "id": str(doc.id),
        "tool_id": doc.tool_id,
        "title": doc.title,
        "relative_path": doc.relative_path,
        "metadata": doc.metadata_,
        "message_count": message_count,
        "synced_at": doc.synced_at.isoformat(),
        "related_plans": related_plans,
    }


@router.get("/{doc_id}/messages")
async def get_conversation_messages(
    doc_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get paginated, human-readable conversation messages."""
    mids = await user_machine_ids(db, _user)

    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404)
    if mids is not None and doc.machine_id not in mids:
        raise HTTPException(status_code=404)

    # Parse from raw content with pagination (no full list in memory)
    if doc.content:
        total = count_conversation_messages(doc.content, doc.tool_id)
        page = parse_conversation(doc.content, doc.tool_id, offset=offset, limit=limit)
        return {
            "total": total,
            "offset": offset,
            "limit": limit,
            "messages": [
                {
                    "id": offset + i,
                    "line_number": offset + i + 1,
                    "role": m.role,
                    "content": m.content,
                    "thinking": m.thinking or None,
                    "tool_name": m.tool_name,
                    "tool_input": m.tool_input,
                    "timestamp": m.timestamp or None,
                    "raw_type": m.raw_type,
                }
                for i, m in enumerate(page)
            ],
        }

    # Fallback to DB-stored messages
    base_filter = [ConversationMessage.document_id == doc_id]
    count_result = await db.execute(
        select(func.count()).where(*base_filter)
    )
    total = count_result.scalar() or 0

    msgs_result = await db.execute(
        select(ConversationMessage)
        .where(*base_filter)
        .order_by(ConversationMessage.line_number)
        .offset(offset)
        .limit(limit)
    )
    messages = msgs_result.scalars().all()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "messages": [
            {
                "id": m.id,
                "line_number": m.line_number,
                "role": m.role or m.message_type,
                "content": m.content,
                "thinking": (m.metadata_ or {}).get("thinking") if m.metadata_ else None,
                "tool_name": "",
                "tool_input": "",
                "timestamp": m.timestamp.isoformat() if m.timestamp else None,
                "raw_type": m.message_type or "",
            }
            for m in messages
        ],
    }
