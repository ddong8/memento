"""Learning: corrections to confirm, rules/pitfalls to check before acting, session reviews, retrieval evals."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import CorrectionEvent, CorrectionTopic, Document, SessionReview, User
from ..db.session import async_session_factory, get_db
from ..middleware.auth import get_current_user
from ..services.cache import cache_delete_prefix, cache_get, cache_set
from ..services.correction_service import ProfileFull, accept_topic, correction_stats, topic_out
from ..services import jobs
from ..services.eval_service import build_set, eval_summary, run_eval, run_out
from ..services.guidance_service import guidance_for, render_guidance
from ..services.memory_lifecycle import reconcile, reconcile_in_background
from ..services.retrospective_service import learn_from_tasks, review_sessions, review_stats, save_pitfall
from ..services.notify_service import spawn
from ..services.profile_service import PROFILE_MAX_CHARS, SCOPED_MAX_CHARS

router = APIRouter(prefix="/api/learning", tags=["learning"])


class AcceptBody(BaseModel):
    statement: str | None = None  # the user's edit; None keeps what was learned
    general: bool = False  # widen a project / device rule to apply everywhere


async def _own_topic(db: AsyncSession, user: User, topic_id: str) -> CorrectionTopic:
    try:
        tid = uuid.UUID(topic_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found")
    topic = await db.get(CorrectionTopic, tid)
    if topic is None or topic.user_id != user.id:
        raise HTTPException(status_code=404, detail="not found")
    return topic


@router.get("/corrections")
async def list_corrections(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    cache_key = f"learning:corrections:{user.id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    pending = (await db.execute(
        select(CorrectionTopic)
        .where(CorrectionTopic.user_id == user.id, CorrectionTopic.status == "pending")
        .order_by(CorrectionTopic.times.desc(), CorrectionTopic.last_at.desc())
        .limit(30)
    )).scalars().all()
    topic_ids = [t.id for t in pending]
    quotes_by_topic: dict[uuid.UUID, list] = {}
    if topic_ids:
        # Window function row_number partitions by topic_id and takes top 3 directly in DB
        subq = (
            select(
                CorrectionEvent.topic_id,
                CorrectionEvent.quote,
                CorrectionEvent.said_at,
                func.row_number()
                .over(
                    partition_by=CorrectionEvent.topic_id,
                    order_by=CorrectionEvent.said_at.desc(),
                )
                .label("rn"),
            ).where(CorrectionEvent.topic_id.in_(topic_ids))
        ).subquery()
        event_rows = (await db.execute(
            select(subq.c.topic_id, subq.c.quote, subq.c.said_at).where(subq.c.rn <= 3)
        )).all()
        for tid, quote, said_at in event_rows:
            quotes_by_topic.setdefault(tid, []).append(
                type("EventQuote", (), {"quote": quote, "said_at": said_at})()
            )

    out = [topic_out(topic, quotes_by_topic.get(topic.id, [])) for topic in pending]
    payload = {"pending": out, "stats": await correction_stats(db, user)}
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


@router.post("/corrections/{topic_id}/accept")
async def accept(
    topic_id: str,
    body: AcceptBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    topic = await _own_topic(db, user, topic_id)
    try:
        topic = await accept_topic(db, user, topic, body.statement, general=body.general)
    except ProfileFull:
        raise HTTPException(
            status_code=409,
            detail=f"常驻画像这一部分已接近上限（通用 {PROFILE_MAX_CHARS} 字、每个项目或设备 {SCOPED_MAX_CHARS} 字），先删减一些再采纳。",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if topic.memory_id:
        # An accepted rule may replace an older one; drop that from memory and the profile now.
        spawn(reconcile_in_background(user.id, topic.memory_id))

    await cache_delete_prefix(f"learning:corrections:{user.id}")
    await cache_delete_prefix(f"learning:check:{user.id}")
    return {"topic": topic_out(topic)}


@router.post("/corrections/{topic_id}/dismiss")
async def dismiss(
    topic_id: str,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    topic = await _own_topic(db, user, topic_id)
    topic.status = "dismissed"
    await db.commit()
    await cache_delete_prefix(f"learning:corrections:{user.id}")
    await cache_delete_prefix(f"learning:check:{user.id}")
    return {"topic": topic_out(topic)}


# ---------------------------------------------------------------------------
# Before acting: rules, pitfalls, skills (MCP memory_check_rule and the agent)
# ---------------------------------------------------------------------------

@router.get("/check")
async def check(
    action: str | None = None,
    project: str | None = None,
    query: str | None = None,
    format: str = "json",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    cache_key = f"learning:check:{user.id}:{action or ''}:{project or ''}:{query or ''}:{format}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    g = await guidance_for(db, user, action, project, query)
    res = {"markdown": render_guidance(g)} if format == "markdown" else g
    await cache_set(cache_key, res, ttl_seconds=30)
    return res


# ---------------------------------------------------------------------------
# Session reviews
# ---------------------------------------------------------------------------

async def _review_now(user_id: uuid.UUID) -> dict:
    async with async_session_factory() as db:
        user = await db.get(User, user_id)
        sessions = await review_sessions(db, user)
        try:
            tasks = await learn_from_tasks(db, user)
        except Exception as e:
            tasks = {"error": str(e)[:200]}
        reconciled = await reconcile(db, user, datetime.now(timezone.utc) - timedelta(days=1))
        return {"sessions": sessions, "tasks": tasks, "reconcile": reconciled}


@router.post("/review")
async def review_now(user: User = Depends(get_current_user)) -> dict:
    """Review finished sessions now instead of waiting for the night."""
    uid = user.id
    return await jobs.start("review", uid, lambda: _review_now(uid))


@router.get("/reviews")
async def list_reviews(
    days: int = 14,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    since = datetime.now(timezone.utc) - timedelta(days=max(1, min(days, 90)))
    rows = (await db.execute(
        select(SessionReview, Document.title, Document.tool_id)
        .join(Document, Document.id == SessionReview.document_id)
        .where(SessionReview.user_id == user.id, SessionReview.reviewed_at >= since)
        .order_by(SessionReview.reviewed_at.desc())
        .limit(60)
    )).all()
    return {
        "reviews": [
            {
                "doc_id": str(r.document_id),
                "title": title,
                "tool_id": tool_id,
                "outcome": r.outcome,
                "summary": r.summary,
                "result": r.result or {},
                "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
            }
            for r, title, tool_id in rows
        ],
        "stats": await review_stats(db, user),
        "job": await jobs.status("review", user.id),
    }


# ---------------------------------------------------------------------------
# Retrieval evaluation
# ---------------------------------------------------------------------------

async def _eval_now(user_id: uuid.UUID, rebuild: bool) -> dict:
    async with async_session_factory() as db:
        user = await db.get(User, user_id)
        version = None
        if rebuild:
            version = (await build_set(db, user))["set_version"]
        run = await run_eval(db, user, trigger="manual", set_version=version)
        return run_out(run)


@router.get("/evals")
async def evals(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    return {**await eval_summary(db, user), "job": await jobs.status("eval", user.id)}


@router.post("/evals/run")
async def run_evals(rebuild: bool = False, user: User = Depends(get_current_user)) -> dict:
    """Score retrieval now. rebuild=true first generates a new question set (next version)."""
    uid = user.id
    return await jobs.start("eval", uid, lambda: _eval_now(uid, rebuild))


# ---------------------------------------------------------------------------
# Pitfalls recorded by AI tools (MCP memory_pitfall)
# ---------------------------------------------------------------------------

class PitfallBody(BaseModel):
    title: str
    symptom: str
    fix: str
    cause: str | None = None
    project: str | None = None


@router.post("/pitfalls")
async def add_pitfall(
    body: PitfallBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    mem = await save_pitfall(db, user, body.model_dump(), body.project, "mcp")
    await db.commit()
    if mem is None:
        return {"saved": False, "note": "信息不全、属于 AI 工具自身的限制，或已经记过"}
    return {"saved": True, "id": str(mem.id), "content": mem.content}
