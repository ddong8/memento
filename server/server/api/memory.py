"""Memory API — knowledge graph visualization and embedding stats."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AskConversation, ConversationMessage, DailySummary, Document,
    DocumentEmbedding, DreamJournal, KnowledgeEntity, KnowledgeObservation,
    KnowledgeRelation, Machine, User, UserMemory,
)
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import cache
from ..services.cache import cache_get, cache_set
from ..services.memory_lifecycle import touch_recalled
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
    cache_key = f"memory:stats:{_user.id}:{admin}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    # Entity type breakdown & total entity count (single query covers both)
    type_q = select(KnowledgeEntity.entity_type, func.count()).group_by(KnowledgeEntity.entity_type)
    if not admin:
        type_q = type_q.where(KnowledgeEntity.user_id == _user.id)
    type_result = await db.execute(type_q)
    entity_types = {r[0]: r[1] for r in type_result.all()}
    entities = sum(entity_types.values())

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

    payload = {
        "entities": entities,
        "relations": relations,
        "observations": observations,
        "embeddings": embeddings,
        "entity_types": entity_types,
    }
    # Explicitly invalidated on ingestion and memory modifications; 5m TTL eliminates redundant scans
    await cache_set(cache_key, payload, ttl_seconds=300)
    return payload


@router.get("/resonance")
async def get_resonance(
    query: str | None = None,
    project: str | None = None,
    action: str | None = None,
    format: str = "json",
    limit_entities: int = Query(4, ge=1, le=20),
    limit_pitfalls: int = Query(4, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """心领神会·默契前置激活层 (Mind Resonance).
    主动与用户完成心智同频：推断领域场景、激活图谱实体、召回防御性避坑预警与专属铁律。
    """
    from ..services.mind_resonance_service import render_mind_resonance_markdown, sense_resonance

    cache_key = f"memory:resonance:{_user.id}:{query or ''}:{project or ''}:{action or ''}:{format}:{limit_entities}:{limit_pitfalls}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    res = await sense_resonance(
        db,
        _user,
        query=query,
        project=project,
        action=action,
        limit_entities=limit_entities,
        limit_pitfalls=limit_pitfalls,
    )
    result = {"markdown": render_mind_resonance_markdown(res)} if format == "markdown" else res
    await cache_set(cache_key, result, ttl_seconds=30)
    return result


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
    """Search entities and observations: entities named q first, then names starting with or containing
    it, then those that only mention it in their summary."""
    admin = _is_admin(_user)
    pattern = f"%{q}%"
    name_rank = case(
        (func.lower(KnowledgeEntity.name) == q.lower(), 0),
        (KnowledgeEntity.name.ilike(f"{q}%"), 1),
        (KnowledgeEntity.name.ilike(pattern), 2),
        else_=3,
    )

    # Search entities
    ent_search_q = (
        select(KnowledgeEntity)
        .where(KnowledgeEntity.name.ilike(pattern) | KnowledgeEntity.summary.ilike(pattern))
        .order_by(name_rank, KnowledgeEntity.updated_at.desc().nulls_last())
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
            .order_by(KnowledgeObservation.observed_at.desc().nulls_last())
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

    Backs the MCP memory_store tool. Always scoped to the calling user via user_id; the
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
    days: int | None = Query(None, ge=1, le=3650),
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
    from ..services.embedding_service import _call_embedding_server  # noqa: F401

    mids = await user_machine_ids(db, _user)

    clean_q = q.strip().lower()
    cache_key = f"semantic:{_user.id}:{clean_q}:{limit}:{tool_filter or ''}:{days or ''}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    # 30s timeout: the embedding server is CPU-only on Apple Silicon
    # (MPS deliberately avoided — see _load_model in embedding/embedding_server.py for the
    # macOS kernel deadlock). A cold-cached query + 4kB Chinese tokenize
    # can easily push 5-12s on M-series CPU. 8s was tripping false
    # "embedding-server-unavailable" returns on a perfectly healthy
    # server, silently degrading semantic search to a trigram fallback.
    # The MCP client's own timeout is well above this.
    embeds = await _call_embedding_server([q], timeout=30.0)
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
    if days:
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        stmt = stmt.where(Document.synced_at >= cutoff)
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

    res = {"results": list(seen.values())}
    await cache_set(cache_key, res, ttl_seconds=300)
    return res


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


# ---------------------------------------------------------------------------
# 3-Tier Memory Architecture Overview
# ---------------------------------------------------------------------------
@router.get("/tiers")
async def get_memory_tiers(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Return an overview of the 3 memory tiers for the current user:
    - L1 Working Memory: recent interactive turns in AskConversation
    - L2 Episodic Memory: daily digests & parsed conversation messages
    - L3 Core/Semantic Memory: curated UserMemory items & knowledge entities
    """
    admin = _is_admin(_user)

    # L1: Ask conversations count
    l1_q = select(func.count()).select_from(AskConversation)
    if not admin:
        l1_q = l1_q.where(AskConversation.user_id == _user.id)
    l1_count = (await db.execute(l1_q)).scalar() or 0

    # L2: Daily summaries count & conversation messages count
    l2_ds_q = select(func.count()).select_from(DailySummary)
    if not admin:
        l2_ds_q = l2_ds_q.where((DailySummary.user_id == _user.id) | (DailySummary.user_id.is_(None)))
    daily_count = (await db.execute(l2_ds_q)).scalar() or 0

    msg_q = select(func.count()).select_from(ConversationMessage)
    if not admin:
        msg_q = msg_q.where(ConversationMessage.document_id.in_(_user_doc_ids_subq(_user)))
    msg_count = (await db.execute(msg_q)).scalar() or 0

    # L3: Core memories count & knowledge entities count
    core_q = select(func.count()).select_from(UserMemory)
    if not admin:
        core_q = core_q.where(UserMemory.user_id == _user.id)
    core_count = (await db.execute(core_q)).scalar() or 0

    ent_q = select(func.count()).select_from(KnowledgeEntity)
    if not admin:
        ent_q = ent_q.where(KnowledgeEntity.user_id == _user.id)
    ent_count = (await db.execute(ent_q)).scalar() or 0

    # Dreams count
    dream_q = select(func.count()).select_from(DreamJournal)
    if not admin:
        dream_q = dream_q.where(DreamJournal.user_id == _user.id)
    dream_count = (await db.execute(dream_q)).scalar() or 0

    return {
        "l1_working": {
            "tier_name": "L1 短期工作记忆 (Working Memory)",
            "conversations": l1_count,
            "description": "即时上下文与最近交互轮次",
        },
        "l2_episodic": {
            "tier_name": "L2 中期情景记忆 (Episodic Memory)",
            "daily_summaries": daily_count,
            "conversation_messages": msg_count,
            "description": "每日研发日报与历史活动事件流",
        },
        "l3_core": {
            "tier_name": "L3 长期核心记忆 (Core / Semantic Memory)",
            "core_memories": core_count,
            "knowledge_entities": ent_count,
            "dream_journals": dream_count,
            "description": "自动做梦萃取与用户维护的核心开发铁律 (MEMORY.md)",
        },
    }


