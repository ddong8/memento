"""Memory compaction — periodically compress old observations into summaries.

Old observations (>7 days) for the same entity get merged into a single summary,
keeping the knowledge graph lean and relevant. Recent observations stay intact.

Run as periodic task or manually: python -m server.services.memory_compaction
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import KnowledgeEntity, KnowledgeObservation, KnowledgeRelation

logger = logging.getLogger("memory_compaction")

# Observations older than this get compacted
COMPACTION_AGE_DAYS = int(os.environ.get("MEMENTO_COMPACTION_AGE_DAYS", "7"))
# Minimum observations per entity before compaction triggers
MIN_OBSERVATIONS_TO_COMPACT = 5

AI_BASE_URL = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
AI_API_KEY = os.environ.get("MEMENTO_AI_API_KEY", "")
AI_MODEL = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5")

_COMPACT_PROMPT = (
    "你是一个知识库管理员。以下是关于实体「{entity_name}」({entity_type}) 的多条历史观察记录。\n"
    "请将它们合并压缩为 1-3 条精炼的摘要，保留关键事实，去掉重复和过时信息。\n"
    "如果有矛盾信息，保留最新的。用中文回复。\n\n"
    "当前实体摘要：{current_summary}\n\n"
    "历史观察记录：\n{observations}\n\n"
    "返回 JSON：\n"
    '{"summary": "更新后的实体摘要", "compacted_observations": ["压缩后的观察1", "压缩后的观察2"]}\n'
)


async def _call_llm(prompt: str) -> dict | None:
    """Call LLM for compaction."""
    if not AI_API_KEY:
        return None
    try:
        import openai
        client = openai.AsyncOpenAI(api_key=AI_API_KEY, base_url=AI_BASE_URL)
        response = await client.chat.completions.create(
            model=AI_MODEL,
            messages=[{"role": "user", "content": prompt + "\n\nRespond with JSON only."}],
            max_tokens=1000,
        )
        text = (response.choices[0].message.content or "").strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1]
            if text.endswith("```"):
                text = text[:-3]
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
    except Exception as e:
        logger.warning("Compaction LLM call failed: %s", e)
    return None


async def compact_entity(db: AsyncSession, entity: KnowledgeEntity) -> int:
    """Compact old observations for a single entity. Returns count removed."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=COMPACTION_AGE_DAYS)

    # Get old observations
    old_obs = (await db.execute(
        select(KnowledgeObservation)
        .where(
            KnowledgeObservation.entity_id == entity.id,
            KnowledgeObservation.observed_at < cutoff,
        )
        .order_by(KnowledgeObservation.observed_at)
    )).scalars().all()

    if len(old_obs) < MIN_OBSERVATIONS_TO_COMPACT:
        return 0

    # Build prompt
    obs_text = "\n".join(
        f"- [{o.observed_at.strftime('%Y-%m-%d') if o.observed_at else '?'}] {o.content}"
        for o in old_obs
    )
    prompt = _COMPACT_PROMPT.format(
        entity_name=entity.name,
        entity_type=entity.entity_type,
        current_summary=entity.summary or "(无)",
        observations=obs_text,
    )

    result = await _call_llm(prompt)
    if not result:
        return 0

    # Update entity summary
    new_summary = result.get("summary", "")
    if new_summary:
        entity.summary = new_summary
        entity.updated_at = datetime.now(timezone.utc)

    # Delete old observations
    old_ids = [o.id for o in old_obs]
    await db.execute(
        delete(KnowledgeObservation).where(KnowledgeObservation.id.in_(old_ids))
    )

    # Insert compacted observations
    compacted = result.get("compacted_observations", [])
    for content in compacted:
        if content and content.strip():
            db.add(KnowledgeObservation(
                entity_id=entity.id,
                content=content.strip(),
            ))

    removed = len(old_ids) - len(compacted)
    logger.info("Compacted %s: %d old → %d compacted (removed %d)",
                entity.name, len(old_ids), len(compacted), removed)
    return removed


async def compact_stale_relations(db: AsyncSession) -> int:
    """Remove weak relations (strength < 1.5) that haven't been reinforced."""
    result = await db.execute(
        delete(KnowledgeRelation).where(KnowledgeRelation.strength < 1.5)
    )
    count = result.rowcount
    if count:
        logger.info("Removed %d weak relations", count)
    return count


async def run_compaction(db: AsyncSession) -> dict:
    """Run full memory compaction cycle."""
    logger.info("Starting memory compaction...")

    # Get entities with many old observations
    entities = (await db.execute(
        select(KnowledgeEntity).order_by(KnowledgeEntity.updated_at)
    )).scalars().all()

    total_removed = 0
    entities_compacted = 0
    for entity in entities:
        removed = await compact_entity(db, entity)
        if removed > 0:
            total_removed += removed
            entities_compacted += 1
            await db.commit()

    # Clean weak relations
    weak_removed = await compact_stale_relations(db)
    await db.commit()

    stats = {
        "entities_compacted": entities_compacted,
        "observations_removed": total_removed,
        "weak_relations_removed": weak_removed,
    }
    logger.info("Compaction complete: %s", stats)
    return stats
