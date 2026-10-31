"""Retrieval for /api/ask: hybrid keyword + vector ranking over the user's
documents, and the core memories recalled alongside them.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import logging
import math
import os
import re
from typing import Any
import uuid


from sqlalchemy import or_, select, func, case
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from contextlib import asynccontextmanager
import inspect

from ..db.models import Document, User, UserMemory, Project
from ..db.session import async_session_factory
from ..services.user_filter import user_machine_ids, apply_user_filter
from ..services.memory_lifecycle import touch_recalled
from ..api.search import _semantic_doc_ranks, RRF_K

logger = logging.getLogger("server.ask")


@asynccontextmanager
async def _safe_begin_nested(db: AsyncSession):
    """Savepoint context manager supporting both SQLAlchemy AsyncSession and unit test AsyncMocks."""
    if not hasattr(db, "begin_nested"):
        yield
        return
    nested = db.begin_nested()
    if inspect.iscoroutine(nested):
        nested = await nested
    if hasattr(nested, "__aenter__"):
        async with nested:
            yield
    elif hasattr(nested, "__enter__"):
        with nested:
            yield
    else:
        yield


# How many documents to ground the answer in. Above ~8 the prompt gets long
# enough that recall degrades (lost-in-the-middle) for no accuracy gain.
TOP_K = 6
# Per-document context budget. 6 x 1500 ~= 9k chars, comfortably inside a
# 32k-token context alongside the conversation history.
CHARS_PER_DOC = 1500

# Exact deterministic tokens: CAS registry numbers, git commits, code file names.
_EXACT_TOKEN_RES = (
    re.compile(r"\b\d{2,7}-\d{2}-\d\b"),
    re.compile(r"\b[0-9a-f]{7,40}\b"),
    re.compile(r"\b[\w-]+\.(?:py|tsx?|jsx?|rs|go|ya?ml|json|md)\b"),
)


def fuse_ranks(docs: list, kw_ids: list, sem_ids: list, q: str) -> list:
    """`docs` best first by Reciprocal Rank Fusion of the keyword and semantic orders.

    Only ranks count. Replaying the frozen evaluation set (v1, 53 questions, 2026-10-27) showed what
    two extra terms did: adding cosine similarity on top (as large as the RRF score itself) let the
    weaker semantic channel outvote keyword, and a 1.8x boost for titles/paths containing "agent",
    "rule", "规范"... hit 75% of all documents — every Claude Code subagent transcript
    (subagents/agent-*.jsonl) — and pushed them over the answer. Together they took MRR from 0.42 to
    0.28, below keyword alone. Rules and pitfalls reach the answer through retrieve_core_memories,
    not through document rank."""
    kw_rank = {doc_id: i for i, doc_id in enumerate(kw_ids)}
    sem_rank = {doc_id: i for i, doc_id in enumerate(sem_ids)}
    exact = any(p.search(q) for p in _EXACT_TOKEN_RES)
    kw_weight, sem_weight = (1.6, 0.7) if exact else (1.0, 1.0)
    q_lower = q.lower().strip()

    def score(d) -> float:
        s = 0.0
        if d.id in kw_rank:
            s += kw_weight / (RRF_K + kw_rank[d.id] + 1)
        if d.id in sem_rank:
            s += sem_weight / (RRF_K + sem_rank[d.id] + 1)
        if d.id in kw_rank and d.id in sem_rank:
            s *= 1.3  # both channels agree
        if q_lower and (q_lower in (d.title or "").lower() or q_lower in (d.relative_path or "").lower()):
            s *= 1.2  # the whole question is the title / path
        return s

    return sorted(docs, key=score, reverse=True)


async def hybrid_rank(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None, k: int = TOP_K,
) -> tuple[list[Document], list[uuid.UUID], list[uuid.UUID], dict]:
    """Documents for `q`, best first, plus each channel's own order (keyword, semantic)
    and the semantically matched snippets. The retrieval evaluation scores exactly this."""
    import hashlib
    from .cache import cache_get, cache_set
    from ..services.tokenize import tokenize_for_query_any

    clean_q = q.strip()
    # k is in the key: each channel fetches k rows, so Ask (6) and the evaluation (10) rank different pools.
    cache_key = f"hybrid_rank:{user.id}:{tool or 'all'}:{days or 'all'}:{k}:{hashlib.sha256(clean_q.lower().encode('utf-8')).hexdigest()[:16]}"
    cached_payload = await cache_get(cache_key)
    if cached_payload and isinstance(cached_payload, dict):
        try:
            doc_ids = [uuid.UUID(uid) for uid in cached_payload.get("doc_ids", [])]
            kw_order = [uuid.UUID(uid) for uid in cached_payload.get("kw_order", [])]
            sem_order = [uuid.UUID(uid) for uid in cached_payload.get("sem_order", [])]
            sem_snippets = {uuid.UUID(k): v for k, v in cached_payload.get("sem_snippets", {}).items()}
            if doc_ids:
                reloaded_docs = (await db.execute(
                    select(Document).options(
                        defer(Document.content_tsv),
                        defer(Document.rendered_html),
                    ).where(Document.id.in_(doc_ids))
                )).scalars().all()
                doc_map = {d.id: d for d in reloaded_docs}
                sorted_docs = [doc_map[did] for did in doc_ids if did in doc_map]
                if len(sorted_docs) == len(doc_ids):
                    return sorted_docs[:k], kw_order, sem_order, sem_snippets
        except Exception:
            pass

    mids = await user_machine_ids(db, user)
    # Questions are natural language: any content word may match, best matches first.
    # (All-words-must-match with newest-first order returned nothing useful for real
    # questions; see the retrieval evaluation.)
    tsquery = tokenize_for_query_any(q)
    term = f"%{q}%"

    conds = [Document.title.ilike(term), Document.relative_path.ilike(term)]
    rank = None
    if tsquery:
        ts = func.to_tsquery("simple", tsquery)
        conds.append(Document.content_tsv.op("@@")(ts))
        rank = func.ts_rank(Document.content_tsv, ts, 1)

    kw_q = select(Document).options(
        defer(Document.content_tsv),
        defer(Document.rendered_html),
    ).where(or_(*conds))
    if tool:
        kw_q = kw_q.where(Document.tool_id == tool)
    if days:
        from datetime import datetime, timedelta, timezone

        kw_q = kw_q.where(
            Document.synced_at >= datetime.now(timezone.utc) - timedelta(days=days)
        )
    kw_q = apply_user_filter(kw_q, mids, Document.machine_id)
    order = (rank.desc(), Document.synced_at.desc()) if rank is not None else (Document.synced_at.desc(),)

    async def _fetch_kw():
        async with async_session_factory() as kw_db:
            return (await kw_db.execute(kw_q.order_by(*order).limit(k))).scalars().all()

    async def _fetch_sem():
        async with async_session_factory() as sem_db:
            return await _semantic_doc_ranks(sem_db, q, mids, tool, None, days, want=k)

    (sem_res, kw_docs) = await asyncio.gather(_fetch_sem(), _fetch_kw())
    sem_order, sem_snippets = sem_res[0], sem_res[1]

    kw_ids = [d.id for d in kw_docs]

    docs = list(kw_docs)
    missing = [doc_id for doc_id in sem_order if doc_id not in kw_ids]
    if missing:
        extra_q = select(Document).options(
            defer(Document.content_tsv),
            defer(Document.rendered_html),
        ).where(Document.id.in_(missing))
        extra_q = apply_user_filter(extra_q, mids, Document.machine_id)
        docs += list((await db.execute(extra_q)).scalars().all())

    docs = fuse_ranks(docs, kw_ids, list(sem_order), q)
    try:
        await cache_set(cache_key, {
            "doc_ids": [str(d.id) for d in docs],
            "kw_order": [str(d.id) for d in kw_docs],
            "sem_order": [str(did) for did in sem_order],
            "sem_snippets": {str(k): v for k, v in sem_snippets.items()},
        }, ttl_seconds=60)
    except Exception:
        pass
    return docs[:k], kw_ids, list(sem_order), sem_snippets


def clean_conversation_excerpt(text: str, tool_id: str | None = None) -> str:
    """Transform raw conversation chunks/JSONL into human-readable dialogue excerpts."""
    if not text:
        return ""

    from ..services.conversation_parser import _iter_json_objects, parse_conversation_line

    cleaned_parts: list[str] = []
    has_json = "{" in text and "}" in text
    if has_json:
        for raw_obj_str in _iter_json_objects(text):
            raw_obj_str = raw_obj_str.strip()
            if not raw_obj_str:
                continue
            norm = parse_conversation_line(raw_obj_str, tool_id or "antigravity")
            if not norm and tool_id != "codex":
                norm = parse_conversation_line(raw_obj_str, "codex")
            if not norm and tool_id != "claude_code":
                norm = parse_conversation_line(raw_obj_str, "claude_code")

            if norm and norm.role in ("user", "assistant"):
                role_label = "用户" if norm.role == "user" else "助手"
                clean_body = norm.content.strip()
                clean_body = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"\1", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<system-reminder>.*?</system-reminder>", "", clean_body, flags=re.DOTALL)
                clean_body = re.sub(r"<ide_opened_file>.*?</ide_opened_file>", "", clean_body, flags=re.DOTALL)
                clean_body = clean_body.strip()
                if clean_body and clean_body != "[Request interrupted by user]":
                    cleaned_parts.append(f"{role_label}: {clean_body}")
            elif norm and norm.role == "tool" and norm.tool_name:
                cleaned_parts.append(f"[调用工具: {norm.tool_name}]")

    if cleaned_parts:
        return "\n\n".join(cleaned_parts)

    plain = text.strip()
    plain = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"用户: \1", plain, flags=re.DOTALL)
    plain = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<USER_SETTINGS_CHANGE>.*?</USER_SETTINGS_CHANGE>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<system-reminder>.*?</system-reminder>", "", plain, flags=re.DOTALL)
    plain = re.sub(r"<ide_opened_file>.*?</ide_opened_file>", "", plain, flags=re.DOTALL)

    if plain.startswith(("{", "{\"timestamp\"", "{\"type\"", "{\"ordinal\"")):
        return ""
    return plain.strip()


async def retrieve(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None
) -> list[dict]:
    """Hybrid retrieval — the same keyword+vector RRF fusion as /api/search."""
    from ..services.ingest_service import _is_junk_or_uuid_title
    from ..db.models import ConversationMessage

    docs, _, _, sem_snippets = await hybrid_rank(db, user, q, tool, days)

    # Batch preload top conversation messages for conversation documents
    conv_doc_ids = [d.id for d in docs[:TOP_K] if d.category == "conversation"]
    cached_msgs: dict[uuid.UUID, list[tuple[str, str]]] = {}
    if conv_doc_ids:
        try:
            subq = (
                select(
                    ConversationMessage.document_id,
                    ConversationMessage.role,
                    ConversationMessage.content,
                    func.row_number()
                    .over(
                        partition_by=ConversationMessage.document_id,
                        order_by=ConversationMessage.line_number,
                    )
                    .label("rn"),
                )
                .where(ConversationMessage.document_id.in_(conv_doc_ids))
                .where(ConversationMessage.role.in_(("user", "assistant")))
            ).subquery()

            msg_rows = (await db.execute(
                select(subq.c.document_id, subq.c.role, subq.c.content)
                .where(subq.c.rn <= 4)
                .order_by(subq.c.document_id, subq.c.rn)
            )).all()
            for doc_id, role, content in msg_rows:
                if doc_id not in cached_msgs:
                    cached_msgs[doc_id] = []
                if len(cached_msgs[doc_id]) < 4 and content and content.strip():
                    cached_msgs[doc_id].append((role, content.strip()))
        except Exception as e:
            logger.warning("Failed to preload conversation messages: %s", e)

    sources = []
    for d in docs[:TOP_K]:
        raw_text = sem_snippets.get(d.id) or ""
        clean_text = ""
        if d.category == "conversation":
            if raw_text:
                clean_text = clean_conversation_excerpt(raw_text, d.tool_id)
            if not clean_text and d.id in cached_msgs and cached_msgs[d.id]:
                clean_text = "\n\n".join(
                    f"{'用户' if r == 'user' else '助手'}: {c}"
                    for r, c in cached_msgs[d.id]
                )
            if not clean_text and d.content:
                clean_text = clean_conversation_excerpt(d.content[:3000], d.tool_id)
        else:
            clean_text = raw_text or (d.content or "")[:CHARS_PER_DOC]
            clean_text = re.sub(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", r"\1", clean_text, flags=re.DOTALL)
            clean_text = re.sub(r"<ADDITIONAL_METADATA>.*?</ADDITIONAL_METADATA>", "", clean_text, flags=re.DOTALL)

        if not clean_text:
            clean_text = "(无文字摘要)"

        # Fix display title if title is junk like "[Request interrupted by user]"
        display_title = d.title or (d.relative_path or "").split("/")[-1]
        if _is_junk_or_uuid_title(display_title):
            if d.id in cached_msgs and cached_msgs[d.id]:
                for r, c in cached_msgs[d.id]:
                    if r == "user" and c:
                        cand_title = c.split("\n")[0][:50].strip()
                        if not _is_junk_or_uuid_title(cand_title):
                            display_title = cand_title
                            break

        sources.append({
            "id": str(d.id),
            "title": display_title,
            "relative_path": d.relative_path,
            "tool_id": d.tool_id,
            "category": d.category,
            "synced_at": d.synced_at.isoformat() if d.synced_at else None,
            "excerpt": clean_text[:CHARS_PER_DOC],
        })
    return sources


def compute_ebbinghaus_memory_score(
    cosine_sim: float,
    last_recalled_at: datetime | None,
    recall_count: int,
    created_at: datetime | None = None,
    lambda_decay: float = 0.05,
    now: datetime | None = None,
) -> float:
    """Calculate Ebbinghaus retention / recall score for a memory:
    Score = CosineSimilarity * exp(-lambda * delta_days) * log(2 + recall_count)
    """
    sim = max(0.0, float(cosine_sim))
    now = now or datetime.now(timezone.utc)
    ref_time = last_recalled_at or created_at
    if ref_time:
        if ref_time.tzinfo is None:
            ref_time = ref_time.replace(tzinfo=timezone.utc)
        delta_days = max(0.0, (now - ref_time).total_seconds() / 86400.0)
    else:
        delta_days = 0.0

    decay = math.exp(-lambda_decay * delta_days)
    reinforce = math.log(2.0 + max(0, int(recall_count or 0)))
    return sim * decay * reinforce


def _to_float_vector(raw: Any) -> list[float] | None:
    """Normalize raw vector representation (pgvector Vector, list, numpy array or json string) to list[float]."""
    if raw is None:
        return None
    if isinstance(raw, (list, tuple)):
        return [float(x) for x in raw]
    if hasattr(raw, "tolist"):
        return [float(x) for x in raw.tolist()]
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith("[") and s.endswith("]"):
            try:
                import json
                return [float(x) for x in json.loads(s)]
            except Exception:
                pass
    return None


def _vector_cosine_similarity(v1: list[float], v2: list[float]) -> float:
    """Cosine similarity between two numeric vectors in [0.0, 1.0]."""
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    dot = 0.0
    norm1 = 0.0
    norm2 = 0.0
    for a, b in zip(v1, v2):
        dot += a * b
        norm1 += a * a
        norm2 += b * b
    if norm1 > 0 and norm2 > 0:
        return dot / (math.sqrt(norm1) * math.sqrt(norm2))
    return 0.0


async def retrieve_core_memories(
    db: AsyncSession,
    user: User,
    question: str,
    project_id: str | None = None,
    cwd: str | None = None,
    session_id: str | None = None,
    limit: int = 12,
) -> list[UserMemory]:
    """Retrieve high-signal core memories (L3) with project-scoped prioritization.

    Prevents cross-project memory contamination (e.g. 30+ projects) by:
    1. Always including global rules and user preferences (rule, preference, general).
    2. Pinpointing project-specific memories (matching active project slug/path).
    3. Fusing vector semantic similarity recall with Ebbinghaus time decay:
       Score = CosineSimilarity * exp(-lambda * delta_days) * log(2 + recall_count)
       with resilient fallback to keyword substring matching if vector provider is offline.
    """
    proj_slug: str | None = None

    # A. Resolve active project identifier
    if project_id:
        try:
            p_uuid = uuid.UUID(project_id)
            async with _safe_begin_nested(db):
                p_obj = (await db.execute(select(Project).where(Project.id == p_uuid))).scalar_one_or_none()
            if p_obj:
                proj_slug = p_obj.slug
        except (ValueError, TypeError):
            proj_slug = project_id.strip()
        except Exception as e:
            logger.debug("Failed to resolve project_id %s in retrieve_core_memories: %s", project_id, e)

    if not proj_slug and cwd:
        clean_cwd = cwd.strip().rstrip("/\\")
        bname = os.path.basename(clean_cwd)
        if bname:
            try:
                async with _safe_begin_nested(db):
                    p_obj = (await db.execute(
                        select(Project).where(or_(Project.slug == bname, Project.source_path.ilike(f"%{bname}%"))).limit(1)
                    )).scalar_one_or_none()
                if p_obj:
                    proj_slug = p_obj.slug
                else:
                    proj_slug = bname
            except Exception as e:
                logger.debug("Failed to resolve cwd %s in retrieve_core_memories: %s", cwd, e)
                proj_slug = bname

    # 1. Obtain question embedding if query provided
    qvec: list[float] | None = None
    clean_q = (question or "").strip()
    if clean_q:
        try:
            from .embedding_service import _call_embedding_server
            embeds = await _call_embedding_server([clean_q], timeout=5.0)
            if embeds and embeds[0]:
                qvec = embeds[0]
        except Exception as e:
            logger.debug("Failed to obtain question embedding for core memories: %s", e)

    # 2. Query active candidate memories for user
    candidates: list[UserMemory] = []
    seen_ids: set[uuid.UUID] = set()

    # A. HNSW Vector ANN search on UserMemory via idx_user_memories_embedding_hnsw
    if qvec is not None:
        try:
            async with _safe_begin_nested(db):
                vec_q = (
                    select(UserMemory)
                    .where(
                        UserMemory.user_id == user.id,
                        UserMemory.is_folder.is_(False),
                        UserMemory.status == "active",
                        UserMemory.embedding.is_not(None),
                    )
                    .order_by(UserMemory.embedding.cosine_distance(qvec).asc())
                    .limit(60)
                )
                for vm in (await db.execute(vec_q)).scalars().all():
                    if vm.id not in seen_ids:
                        candidates.append(vm)
                        seen_ids.add(vm.id)
        except Exception as e:
            logger.debug("HNSW vector candidate query on UserMemory fallback: %s", e)

    # B. High-priority iron rules, pitfalls and recent candidate memories
    cand_q = (
        select(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            UserMemory.is_folder.is_(False),
            UserMemory.status == "active",
        )
        .order_by(
            case(
                (UserMemory.category.in_(["iron_rule", "rule", "pitfall"]), 1),
                else_=2,
            ),
            UserMemory.confidence.desc(),
            UserMemory.updated_at.desc(),
        )
        .limit(160)
    )
    for rm in (await db.execute(cand_q)).scalars().all():
        if rm.id not in seen_ids:
            candidates.append(rm)
            seen_ids.add(rm.id)

    # 3. Score all candidate memories via Vector Semantic Cosine Similarity + Ebbinghaus Decay + Project & Rules Boost
    scored_candidates: list[tuple[float, UserMemory]] = []
    processed_ids: set[uuid.UUID] = set()
    now_utc = datetime.now(timezone.utc)
    tokens = [t.strip().lower() for t in re.split(r"[\s,;，；]+", clean_q) if len(t.strip()) >= 2] if clean_q else []
    slug_clean = proj_slug.lower() if proj_slug else None

    for m in candidates:
        if m.id in processed_ids or m.is_folder or not (m.content or "").strip():
            continue
        processed_ids.add(m.id)

        # Check project affinity
        is_project_match = False
        if slug_clean:
            is_project_match = (
                slug_clean in (m.tree_path or "").lower()
                or slug_clean in (m.key or "").lower()
                or m.category == "architecture"
            )

        # Calculate semantic cosine similarity
        mem_vec = _to_float_vector(getattr(m, "embedding", None))
        if qvec and mem_vec:
            sim = _vector_cosine_similarity(qvec, mem_vec)
        elif clean_q and tokens:
            overlap = sum(1 for tok in tokens if tok in (m.content or "").lower() or tok in (m.key or "").lower())
            sim = min(1.0, 0.35 + 0.25 * overlap) if overlap > 0 else 0.0
        else:
            sim = 0.5 if not clean_q else 0.0

        # Ebbinghaus retention score: Score = CosineSimilarity * exp(-lambda * delta_days) * log(2 + recall_count)
        ebbinghaus = compute_ebbinghaus_memory_score(
            cosine_sim=sim,
            last_recalled_at=m.last_recalled_at,
            recall_count=m.recall_count,
            created_at=m.created_at,
            lambda_decay=0.05,
            now=now_utc,
        )

        confidence = getattr(m, "confidence", 1.0)
        score = ebbinghaus * confidence

        # If zero or negative direct similarity, provide baseline priority so essential
        # rules and project constraints are retained if the quota has room
        if score <= 0.0:
            if m.category in ("iron_rule", "rule", "pitfall"):
                score = 0.15 * confidence
            elif is_project_match:
                score = 0.12 * confidence
            elif m.category in ("preference", "general"):
                score = 0.05 * confidence
            else:
                score = 0.01

        # Project affinity boost
        if is_project_match:
            score *= 1.4

        # Rules / guidelines defense boost
        if m.category in ("iron_rule", "rule", "pitfall"):
            score *= 1.25

        scored_candidates.append((score, m))

    scored_candidates.sort(key=lambda x: x[0], reverse=True)
    chosen = [m for _, m in scored_candidates[:limit]]
    await touch_recalled(m.id for m in chosen)
    return chosen