# ---------------------------------------------------------------------------
# L3 Core Memory (MEMORY.md) Endpoints
# ---------------------------------------------------------------------------
class CoreMemoryCreate(BaseModel):
    category: str = "general"
    key: str
    content: str
    confidence: float = 1.0
    parent_id: uuid.UUID | None = None
    tree_path: str | None = None
    is_folder: bool = False


class CoreMemoryUpdate(BaseModel):
    category: str | None = None
    key: str | None = None
    content: str | None = None
    confidence: float | None = None
    parent_id: uuid.UUID | None = None
    tree_path: str | None = None
    is_folder: bool | None = None


@router.get("/core")
async def get_core_memories(
    category: str | None = None,
    active_only: bool = False,
    recall: bool = False,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List current user's core memories (L3).

    active_only: leave out dormant and superseded ones (what an AI should see).
    recall: the caller is handing these to an AI — count it as a use.
    """
    stmt = (
        select(UserMemory)
        .where(UserMemory.user_id == _user.id)
        .order_by(UserMemory.is_folder.desc(), UserMemory.category, UserMemory.updated_at.desc())
    )
    if active_only:
        stmt = stmt.where(UserMemory.status == "active")
    if category:
        if category in ("rule", "rules"):
            stmt = stmt.where(UserMemory.category.in_(["rule", "rules"]))
        elif category in ("tool", "tools"):
            stmt = stmt.where(UserMemory.category.in_(["tool", "tools"]))
        else:
            stmt = stmt.where(UserMemory.category == category)

    res = await db.execute(stmt)
    memories = res.scalars().all()
    if recall:
        await touch_recalled(m.id for m in memories if not m.is_folder)
    return [
        {
            "id": str(m.id),
            "parent_id": str(m.parent_id) if m.parent_id else None,
            "category": m.category,
            "key": m.key,
            "content": m.content,
            "confidence": m.confidence,
            "source": m.source,
            "tree_path": m.tree_path or f"/{m.category}/{m.key}",
            "is_folder": m.is_folder,
            "status": m.status,
            "status_reason": m.status_reason,
            "superseded_by": str(m.superseded_by) if m.superseded_by else None,
            "recall_count": m.recall_count,
            "last_recalled_at": m.last_recalled_at.isoformat() if m.last_recalled_at else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
            "updated_at": m.updated_at.isoformat() if m.updated_at else None,
        }
        for m in memories
    ]


async def _bust_user_memory_cache(user_id: uuid.UUID) -> None:
    try:
        await cache.cache_delete_prefix(f"memory:tree:{user_id}:")
        await cache.cache_delete_prefix(f"memory:stats:{user_id}:")
        await cache.cache_delete_prefix(f"memory:markdown:{user_id}:")
        await cache.cache_delete_prefix(f"learning:check:{user_id}:")
        await cache.cache_delete_prefix(f"project:blueprint:{user_id}:")
    except Exception:
        pass


@router.post("/core/{memory_id}/revive")
async def revive_core_memory(
    memory_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Put a dormant or superseded memory back in force."""
    mem = (await db.execute(
        select(UserMemory).where(UserMemory.id == memory_id, UserMemory.user_id == _user.id)
    )).scalar_one_or_none()
    if not mem:
        raise HTTPException(status_code=404, detail="not found")
    mem.status, mem.status_reason, mem.superseded_by = "active", None, None
    mem.last_recalled_at = datetime.now(timezone.utc)
    await db.commit()
    await _bust_user_memory_cache(_user.id)
    return {"status": "active", "id": str(mem.id)}


@router.get("/core/tree")
async def get_core_memory_tree(
    category: str | None = Query(None, description="Filter by category"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Retrieve user's core memories organized as a true hierarchical directory tree based on tree_path."""
    real_category = category if isinstance(category, str) and category.strip() else None
    cache_key = f"memory:tree:{_user.id}:{real_category or 'all'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    stmt = (
        select(UserMemory)
        .where(UserMemory.user_id == _user.id)
    )
    if real_category:
        if real_category in ("rule", "rules"):
            stmt = stmt.where(UserMemory.category.in_(["rule", "rules"]))
        elif real_category in ("tool", "tools"):
            stmt = stmt.where(UserMemory.category.in_(["tool", "tools"]))
        else:
            stmt = stmt.where(UserMemory.category == real_category)
    stmt = stmt.order_by(UserMemory.category, UserMemory.tree_path, UserMemory.key)
    res = await db.execute(stmt)
    memories = res.scalars().all()

    folder_nodes: dict[str, dict] = {}
    root_nodes: dict[str, dict] = {}

    category_labels = {
        "project": "项目与业务系统",
        "architecture": "架构设计与技术栈",
        "rule": "开发铁律与避坑经验",
        "rules": "开发铁律与避坑经验",
        "tools": "工具链与AI助手生态",
        "preference": "个人偏好与工作习惯",
        "general": "通用常识与约定",
    }

    sorted_memories = sorted(
        memories,
        key=lambda x: (not x.is_folder, len([p for p in (x.tree_path or "").split("/") if p]))
    )

    for m in sorted_memories:
        path = (m.tree_path or f"/{m.category}/{m.key}").strip()
        if not path.startswith("/"):
            path = "/" + path
        parts = [p for p in path.split("/") if p]
        if not parts:
            parts = [m.category, m.key]

        if m.is_folder:
            dir_parts = parts
            leaf_name = None
        else:
            dir_parts = parts[:-1]
            leaf_name = parts[-1]

        curr_dir_path = ""
        parent_children: list[dict] | None = None

        for idx, part in enumerate(dir_parts):
            curr_dir_path += f"/{part}"
            if curr_dir_path not in folder_nodes:
                display_label = category_labels.get(part, part) if idx == 0 else part
                is_explicit_this = (m.is_folder and idx == len(dir_parts) - 1)
                folder_node = {
                    "id": str(m.id) if is_explicit_this else f"dir:{curr_dir_path}",
                    "name": part,
                    "title": display_label,
                    "category": m.category,
                    "tree_path": curr_dir_path,
                    "is_folder": True,
                    "children": [],
                }
                folder_nodes[curr_dir_path] = folder_node
                if parent_children is not None:
                    parent_children.append(folder_node)
                else:
                    root_nodes[curr_dir_path] = folder_node
            else:
                if m.is_folder and idx == len(dir_parts) - 1:
                    folder_nodes[curr_dir_path]["id"] = str(m.id)

            parent_children = folder_nodes[curr_dir_path]["children"]

        if not m.is_folder and leaf_name:
            leaf_node = {
                "id": str(m.id),
                "name": leaf_name,
                "title": m.key,
                "parent_id": str(m.parent_id) if m.parent_id else None,
                "category": m.category,
                "key": m.key,
                "content": m.content,
                "confidence": m.confidence,
                "source": m.source,
                "tree_path": path,
                "is_folder": False,
                "status": m.status,
                "status_reason": m.status_reason,
                "recall_count": m.recall_count,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "updated_at": m.updated_at.isoformat() if m.updated_at else None,
                "children": [],
            }

            if parent_children is not None:
                parent_children.append(leaf_node)
            else:
                root_nodes[f"leaf:{m.id}"] = leaf_node

    payload = {
        "tree": list(root_nodes.values()),
        "total_count": len(memories),
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


@router.get("/core/markdown")
async def get_core_memory_markdown(
    exclude: str | None = Query(None, description="Comma-separated categories to leave out, e.g. pitfall"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Export current user's core memories as formatted MEMORY.md."""
    from ..services.dreaming_service import export_core_memory_markdown

    skip = sorted({c.strip().lower() for c in (exclude or "").split(",") if c.strip()})
    cache_key = f"memory:markdown:{_user.id}:{','.join(skip)}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    md = await export_core_memory_markdown(db, _user, exclude=skip)
    payload = {"markdown": md}
    await cache_set(cache_key, payload, ttl_seconds=60)
    return payload


@router.post("/core")
async def create_core_memory(
    body: CoreMemoryCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Manually add or update a core memory entry."""
    cat = (body.category or "general").strip().lower()
    key = body.key.strip().lower().replace(" ", "_")
    content = body.content.strip()

    if not key or not content:
        return {"error": "key and content are required"}

    # Compute path
    tree_path = body.tree_path
    if not tree_path:
        if body.parent_id:
            parent = (await db.execute(
                select(UserMemory).where(UserMemory.id == body.parent_id, UserMemory.user_id == _user.id)
            )).scalar_one_or_none()
            if parent:
                parent_p = parent.tree_path or f"/{parent.category}/{parent.key}"
                tree_path = f"{parent_p.rstrip('/')}/{key}"
        if not tree_path:
            tree_path = f"/{cat}/{key}"

    existing = (await db.execute(
        select(UserMemory).where(
            UserMemory.user_id == _user.id,
            UserMemory.category == cat,
            UserMemory.key == key,
        ).limit(1)
    )).scalar_one_or_none()

    if existing:
        existing.content = content
        existing.confidence = body.confidence
        existing.source = "manual"
        existing.parent_id = body.parent_id
        existing.tree_path = tree_path
        existing.is_folder = body.is_folder
        existing.updated_at = datetime.now(timezone.utc)
        await db.commit()
        await _bust_user_memory_cache(_user.id)
        return {"status": "updated", "id": str(existing.id)}

    new_mem = UserMemory(
        user_id=_user.id,
        category=cat,
        key=key,
        content=content,
        confidence=body.confidence,
        source="manual",
        parent_id=body.parent_id,
        tree_path=tree_path,
        is_folder=body.is_folder,
    )
    db.add(new_mem)
    await db.commit()
    await db.refresh(new_mem)
    await _bust_user_memory_cache(_user.id)
    return {"status": "created", "id": str(new_mem.id)}


@router.put("/core/{memory_id}")
async def update_core_memory(
    memory_id: uuid.UUID,
    body: CoreMemoryUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Update an existing core memory entry."""
    mem = (await db.execute(
        select(UserMemory).where(UserMemory.id == memory_id, UserMemory.user_id == _user.id)
    )).scalar_one_or_none()
    if not mem:
        return {"error": "not found"}

    if body.category is not None:
        mem.category = body.category.strip().lower()
    if body.key is not None:
        mem.key = body.key.strip().lower().replace(" ", "_")
    if body.content is not None:
        mem.content = body.content.strip()
        # Hand-edited content is the user's now; dreaming must not overwrite it.
        mem.source = "manual"
    if body.confidence is not None:
        mem.confidence = body.confidence
    if body.parent_id is not None:
        mem.parent_id = body.parent_id
    if body.tree_path is not None:
        mem.tree_path = body.tree_path.strip()
    if body.is_folder is not None:
        mem.is_folder = body.is_folder
    mem.updated_at = datetime.now(timezone.utc)

    await db.commit()
    await _bust_user_memory_cache(_user.id)
    return {"status": "updated", "id": str(mem.id)}


@router.delete("/core/{memory_id}")
async def delete_core_memory(
    memory_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Delete a core memory entry (pruning/forgetting)."""
    mem = (await db.execute(
        select(UserMemory).where(UserMemory.id == memory_id, UserMemory.user_id == _user.id)
    )).scalar_one_or_none()
    if not mem:
        return {"error": "not found"}

    await db.delete(mem)
    await db.commit()
    await _bust_user_memory_cache(_user.id)
    return {"status": "deleted", "id": str(memory_id)}


# ---------------------------------------------------------------------------
# Dreaming & Dream Journals (DREAMS.md) Endpoints
# ---------------------------------------------------------------------------
@router.get("/dreams")
async def list_dream_journals(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """List historical dream journals for the current user."""
    stmt = (
        select(DreamJournal)
        .where(DreamJournal.user_id == _user.id)
        .order_by(DreamJournal.created_at.desc())
        .offset(offset)
        .limit(limit)
    )
    res = await db.execute(stmt)
    journals = res.scalars().all()

    return {
        "journals": [
            {
                "id": str(j.id),
                "dream_date": j.dream_date.isoformat(),
                "stage_metrics": j.stage_metrics or {},
                "created_at": j.created_at.isoformat() if j.created_at else None,
                "summary_snippet": (j.rem_reflections or j.light_sleep_notes or "")[:200],
            }
            for j in journals
        ]
    }


@router.get("/dreams/{dream_id}")
async def get_dream_journal_detail(
    dream_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get full details and markdown report of a single dream journal."""
    journal = (await db.execute(
        select(DreamJournal).where(DreamJournal.id == dream_id, DreamJournal.user_id == _user.id)
    )).scalar_one_or_none()
    if not journal:
        return {"error": "not found"}

    return {
        "id": str(journal.id),
        "dream_date": journal.dream_date.isoformat(),
        "stage_metrics": journal.stage_metrics or {},
        "light_sleep_notes": journal.light_sleep_notes,
        "rem_reflections": journal.rem_reflections,
        "deep_consolidations": journal.deep_consolidations,
        "report_markdown": journal.report_markdown,
        "created_at": journal.created_at.isoformat() if journal.created_at else None,
    }


class DreamTriggerRequest(BaseModel):
    days_back: int = 1
    start_date: str | None = None
    end_date: str | None = None


class DreamBackfillRequest(BaseModel):
    chunk_days: int = 3
    max_chunks: int = 30
    run_async: bool = True


@router.post("/dream")
async def trigger_on_demand_dream(
    body: DreamTriggerRequest | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Trigger an on-demand Dreaming Consolidation cycle for the current user."""
    from datetime import date
    from ..services.dreaming_service import run_dreaming_pipeline

    days = body.days_back if (body and body.days_back is not None) else 1
    s_date = date.fromisoformat(body.start_date) if body and body.start_date else None
    e_date = date.fromisoformat(body.end_date) if body and body.end_date else None

    journal = await run_dreaming_pipeline(
        db,
        _user,
        days_back=days,
        start_date=s_date,
        end_date=e_date,
        tag="on_demand",
    )

    return {
        "status": "completed",
        "journal_id": str(journal.id),
        "dream_date": journal.dream_date.isoformat(),
        "stage_metrics": journal.stage_metrics,
        "report_markdown": journal.report_markdown,
    }


@router.post("/dream/backfill")
async def trigger_dream_backfill(
    body: DreamBackfillRequest | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Trigger progressive historical dreaming replay across all previous records."""
    from ..services.cluster import cluster
    from ..tasks.dreaming_tasks import BACKFILL_LOCK, get_backfill_status, run_user_backfill_async

    req = body or DreamBackfillRequest()
    user_id_str = str(_user.id)

    # One backfill per user, whichever replica gets the request
    mutex = await cluster.mutex(BACKFILL_LOCK + user_id_str)
    if mutex is None:
        return {
            "status": "already_running",
            "message": "历史回填任务已在运行中，请勿重复触发",
            "progress": await get_backfill_status(user_id_str),
        }

    if req.run_async:
        cluster.spawn(run_user_backfill_async(
            user_id=user_id_str,
            chunk_days=req.chunk_days,
            max_chunks=req.max_chunks,
            mutex=mutex,
        ))
        return {
            "status": "started",
            "message": f"历史记忆渐进回填任务已在后台启动 (每 {req.chunk_days} 天一切片)",
            "chunk_days": req.chunk_days,
            "max_chunks": req.max_chunks,
        }
    else:
        res = await run_user_backfill_async(
            user_id=user_id_str,
            chunk_days=req.chunk_days,
            max_chunks=req.max_chunks,
            mutex=mutex,
        )
        return {
            "status": "completed",
            "result": res,
        }


@router.get("/dream/backfill/status")
async def get_dream_backfill_status(
    _user: User = Depends(get_current_user),
) -> dict:
    """Query current progress or latest status of historical dreaming backfill."""
    from ..tasks.dreaming_tasks import get_backfill_status
    return await get_backfill_status(str(_user.id))


@router.post("/bootstrap")
async def bootstrap_memory_tree(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Bootstrap the initial L3 UserMemory tree directly from historical Knowledge Graph entities & observations."""
    from ..services.dreaming_service import bootstrap_memories_from_knowledge_graph
    return await bootstrap_memories_from_knowledge_graph(db, _user)


