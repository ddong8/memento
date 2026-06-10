"""Knowledge graph auto-extraction — extracts entities and relations from conversations using LLM."""

from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    Document, KnowledgeEntity, KnowledgeObservation, KnowledgeRelation, Machine,
)

logger = logging.getLogger("graph_service")

_EXTRACTION_TEMPLATE = (
    "分析以下 AI 编程对话，提取结构化知识。用中文回复。\n\n"
    '返回 JSON 对象：\n'
    '{"entities": [{"name": "实体名", "type": "project|tool|technology|concept|person|file", "summary": "简要描述"}],\n'
    ' "relations": [{"source": "实体1", "target": "实体2", "type": "uses|creates|depends_on|fixes|discussed"}],\n'
    ' "observations": [{"entity": "实体名", "content": "学到了什么、做了什么决定"}]}\n\n'
    "规则：\n"
    "- 提取具体的、可复用的知识（不要泛泛而谈）\n"
    "- 实体名用标准名称（如 PostgreSQL 而非 postgres 数据库）\n"
    "- summary 和 observations 的 content 用中文\n"
    "- 最多 10 个实体、10 个关系、10 个观察\n"
    "- 重点关注：使用的技术、解决的问题、做出的决定\n\n"
    "对话内容：\n"
)


async def _call_llm(prompt: str) -> dict | None:
    """Call LLM for entity extraction via OpenAI-compatible API. Returns parsed JSON or None."""
    # Use existing MEMENTO_AI_* config
    api_key = os.environ.get("MEMENTO_AI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    base_url = os.environ.get("MEMENTO_AI_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1")
    model = os.environ.get("MEMENTO_AI_MODEL", "kimi-k2.5")
    if not api_key:
        # Try Anthropic as fallback
        anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("MEMENTO_ANTHROPIC_API_KEY")
        if anthropic_key:
            return await _call_anthropic(prompt, anthropic_key)
        logger.debug("No AI API key set, skipping graph extraction")
        return None

    try:
        import openai
        client = openai.AsyncOpenAI(api_key=api_key, base_url=base_url)
        response = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt + "\n\nRespond with JSON only."}],
            max_tokens=2000,
        )
        text = response.choices[0].message.content or "{}"
        # Extract JSON from response (model may wrap in markdown code block)
        # Strip markdown code fences if present
        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[-1]  # Remove first line
            if text.endswith("```"):
                text = text[:-3]
        text = text.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(text[start:end])
            if isinstance(parsed, dict):
                return parsed
        return None
    except json.JSONDecodeError as e:
        logger.info("LLM returned invalid JSON: %s", str(e)[:100])
        return None
    except Exception as e:
        logger.warning("LLM extraction failed: %s", e)
        return None


async def _call_anthropic(prompt: str, api_key: str) -> dict | None:
    """Call Anthropic Claude for entity extraction."""
    try:
        import anthropic
        client = anthropic.AsyncAnthropic(api_key=api_key)
        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt + "\n\nRespond with JSON only."}],
        )
        text = response.content[0].text
        # Extract JSON from response
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
    except Exception as e:
        logger.warning("Anthropic extraction failed: %s", e)
    return None


