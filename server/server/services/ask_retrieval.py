"""Retrieval for /api/ask: hybrid keyword + vector ranking over the user's
documents, and the core memories recalled alongside them.
"""

from __future__ import annotations

import logging
import os
import re
import uuid


from sqlalchemy import or_, select, func
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, User, UserMemory, Project
from ..db.session import async_session_factory
from ..services.user_filter import user_machine_ids, apply_user_filter
from ..services.memory_lifecycle import touch_recalled
from ..api.search import _semantic_doc_ranks, RRF_K

logger = logging.getLogger("server.ask")

# How many documents to ground the answer in. Above ~8 the prompt gets long
# enough that recall degrades (lost-in-the-middle) for no accuracy gain.
TOP_K = 6
# Per-document context budget. 6 x 1500 ~= 9k chars, comfortably inside a
# 32k-token context alongside the conversation history.
CHARS_PER_DOC = 1500


async def hybrid_rank(
    db: AsyncSession, user: User, q: str, tool: str | None, days: int | None, k: int = TOP_K,
) -> tuple[list[Document], list[uuid.UUID], list[uuid.UUID], dict]:
    """Documents for `q`, best first, plus each channel's own order (keyword, semantic)
    and the semantically matched snippets. The retrieval evaluation scores exactly this."""
    from ..services.tokenize import tokenize_for_query_any

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

    sem_res = await _fetch_sem()
    if len(sem_res) == 3:
        sem_order, sem_snippets, sem_sims = sem_res
    else:
        sem_order, sem_snippets = sem_res
        sem_sims = {}

    kw_docs = await _fetch_kw()

    kw_rank = {d.id: i for i, d in enumerate(kw_docs)}
    sem_rank = {doc_id: i for i, doc_id in enumerate(sem_order)}

    docs = list(kw_docs)
    missing = [doc_id for doc_id in sem_order if doc_id not in kw_rank]
    if missing:
        extra_q = select(Document).options(
            defer(Document.content_tsv),
            defer(Document.rendered_html),
        ).where(Document.id.in_(missing))
        extra_q = apply_user_filter(extra_q, mids, Document.machine_id)
        docs += list((await db.execute(extra_q)).scalars().all())

    q_lower = q.lower().strip()

    def rrf(d) -> float:
        score = 0.0
        in_kw = d.id in kw_rank
        in_sem = d.id in sem_rank
        if in_kw:
            score += 1.0 / (RRF_K + kw_rank[d.id] + 1)
        if in_sem:
            score += 1.0 / (RRF_K + sem_rank[d.id] + 1)
        # Dual-hit synergy bonus: strongly preferred when both channels agree
        if in_kw and in_sem:
            score *= 1.3
        # Direct semantic similarity weighting
        sim = sem_sims.get(d.id, 0.0)
        if sim > 0:
            score += sim * 0.025
        # Exact title / path relevance boost
        title_lower = (d.title or "").lower()
        path_lower = (d.relative_path or "").lower()
        if q_lower and (q_lower in title_lower or q_lower in path_lower):
            score *= 1.2
        return score

    docs.sort(key=rrf, reverse=True)
    return docs[:k], [d.id for d in kw_docs], list(sem_order), sem_snippets


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
    3. Fusing keyword matching against UserMemory content for the current question.
    """
    proj_slug: str | None = None

    # A. Resolve active project identifier
    if project_id:
        try:
            p_uuid = uuid.UUID(project_id)
            p_obj = (await db.execute(select(Project).where(Project.id == p_uuid))).scalar_one_or_none()
            if p_obj:
                proj_slug = p_obj.slug
        except (ValueError, TypeError):
            proj_slug = project_id.strip()

    if not proj_slug and cwd:
        clean_cwd = cwd.strip().rstrip("/\\")
        bname = os.path.basename(clean_cwd)
        if bname:
            p_obj = (await db.execute(
                select(Project).where(or_(Project.slug == bname, Project.source_path.ilike(f"%{bname}%"))).limit(1)
            )).scalar_one_or_none()
            if p_obj:
                proj_slug = p_obj.slug
            else:
                proj_slug = bname

    collected: list[UserMemory] = []
    seen_ids: set[uuid.UUID] = set()

    def _add_mem(mem: UserMemory):
        if mem.id not in seen_ids and not mem.is_folder and (mem.content or "").strip():
            seen_ids.add(mem.id)
            collected.append(mem)

    # 1. Active project-scoped memories (Top priority)
    if proj_slug:
        slug_clean = proj_slug.lower()
        proj_q = (
            select(UserMemory)
            .where(
                UserMemory.user_id == user.id,
                UserMemory.is_folder.is_(False),
                UserMemory.status == "active",
                or_(
                    UserMemory.tree_path.ilike(f"%{slug_clean}%"),
                    UserMemory.key.ilike(f"%{slug_clean}%"),
                    UserMemory.category == "architecture",
                ),
            )
            .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
            .limit(6)
        )
        for m in (await db.execute(proj_q)).scalars().all():
            _add_mem(m)

    # 2. Global rules, guidelines & developer preferences (Always preserved)
    rules_q = (
        select(UserMemory)
        .where(
            UserMemory.user_id == user.id,
            UserMemory.is_folder.is_(False),
            UserMemory.status == "active",
            UserMemory.category.in_(["rule", "rules", "preference", "general"]),
        )
        .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
        .limit(6)
    )
    for m in (await db.execute(rules_q)).scalars().all():
        _add_mem(m)

    # 3. Keyword matching against user memory content for the current question
    tokens = [t.strip() for t in re.split(r"[\s,;，；]+", question) if len(t.strip()) >= 2]
    if tokens:
        kw_conds = [UserMemory.content.ilike(f"%{tok[:20]}%") for tok in tokens[:4]]
        if kw_conds:
            kw_q = (
                select(UserMemory)
                .where(
                    UserMemory.user_id == user.id,
                    UserMemory.is_folder.is_(False),
                    UserMemory.status == "active",
                    or_(*kw_conds),
                )
                .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
                .limit(4)
            )
            for m in (await db.execute(kw_q)).scalars().all():
                _add_mem(m)

    # 4. Fill remaining budget with highest confidence general memories if needed
    if len(collected) < limit:
        remain = limit - len(collected)
        fill_q = (
            select(UserMemory)
            .where(
                UserMemory.user_id == user.id,
                UserMemory.is_folder.is_(False),
                UserMemory.status == "active",
            )
            .order_by(UserMemory.confidence.desc(), UserMemory.updated_at.desc())
            .limit(remain + 5)
        )
        for m in (await db.execute(fill_q)).scalars().all():
            if len(collected) >= limit:
                break
            _add_mem(m)

    chosen = collected[:limit]
    await touch_recalled(m.id for m in chosen)
    return chosen
