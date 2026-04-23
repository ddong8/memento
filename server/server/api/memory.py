"""Memory API — knowledge graph visualization and embedding stats."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Document, DocumentEmbedding, KnowledgeEntity, KnowledgeObservation,
    KnowledgeRelation, Machine, User,
)
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids

router = APIRouter(prefix="/api/memory", tags=["memory"])


def _is_admin(user: User) -> bool:
    return user.role in ("admin", "owner")


def _user_entity_ids_subq(user: User):
    """Subquery: IDs of KnowledgeEntity rows owned by this user."""
    return select(KnowledgeEntity.id).where(KnowledgeEntity.user_id == user.id)


def _user_doc_ids_subq(user: User):
    """Subquery: IDs of Documents belonging to this user's machines."""
    return select(Document.id).where(
        Document.machine_id.in_(
            select(Machine.id).where(Machine.user_id == user.id)
        )
    )


@router.get("/stats")
async def get_memory_stats(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Overall memory statistics — scoped to current user unless admin/owner."""
    admin = _is_admin(_user)

    ent_q = select(func.count()).select_from(KnowledgeEntity)
    if not admin:
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    entities = (await db.execute(ent_q)).scalar() or 0

    rel_q = select(func.count()).select_from(KnowledgeRelation)
    if not admin:
        rel_q = rel_q.where(KnowledgeRelation.source_id.in_(_user_entity_ids_subq(_user)))
    relations = (await db.execute(rel_q)).scalar() or 0

    obs_q = select(func.count()).select_from(KnowledgeObservation)
    if not admin:
        obs_q = obs_q.where(KnowledgeObservation.entity_id.in_(_user_entity_ids_subq(_user)))
    observations = (await db.execute(obs_q)).scalar() or 0

    emb_q = select(func.count()).select_from(DocumentEmbedding)
    if not admin:
        emb_q = emb_q.where(DocumentEmbedding.document_id.in_(_user_doc_ids_subq(_user)))
    embeddings = (await db.execute(emb_q)).scalar() or 0

    # Entity type breakdown
    type_q = select(KnowledgeEntity.entity_type, func.count()).group_by(KnowledgeEntity.entity_type)
    if not admin:
        type_q = type_q.where(KnowledgeEntity.user_id == _user.id)
    type_result = await db.execute(type_q)
    entity_types = {r[0]: r[1] for r in type_result.all()}

    return {
        "entities": entities,
        "relations": relations,
        "observations": observations,
        "embeddings": embeddings,
        "entity_types": entity_types,
    }


@router.get("/graph")
async def get_knowledge_graph(
    limit: int = Query(100, ge=1, le=500),
    entity_type: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get knowledge graph data (nodes + edges) for visualization."""
    admin = _is_admin(_user)
    # Nodes: entities
    entity_q = select(KnowledgeEntity).order_by(KnowledgeEntity.updated_at.desc()).limit(limit)
    if entity_type:
        entity_q = entity_q.where(KnowledgeEntity.entity_type == entity_type)
    if not admin:
        entity_q = entity_q.where(KnowledgeEntity.user_id == _user.id)
    entities = (await db.execute(entity_q)).scalars().all()

    entity_ids = {e.id for e in entities}
    nodes = [
        {
            "id": str(e.id),
            "name": e.name,
            "type": e.entity_type,
            "summary": e.summary,
        }
        for e in entities
    ]

    # Edges: relations between visible entities
    if entity_ids:
        rel_result = await db.execute(
            select(KnowledgeRelation).where(
                KnowledgeRelation.source_id.in_(entity_ids),
                KnowledgeRelation.target_id.in_(entity_ids),
            )
        )
        edges = [
            {
                "source": str(r.source_id),
                "target": str(r.target_id),
                "type": r.relation_type,
                "strength": r.strength,
            }
            for r in rel_result.scalars().all()
        ]
    else:
        edges = []

    return {"nodes": nodes, "edges": edges}


@router.get("/entities/{entity_id}")
async def get_entity_detail(
    entity_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get entity detail with observations and relations."""
    entity = (await db.execute(
        select(KnowledgeEntity).where(KnowledgeEntity.id == entity_id)
    )).scalar_one_or_none()
    if not entity:
        return {"error": "not found"}
    # Isolation: non-admin can only view their own entities. Mask as "not found"
    # rather than 403 to avoid leaking the existence of other users' entities.
    if not _is_admin(_user) and entity.user_id != _user.id:
        return {"error": "not found"}

    # Observations
    obs_result = await db.execute(
        select(KnowledgeObservation)
        .where(KnowledgeObservation.entity_id == entity_id)
        .order_by(KnowledgeObservation.observed_at.desc())
        .limit(20)
    )
    observations = [
        {
            "content": o.content,
            "observed_at": o.observed_at.isoformat() if o.observed_at else None,
            "source_document_id": str(o.source_document_id) if o.source_document_id else None,
        }
        for o in obs_result.scalars().all()
    ]

    # Outgoing relations
    out_result = await db.execute(
        select(KnowledgeRelation, KnowledgeEntity)
        .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
        .where(KnowledgeRelation.source_id == entity_id)
    )
    outgoing = [
        {"target_name": target.name, "target_type": target.entity_type, "relation": rel.relation_type}
        for rel, target in out_result.all()
    ]

    # Incoming relations
    in_result = await db.execute(
        select(KnowledgeRelation, KnowledgeEntity)
        .join(KnowledgeEntity, KnowledgeRelation.source_id == KnowledgeEntity.id)
        .where(KnowledgeRelation.target_id == entity_id)
    )
    incoming = [
        {"source_name": source.name, "source_type": source.entity_type, "relation": rel.relation_type}
        for rel, source in in_result.all()
    ]

    return {
        "id": str(entity.id),
        "name": entity.name,
        "type": entity.entity_type,
        "summary": entity.summary,
        "observations": observations,
        "outgoing_relations": outgoing,
        "incoming_relations": incoming,
    }


@router.get("/search")
async def search_memory(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Search entities and observations."""
    admin = _is_admin(_user)
    pattern = f"%{q}%"

    # Search entities
    ent_search_q = (
        select(KnowledgeEntity)
        .where(KnowledgeEntity.name.ilike(pattern) | KnowledgeEntity.summary.ilike(pattern))
        .limit(limit)
    )
    if not admin:
        ent_search_q = ent_search_q.where(KnowledgeEntity.user_id == _user.id)
    entity_result = await db.execute(ent_search_q)
    results = [
        {
            "type": "entity",
            "id": str(e.id),
            "name": e.name,
            "entity_type": e.entity_type,
            "summary": e.summary,
        }
        for e in entity_result.scalars().all()
    ]

    # Search observations
    if len(results) < limit:
        obs_search_q = (
            select(KnowledgeObservation, KnowledgeEntity.name)
            .join(KnowledgeEntity, KnowledgeObservation.entity_id == KnowledgeEntity.id)
            .where(KnowledgeObservation.content.ilike(pattern))
            .limit(limit - len(results))
        )
        if not admin:
            obs_search_q = obs_search_q.where(KnowledgeEntity.user_id == _user.id)
        obs_result = await db.execute(obs_search_q)
        for o, entity_name in obs_result.all():
            results.append({
                "type": "observation",
                "id": str(o.id),
                "name": entity_name,
                "content": o.content,
                "observed_at": o.observed_at.isoformat() if o.observed_at else None,
            })

    return results


@router.post("/compact")
async def compact_memory(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Run memory compaction — merge old observations into summaries."""
    from ..services.memory_compaction import run_compaction
    return await run_compaction(db)


@router.post("/reset")
async def reset_memory(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Clear this user's knowledge graph + embeddings. Admin/owner clears everything.

    Memory will regenerate from next ingest. A non-admin calling this MUST NOT
    be able to wipe other users' data — without scoping this was a catastrophic
    multi-tenant bug (any logged-in user could nuke everyone's graph).
    """
    from sqlalchemy import delete, text

    admin = _is_admin(_user)

    if admin:
        obs = (await db.execute(delete(KnowledgeObservation))).rowcount
        rels = (await db.execute(delete(KnowledgeRelation))).rowcount
        ents = (await db.execute(delete(KnowledgeEntity))).rowcount
        embs = (await db.execute(delete(DocumentEmbedding))).rowcount
        await db.execute(text(
            "UPDATE documents SET metadata = metadata - '_graph_hash' "
            "WHERE metadata ? '_graph_hash'"
        ))
    else:
        obs = (await db.execute(
            delete(KnowledgeObservation).where(
                KnowledgeObservation.entity_id.in_(_user_entity_ids_subq(_user))
            )
        )).rowcount
        rels = (await db.execute(
            delete(KnowledgeRelation).where(
                KnowledgeRelation.source_id.in_(_user_entity_ids_subq(_user))
            )
        )).rowcount
        ents = (await db.execute(
            delete(KnowledgeEntity).where(KnowledgeEntity.user_id == _user.id)
        )).rowcount
        embs = (await db.execute(
            delete(DocumentEmbedding).where(
                DocumentEmbedding.document_id.in_(_user_doc_ids_subq(_user))
            )
        )).rowcount
        await db.execute(text(
            "UPDATE documents SET metadata = metadata - '_graph_hash' "
            "WHERE metadata ? '_graph_hash' "
            "AND machine_id IN (SELECT id FROM machines WHERE user_id = :uid)"
        ), {"uid": _user.id})

    await db.commit()
    return {
        "status": "reset",
        "deleted": {
            "entities": ents,
            "relations": rels,
            "observations": obs,
            "embeddings": embs,
        },
    }


# ---------------------------------------------------------------------------
# Direct memory writes — MCP memory_store tool calls this
# ---------------------------------------------------------------------------
class ObservationCreate(BaseModel):
    content: str
    entity_name: str | None = None
    entity_type: str = "concept"


@router.post("/observations")
async def create_observation(
    body: ObservationCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Store a free-form memory observation attached to a (possibly new) entity.

    Closes the previous remote-mode stub in mcp_server — memory_store now
    actually persists. Always scoped to the calling user via user_id; the
    unique constraint (user_id, name, entity_type) upserts entities across
    repeated stores with the same name.
    """
    name = (body.entity_name or "").strip() or "Note"
    etype = (body.entity_type or "concept").strip() or "concept"

    existing = (await db.execute(
        select(KnowledgeEntity).where(
            KnowledgeEntity.user_id == _user.id,
            KnowledgeEntity.name == name,
            KnowledgeEntity.entity_type == etype,
        ).limit(1)
    )).scalar_one_or_none()

    if existing is None:
        entity = KnowledgeEntity(user_id=_user.id, name=name, entity_type=etype)
        db.add(entity)
        await db.flush()
    else:
        entity = existing

    obs = KnowledgeObservation(entity_id=entity.id, content=body.content)
    db.add(obs)
    await db.commit()
    return {
        "status": "stored",
        "entity_id": str(entity.id),
        "entity_name": entity.name,
        "observation_id": str(obs.id),
    }


# ---------------------------------------------------------------------------
# Vector-backed semantic search over DocumentEmbedding
# ---------------------------------------------------------------------------
@router.get("/semantic")
async def semantic_search(
    q: str = Query(..., min_length=1, max_length=1000),
    limit: int = Query(5, ge=1, le=20),
    tool_filter: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Semantic search over document chunks via BGE-M3 embeddings.

    Embeds the query against the host-side embedding server, ranks
    DocumentEmbedding rows by pgvector cosine distance, deduplicates by
    document keeping the best-scoring chunk's text as snippet. Returns empty
    list if the embedding server is unavailable — caller should fall back to
    substring search.
    """
    from ..services.embedding_service import _call_embedding_server

    mids = await user_machine_ids(db, _user)

    # Short timeout so a stuck BGE-M3 server doesn't stall the MCP client past
    # its 30s limit (which would surface as "Search failed: " with no message).
    embeds = await _call_embedding_server([q], timeout=8.0)
    if not embeds or not embeds[0]:
        return {"results": [], "note": "embedding-server-unavailable"}

    qvec = embeds[0]
    dist_col = DocumentEmbedding.embedding.cosine_distance(qvec).label("dist")

    stmt = (
        select(
            DocumentEmbedding.chunk_text,
            Document.id, Document.tool_id, Document.title,
            Document.relative_path, Document.category, Document.synced_at,
            dist_col,
        )
        .join(Document, DocumentEmbedding.document_id == Document.id)
        .order_by(dist_col.asc())
        .limit(limit * 4)  # Overfetch: multiple chunks per doc; we'll dedup
    )
    if tool_filter:
        stmt = stmt.where(Document.tool_id == tool_filter)
    if mids is not None:
        stmt = stmt.where(Document.machine_id.in_(mids))

    rows = (await db.execute(stmt)).all()

    seen: dict = {}
    for chunk, did, tid, title, rpath, cat, synced, dist in rows:
        if did in seen:
            continue
        seen[did] = {
            "id": str(did),
            "tool_id": tid,
            "title": title or (rpath.split("/")[-1] if rpath else ""),
            "relative_path": rpath,
            "category": cat,
            "snippet": (chunk or "")[:400],
            "synced_at": synced.isoformat() if synced else None,
            "score": round(1.0 - float(dist), 4),
        }
        if len(seen) >= limit:
            break

    return {"results": list(seen.values())}


# ---------------------------------------------------------------------------
# Vacuum — drop entities that ended up with zero observations
# ---------------------------------------------------------------------------
@router.post("/vacuum")
async def vacuum_memory(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Remove 'zombie' knowledge entities that no longer have any observations.

    Why this exists: `_purge_device_data` already drops orphan entities inline
    when it deletes a device, but that cleanup was added after the product
    shipped — older installations still carry zero-observation entities from
    pre-cleanup device deletes. This endpoint is a one-shot/on-demand sweep
    so admin can nuke them without shelling into psql.

    Scope: non-admin hits only their own entities (user_id = _user.id).
    admin/owner cleans globally.
    """
    from sqlalchemy import delete

    admin = _is_admin(_user)

    orphan_q = select(KnowledgeEntity.id).where(
        ~KnowledgeEntity.id.in_(
            select(KnowledgeObservation.entity_id).where(
                KnowledgeObservation.entity_id.isnot(None)
            )
        )
    )
    if not admin:
        orphan_q = orphan_q.where(KnowledgeEntity.user_id == _user.id)

    orphan_ids = [r[0] for r in (await db.execute(orphan_q)).all()]
    rels_deleted = 0
    ents_deleted = 0
    if orphan_ids:
        r1 = await db.execute(
            delete(KnowledgeRelation).where(
                KnowledgeRelation.source_id.in_(orphan_ids)
                | KnowledgeRelation.target_id.in_(orphan_ids)
            )
        )
        rels_deleted = r1.rowcount or 0
        r2 = await db.execute(
            delete(KnowledgeEntity).where(KnowledgeEntity.id.in_(orphan_ids))
        )
        ents_deleted = r2.rowcount or 0

    await db.commit()
    return {
        "status": "vacuumed",
        "scope": "all" if admin else "self",
        "entities_deleted": ents_deleted,
        "relations_deleted": rels_deleted,
    }
