"""Hybrid search engine — semantic (pgvector) + full-text (tsvector) + knowledge graph."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, text, or_
from sqlalchemy.ext.asyncio import AsyncSession

from .db import Document, DocumentEmbedding, KnowledgeEntity, KnowledgeObservation, Machine

logger = logging.getLogger("mcp_memory.search")


_local_model = None
_model_lock = None


def _get_local_model():
    """Load BGE-M3 model lazily."""
    global _local_model, _model_lock
    import threading
    if _model_lock is None:
        _model_lock = threading.Lock()
    if _local_model is not None:
        return _local_model
    with _model_lock:
        if _local_model is not None:
            return _local_model
        try:
            from sentence_transformers import SentenceTransformer
            _local_model = SentenceTransformer("BAAI/bge-m3")
            return _local_model
        except Exception:
            return None


async def _get_embedding(query: str) -> list[float] | None:
    """Generate embedding for a query. Tries local BGE-M3 first, then remote API."""
    import asyncio
    # Try local model
    model = _get_local_model()
    if model is not None:
        try:
            embedding = await asyncio.to_thread(
                lambda: model.encode(query, normalize_embeddings=True).tolist()
            )
            return embedding
        except Exception:
            pass

    # Fallback: remote API
    import os
    api_key = os.environ.get("MEMENTO_EMBEDDING_API_KEY") or os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("MEMENTO_EMBEDDING_BASE_URL")
    emb_model = os.environ.get("MEMENTO_EMBEDDING_MODEL", "text-embedding-v4")
    if not api_key or not base_url:
        return None
    try:
        import openai
        client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
        response = await client.embeddings.create(input=query, model=emb_model)
        return response.data[0].embedding
    except Exception as e:
        logger.debug("Embedding generation failed: %s", e)
        return None


async def _semantic_search(
    db: AsyncSession, query: str, limit: int, user_machine_ids: list[uuid.UUID] | None,
    tool_filter: str | None, cutoff: datetime | None,
) -> list[dict]:
    """Search via pgvector cosine similarity."""
    embedding = await _get_embedding(query)
    if embedding is None:
        return []

    try:
        from pgvector.sqlalchemy import Vector
    except ImportError:
        return []

    q = (
        select(
            DocumentEmbedding.chunk_text,
            DocumentEmbedding.document_id,
            Document.title,
            Document.tool_id,
            Document.relative_path,
            Document.synced_at,
            DocumentEmbedding.embedding.cosine_distance(embedding).label("distance"),
        )
        .join(Document, DocumentEmbedding.document_id == Document.id)
        .order_by("distance")
        .limit(limit)
    )
    if user_machine_ids is not None:
        q = q.where(Document.machine_id.in_(user_machine_ids))
    if tool_filter:
        q = q.where(Document.tool_id == tool_filter)
    if cutoff:
        q = q.where(Document.synced_at >= cutoff)

    result = await db.execute(q)
    return [
        {
            "content": row.chunk_text,
            "title": row.title or row.relative_path,
            "tool_id": row.tool_id,
            "relative_path": row.relative_path,
            "date": row.synced_at.strftime("%Y-%m-%d") if row.synced_at else "",
            "score": 1.0 - row.distance,  # Convert distance to similarity
            "source": "semantic",
        }
        for row in result.all()
    ]


async def _fulltext_search(
    db: AsyncSession, query: str, limit: int, user_machine_ids: list[uuid.UUID] | None,
    tool_filter: str | None, cutoff: datetime | None,
) -> list[dict]:
    """Search via PostgreSQL LIKE (simple but effective)."""
    pattern = f"%{query}%"
    q = (
        select(Document.title, Document.tool_id, Document.relative_path,
               Document.content, Document.synced_at)
        .where(
            or_(
                Document.content.ilike(pattern),
                Document.title.ilike(pattern),
            )
        )
        .order_by(Document.synced_at.desc())
        .limit(limit)
    )
    if user_machine_ids is not None:
        q = q.where(Document.machine_id.in_(user_machine_ids))
    if tool_filter:
        q = q.where(Document.tool_id == tool_filter)
    if cutoff:
        q = q.where(Document.synced_at >= cutoff)

    result = await db.execute(q)
    results = []
    for row in result.all():
        # Extract relevant snippet around the match
        content = row.content or ""
        idx = content.lower().find(query.lower())
        if idx >= 0:
            start = max(0, idx - 200)
            end = min(len(content), idx + len(query) + 300)
            snippet = ("..." if start > 0 else "") + content[start:end] + ("..." if end < len(content) else "")
        else:
            snippet = content[:500]

        results.append({
            "content": snippet,
            "title": row.title or row.relative_path,
            "tool_id": row.tool_id,
            "relative_path": row.relative_path,
            "date": row.synced_at.strftime("%Y-%m-%d") if row.synced_at else "",
            "score": 0.5,  # Fixed score for full-text matches
            "source": "fulltext",
        })
    return results


async def _graph_search(
    db: AsyncSession, query: str, limit: int, user_id: uuid.UUID | None,
) -> list[dict]:
    """Search via knowledge graph entity matching."""
    # Find matching entities
    q = (
        select(KnowledgeEntity.name, KnowledgeEntity.entity_type, KnowledgeEntity.summary)
        .where(KnowledgeEntity.name.ilike(f"%{query}%"))
        .limit(5)
    )
    if user_id:
        q = q.where(or_(KnowledgeEntity.user_id == user_id, KnowledgeEntity.user_id.is_(None)))

    entities = await db.execute(q)
    entity_rows = entities.all()
    if not entity_rows:
        return []

    results = []
    for name, etype, summary in entity_rows:
        # Get recent observations
        obs_q = (
            select(KnowledgeObservation.content, KnowledgeObservation.observed_at)
            .join(KnowledgeEntity, KnowledgeObservation.entity_id == KnowledgeEntity.id)
            .where(KnowledgeEntity.name == name)
            .order_by(KnowledgeObservation.observed_at.desc())
            .limit(3)
        )
        obs_result = await db.execute(obs_q)
        observations = [f"- {r.content}" for r in obs_result.all()]

        content = f"**{name}** ({etype})\n"
        if summary:
            content += f"{summary}\n"
        if observations:
            content += "\nRecent observations:\n" + "\n".join(observations)

        results.append({
            "content": content,
            "title": name,
            "tool_id": "knowledge_graph",
            "relative_path": f"entity/{etype}/{name}",
            "date": "",
            "score": 0.7,
            "source": "graph",
        })
    return results


async def hybrid_search(
    db: AsyncSession,
    query: str,
    limit: int = 5,
    tool_filter: str | None = None,
    days: int | None = None,
    user_id: uuid.UUID | None = None,
) -> list[dict]:
    """Combined semantic + full-text + graph search with deduplication."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=days) if days else None

    # Get user's machine IDs for data isolation
    user_machine_ids = None
    if user_id:
        result = await db.execute(select(Machine.id).where(Machine.user_id == user_id))
        user_machine_ids = [r[0] for r in result.all()]

    # Run all search strategies
    semantic_results = await _semantic_search(db, query, limit * 2, user_machine_ids, tool_filter, cutoff)
    fulltext_results = await _fulltext_search(db, query, limit * 2, user_machine_ids, tool_filter, cutoff)
    graph_results = await _graph_search(db, query, limit, user_id)

    # Merge and deduplicate by relative_path
    seen = set()
    merged = []
    for r in sorted(semantic_results + fulltext_results + graph_results, key=lambda x: -x["score"]):
        key = r["relative_path"]
        if key in seen:
            continue
        seen.add(key)
        merged.append(r)
        if len(merged) >= limit:
            break

    return merged
