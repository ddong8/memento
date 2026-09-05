"""Documents API — view individual documents and their history."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Document, DocumentVersion, KnowledgeEntity, KnowledgeObservation, User,
)
from ..db.session import get_db
from ..middleware.access_log import log_access
from ..middleware.auth import get_current_user, get_optional_user
from ..services.permission_service import can_view_document
from ..services.user_filter import apply_user_filter, user_machine_ids

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


@router.get("/{doc_id}/backlinks")
async def get_document_backlinks(
    doc_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_optional_user),
    _user: User = Depends(get_current_user),
) -> dict:
    """Knowledge-graph entities this document contributed observations to,
    plus the sibling documents those same entities were observed in.

    This is the Obsidian-style backlink panel, derived rather than hand-authored:
    the LLM extraction pass already records which entity each observation came
    from (``KnowledgeObservation.source_document_id``), so "what else discussed
    this?" is a two-hop walk — document → entities → other source documents —
    with no new schema and no manually written links.
    """
    mids = await user_machine_ids(db, _user)
    await _get_doc_with_permission(doc_id, db, user, mids)

    # Hop 1: entities this document was observed in.
    #
    # Scoped to the caller's own entities for non-admins, matching every other
    # KnowledgeEntity query in the codebase (see api/memory.py). A document can
    # be visible to this user while another tenant's extraction pass also
    # observed it; without this guard their entity names would leak here.
    ent_q = (
        select(KnowledgeEntity.id, KnowledgeEntity.name, KnowledgeEntity.entity_type)
        .join(KnowledgeObservation, KnowledgeObservation.entity_id == KnowledgeEntity.id)
        .where(KnowledgeObservation.source_document_id == doc_id)
        .distinct()
        .limit(limit)
    )
    if _user.role not in ("admin", "owner"):
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    ent_rows = (await db.execute(ent_q)).all()
    if not ent_rows:
        return {"entities": [], "related_documents": []}

    ent_ids = [e[0] for e in ent_rows]

    # Hop 2: other documents observed in those same entities. Excluding the
    # current doc; ordering by shared-entity count so the most strongly
    # related document surfaces first.
    shared = func.count(func.distinct(KnowledgeObservation.entity_id)).label("shared")
    rel_q = (
        select(
            Document.id, Document.title, Document.relative_path,
            Document.tool_id, Document.category, Document.synced_at, shared,
        )
        .join(KnowledgeObservation, KnowledgeObservation.source_document_id == Document.id)
        .where(
            KnowledgeObservation.entity_id.in_(ent_ids),
            Document.id != doc_id,
        )
        .group_by(
            Document.id, Document.title, Document.relative_path,
            Document.tool_id, Document.category, Document.synced_at,
        )
        .order_by(shared.desc(), Document.synced_at.desc())
        .limit(limit)
    )
    rel_q = apply_user_filter(rel_q, mids, Document.machine_id)
    rel_rows = (await db.execute(rel_q)).all()

    return {
        "entities": [
            {"id": str(eid), "name": name, "type": etype}
            for eid, name, etype in ent_rows
        ],
        "related_documents": [
            {
                "id": str(rid),
                "title": title or (rpath.split("/")[-1] if rpath else ""),
                "relative_path": rpath,
                "tool_id": tid,
                "category": cat,
                "synced_at": synced.isoformat() if synced else None,
                "shared_entities": int(sh),
            }
            for rid, title, rpath, tid, cat, synced, sh in rel_rows
        ],
    }