async def extract_knowledge_from_document(
    db: AsyncSession, doc: Document, user_id: uuid.UUID | None = None,
) -> int:
    """Extract entities, relations, and observations from a document. Returns count of items created.

    Side-effects on ``doc.knowledge_status`` / ``doc.knowledge_attempts``:
      * 'skipped' — content too short or wrong category; never tried.
      * 'failed'  — LLM call failed (network / 401 / parse). attempts++ so
        the knowledge_retry beat picks it up next tick.
      * 'ok'      — extraction completed (zero entities is still 'ok' —
        the LLM saw the doc and decided there's nothing graph-worthy).
    """
    if not doc.content or len(doc.content) < 200:
        doc.knowledge_status = "skipped"
        return 0

    if doc.category not in ("conversation", "memory", "learning", "plan"):
        doc.knowledge_status = "skipped"
        return 0

    # Skip if already extracted for this content version (hash-based dedup)
    import hashlib
    content_hash = hashlib.md5(doc.content[:4000].encode()).hexdigest()
    existing_obs = (await db.execute(
        select(KnowledgeObservation.id)
        .where(KnowledgeObservation.source_document_id == doc.id)
        .limit(1)
    )).scalar_one_or_none()

    if existing_obs and doc.metadata_.get("_graph_hash") == content_hash:
        doc.knowledge_status = "ok"
        return 0  # Already extracted for this content version

    # Clear old observations from this document
    from sqlalchemy import delete
    await db.execute(
        delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id == doc.id)
    )

    # Truncate to ~4000 chars for LLM (cost control)
    content = doc.content[:4000]
    prompt = _EXTRACTION_TEMPLATE + content

    # Charge an attempt up front so a hung LLM still counts toward the
    # cap (otherwise a stuck call would never block subsequent retries).
    doc.knowledge_attempts = (doc.knowledge_attempts or 0) + 1
    result = await _call_llm(prompt)
    if not result:
        doc.knowledge_status = "failed"
        return 0

    count = 0

    # Get or determine user_id from document's machine
    if not user_id and doc.machine_id:
        machine = (await db.execute(
            select(Machine.user_id).where(Machine.id == doc.machine_id)
        )).scalar_one_or_none()
        user_id = machine

    # Process entities
    entity_map: dict[str, KnowledgeEntity] = {}
    for e in result.get("entities", []):
        name = e.get("name", "").strip()
        etype = e.get("type", "concept").strip()
        if not name:
            continue

        # Upsert entity — scoped to the document's owner so user B's ingest
        # can't attach observations to user A's entity just because the LLM
        # pulled out the same name. Schema already has
        # UniqueConstraint(user_id, name, entity_type); this query was missing
        # the user_id predicate, silently cross-pollinating knowledge graphs.
        existing = (await db.execute(
            select(KnowledgeEntity).where(
                KnowledgeEntity.name == name,
                KnowledgeEntity.entity_type == etype,
                KnowledgeEntity.user_id == user_id,
            ).limit(1)
        )).scalar_one_or_none()

        if existing:
            if e.get("summary") and (not existing.summary or len(e["summary"]) > len(existing.summary)):
                existing.summary = e["summary"]
            entity_map[name] = existing
        else:
            entity = KnowledgeEntity(
                user_id=user_id,
                name=name,
                entity_type=etype,
                summary=e.get("summary"),
            )
            db.add(entity)
            await db.flush()
            entity_map[name] = entity
            count += 1

    # Process relations
    for r in result.get("relations", []):
        source = entity_map.get(r.get("source", ""))
        target = entity_map.get(r.get("target", ""))
        if source and target and source.id != target.id:
            # Check if relation exists
            existing_rel = (await db.execute(
                select(KnowledgeRelation).where(
                    KnowledgeRelation.source_id == source.id,
                    KnowledgeRelation.target_id == target.id,
                    KnowledgeRelation.relation_type == r.get("type", "related"),
                ).limit(1)
            )).scalar_one_or_none()

            if existing_rel:
                existing_rel.strength = (existing_rel.strength or 1.0) + 1.0
            else:
                db.add(KnowledgeRelation(
                    source_id=source.id,
                    target_id=target.id,
                    relation_type=r.get("type", "related"),
                ))
                count += 1

    # Process observations
    for o in result.get("observations", []):
        entity_name = o.get("entity", "")
        entity = entity_map.get(entity_name)
        content_text = o.get("content", "").strip()
        if entity and content_text:
            db.add(KnowledgeObservation(
                entity_id=entity.id,
                content=content_text,
                source_document_id=doc.id,
            ))
            count += 1

    # Mark this content version as extracted
    meta = dict(doc.metadata_ or {})
    meta["_graph_hash"] = content_hash
    doc.metadata_ = meta
    doc.knowledge_status = "ok"

    await db.flush()
    logger.info("Extracted %d knowledge items from %s/%s", count, doc.tool_id, doc.relative_path)
    return count
