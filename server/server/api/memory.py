"""Memory API — knowledge graph visualization and embedding stats."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
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


@router.get("/stats")
async def get_memory_stats(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Overall memory statistics."""
    entities = (await db.execute(select(func.count()).select_from(KnowledgeEntity))).scalar() or 0
    relations = (await db.execute(select(func.count()).select_from(KnowledgeRelation))).scalar() or 0
    observations = (await db.execute(select(func.count()).select_from(KnowledgeObservation))).scalar() or 0
    embeddings = (await db.execute(select(func.count()).select_from(DocumentEmbedding))).scalar() or 0

    # Entity type breakdown
    type_result = await db.execute(
        select(KnowledgeEntity.entity_type, func.count())
        .group_by(KnowledgeEntity.entity_type)
    )
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
    # Nodes: entities
    entity_q = select(KnowledgeEntity).order_by(KnowledgeEntity.updated_at.desc()).limit(limit)
    if entity_type:
        entity_q = entity_q.where(KnowledgeEntity.entity_type == entity_type)
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
    pattern = f"%{q}%"

    # Search entities
    entity_result = await db.execute(
        select(KnowledgeEntity)
        .where(KnowledgeEntity.name.ilike(pattern) | KnowledgeEntity.summary.ilike(pattern))
        .limit(limit)
    )
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
        obs_result = await db.execute(
            select(KnowledgeObservation, KnowledgeEntity.name)
            .join(KnowledgeEntity, KnowledgeObservation.entity_id == KnowledgeEntity.id)
            .where(KnowledgeObservation.content.ilike(pattern))
            .limit(limit - len(results))
        )
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
    """Clear ALL knowledge graph data + embeddings. Memory will regenerate from next ingest."""
    from sqlalchemy import delete, text

    # Clear in dependency order
    obs = (await db.execute(delete(KnowledgeObservation))).rowcount
    rels = (await db.execute(delete(KnowledgeRelation))).rowcount
    ents = (await db.execute(delete(KnowledgeEntity))).rowcount
    embs = (await db.execute(delete(DocumentEmbedding))).rowcount

    # Clear _graph_hash from document metadata so knowledge re-extracts on next ingest
    await db.execute(text(
        "UPDATE documents SET metadata = metadata - '_graph_hash' WHERE metadata ? '_graph_hash'"
    ))

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
