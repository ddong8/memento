"""Documents API — view individual documents and their history."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, DocumentVersion, User
from ..db.session import get_db
from ..middleware.access_log import log_access
from ..middleware.auth import get_current_user, get_optional_user
from ..services.permission_service import can_view_document
from ..services.user_filter import user_machine_ids

router = APIRouter(prefix="/api/documents", tags=["documents"])


async def _get_doc_with_permission(
    doc_id: uuid.UUID, db: AsyncSession, user: User | None,
    mids: list | None = None,
) -> Document:
    result = await db.execute(select(Document).where(Document.id == doc_id))
    doc = result.scalar_one_or_none()
    if not doc:
        raise HTTPException(status_code=404)
    if not await can_view_document(db, user, doc):
        raise HTTPException(status_code=404)  # 404 to hide existence
    if mids is not None and doc.machine_id not in mids:
        raise HTTPException(status_code=404)
    return doc


@router.get("/{doc_id}")
async def get_document(
    doc_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> dict:
    mids = await user_machine_ids(db, _user)
    doc = await _get_doc_with_permission(doc_id, db, user, mids)
    await log_access(db, request, "view_document", user.id if user else None, doc.id)

    return {
        "id": str(doc.id),
        "tool_id": doc.tool_id,
        "project_id": str(doc.project_id) if doc.project_id else None,
        "relative_path": doc.relative_path,
        "category": doc.category,
        "content_type": doc.content_type,
        "title": doc.title,
        "content": doc.content,
        "content_hash": doc.content_hash,
        "file_size_bytes": doc.file_size_bytes,
        "metadata": doc.metadata_,
        "ai_summary": doc.ai_summary,
        "synced_at": doc.synced_at.isoformat(),
        "created_at": doc.created_at.isoformat(),
        "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
    }


@router.get("/{doc_id}/raw")
async def get_document_raw(
    doc_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> dict:
    mids = await user_machine_ids(db, _user)
    doc = await _get_doc_with_permission(doc_id, db, user, mids)
    return {"content": doc.content, "content_type": doc.content_type}


@router.get("/{doc_id}/history")
async def get_document_history(
    doc_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    mids = await user_machine_ids(db, _user)
    await _get_doc_with_permission(doc_id, db, user, mids)

    result = await db.execute(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == doc_id)
        .order_by(DocumentVersion.synced_at.desc())
        .limit(limit)
    )
    versions = result.scalars().all()
    return [
        {
            "id": v.id,
            "content_hash": v.content_hash,
            "file_size_bytes": v.file_size_bytes,
            "content_delta": v.content_delta,
            "synced_at": v.synced_at.isoformat(),
        }
        for v in versions
    ]
