"""Knowledge graph operations — entity context and observation storage."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from .db import (
    Document, KnowledgeEntity, KnowledgeObservation, KnowledgeRelation,
    Machine, Project,
)


async def get_entity_context(
    db: AsyncSession, project_name: str, user_id: uuid.UUID | None = None,
) -> str:
    """Build comprehensive project context from knowledge graph + documents."""
    parts = []

    # 1. Find the project
    project_q = select(Project).where(
        or_(
            Project.title.ilike(f"%{project_name}%"),
            Project.slug.ilike(f"%{project_name}%"),
        )
    ).limit(1)
    project = (await db.execute(project_q)).scalar_one_or_none()

    if project:
        parts.append(f"# Project: {project.title}")
        parts.append(f"**Tool**: {project.tool_id}")
        if project.source_path:
            parts.append(f"**Path**: `{project.source_path}`")

        # Get document stats
        doc_stats = await db.execute(
            select(Document.category, func.count())
            .where(Document.project_id == project.id)
            .group_by(Document.category)
        )
        stats = {r[0]: r[1] for r in doc_stats.all()}
        if stats:
            parts.append("\n## Documents")
            for cat, count in sorted(stats.items()):
                parts.append(f"- {cat}: {count}")

        # Get recent conversation titles
        recent = await db.execute(
            select(Document.title, Document.synced_at)
            .where(Document.project_id == project.id, Document.category == "conversation")
            .order_by(Document.synced_at.desc())
            .limit(5)
        )
        convos = recent.all()
        if convos:
            parts.append("\n## Recent Conversations")
            for title, synced_at in convos:
                parts.append(f"- {title} ({synced_at.strftime('%Y-%m-%d')})")

        # Get memory/plan files
        memory_docs = await db.execute(
            select(Document.title, Document.content, Document.category)
            .where(
                Document.project_id == project.id,
                Document.category.in_(["memory", "plan", "identity"]),
            )
            .order_by(Document.synced_at.desc())
            .limit(5)
        )
        for title, content, cat in memory_docs.all():
            parts.append(f"\n## {cat.title()}: {title}")
            parts.append((content or "")[:1000])

    # 2. Knowledge graph entities matching the project name
    entity_filter = [KnowledgeEntity.name.ilike(f"%{project_name}%")]
    if user_id:
        entity_filter.append(
            or_(KnowledgeEntity.user_id == user_id, KnowledgeEntity.user_id.is_(None))
        )

    entities = await db.execute(
        select(KnowledgeEntity).where(*entity_filter).limit(10)
    )
    entity_list = entities.scalars().all()

    if entity_list:
        parts.append("\n## Knowledge Graph")
        for entity in entity_list:
            parts.append(f"\n### {entity.name} ({entity.entity_type})")
            if entity.summary:
                parts.append(entity.summary)

            # Relations
            rels = await db.execute(
                select(KnowledgeRelation, KnowledgeEntity)
                .join(KnowledgeEntity, KnowledgeRelation.target_id == KnowledgeEntity.id)
                .where(KnowledgeRelation.source_id == entity.id)
                .limit(10)
            )
            for rel, target in rels.all():
                parts.append(f"  → {rel.relation_type} → **{target.name}** ({target.entity_type})")

            # Observations
            obs = await db.execute(
                select(KnowledgeObservation.content, KnowledgeObservation.observed_at)
                .where(KnowledgeObservation.entity_id == entity.id)
                .order_by(KnowledgeObservation.observed_at.desc())
                .limit(5)
            )
            for content, obs_at in obs.all():
                date_str = obs_at.strftime("%Y-%m-%d") if obs_at else ""
                parts.append(f"  - [{date_str}] {content}")

    if not parts:
        return f"No context found for '{project_name}'."

    return "\n".join(parts)


async def store_observation(
    db: AsyncSession,
    content: str,
    entity_name: str | None = None,
    entity_type: str = "concept",
    user_id: uuid.UUID | None = None,
) -> str:
    """Store a new observation, creating the entity if needed."""
    if not entity_name:
        # Auto-extract entity from content (simple heuristic)
        words = content.split()
        entity_name = " ".join(words[:3]) if len(words) > 3 else content[:50]

    # Find or create entity
    q = select(KnowledgeEntity).where(
        KnowledgeEntity.name == entity_name,
        KnowledgeEntity.entity_type == entity_type,
    )
    if user_id:
        q = q.where(KnowledgeEntity.user_id == user_id)

    entity = (await db.execute(q)).scalar_one_or_none()
    if not entity:
        entity = KnowledgeEntity(
            user_id=user_id,
            name=entity_name,
            entity_type=entity_type,
        )
        db.add(entity)
        await db.flush()

    # Add observation
    obs = KnowledgeObservation(
        entity_id=entity.id,
        content=content,
    )
    db.add(obs)
    await db.flush()

    return f"Stored observation for entity '{entity_name}' ({entity_type}): {content[:100]}"
