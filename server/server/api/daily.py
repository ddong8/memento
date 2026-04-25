"""Daily API — browse daily activity and AI summaries."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, cast, Date
from sqlalchemy.dialects.postgresql import array_agg
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, DailySummary, Document, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids

router = APIRouter(prefix="/api/daily", tags=["daily"])


def _user_tz(tz_offset: int) -> timezone:
    """Convert minutes offset (e.g. -480 for UTC+8) to timezone."""
    # JS getTimezoneOffset() returns -480 for UTC+8, so negate it
    return timezone(timedelta(minutes=-tz_offset))


@router.get("")
async def list_daily_dates(
    days: int = Query(365, ge=1, le=3650),
    tz_offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """List dates with conversation activity in the last N days."""
    from ..services.cache import cache_get, cache_set
    # Cache by (user, days, tz). The underlying GROUP BY on
    # conversation_messages does a 33K-row seq scan + 65MB block read on cold
    # cache (2-3s). The answer itself is small and stable across a minute,
    # so even a short TTL hides the cold path for repeat visits / tab loads.
    cache_key = f"daily:dates:{_user.id}:{days}:{tz_offset}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)
    tz = _user_tz(tz_offset)
    cutoff = datetime.now(tz) - timedelta(days=days)

    # Use timezone-adjusted date grouping via SQL interval
    tz_adjusted = ConversationMessage.timestamp + timedelta(minutes=-tz_offset)
    q = (
        select(
            cast(tz_adjusted, Date).label("day"),
            func.count().label("total"),
            array_agg(func.distinct(Document.tool_id)).label("tools"),
        )
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(
            ConversationMessage.timestamp >= cutoff,
            ConversationMessage.timestamp.isnot(None),
            ConversationMessage.role.in_(["user", "assistant"]),
            ~ConversationMessage.content.like("[Result]%"),
            ~ConversationMessage.content.like("[Tool:%"),
            Document.tool_id != "system",
        )
    )
    if mids is not None:
        q = q.where(Document.machine_id.in_(mids))
    q = q.group_by("day").order_by(cast(tz_adjusted, Date).desc())
    result = await db.execute(q)

    payload = [
        {
            "date": str(row.day),
            "document_count": row.total,
            "message_count": row.total,
            "tools": sorted([t for t in (row.tools or []) if t]),
        }
        for row in result.all()
    ]
    # 60s TTL — daily list updates only when ingest writes new messages, so
    # the data lifecycle is "minutes", not seconds. Short enough for users
    # not to notice staleness on a fresh ingest.
    await cache_set(cache_key, payload, ttl_seconds=60)
    return payload


@router.get("/{date_str}")
async def get_daily(
    date_str: str,
    tz_offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get all activity for a specific date — built from conversation_messages table."""
    from ..services.cache import cache_get, cache_set
    cache_key = f"daily:detail:{_user.id}:{date_str}:{tz_offset}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)

    try:
        target_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format, use YYYY-MM-DD")

    tz = _user_tz(tz_offset)
    next_date = target_date + timedelta(days=1)
    day_start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=tz)
    day_end = datetime(next_date.year, next_date.month, next_date.day, tzinfo=tz)

    # Get today's messages grouped by document + role (exclude tool noise + subagents)
    msg_q = (
        select(
            ConversationMessage.document_id,
            ConversationMessage.role,
            func.count().label("cnt"),
        )
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(
            ConversationMessage.timestamp >= day_start,
            ConversationMessage.timestamp < day_end,
            ConversationMessage.role.in_(["user", "assistant"]),
            ~ConversationMessage.content.like("[Result]%"),
            ~ConversationMessage.content.like("[Tool:%"),
            ~Document.relative_path.like("%/subagents/%"),
        )
    )
    if mids is not None:
        msg_q = msg_q.where(Document.machine_id.in_(mids))
    msg_q = msg_q.group_by(ConversationMessage.document_id, ConversationMessage.role)
    msg_result = await db.execute(msg_q)

    conv_map: dict[str, dict] = {}
    for doc_id, role, cnt in msg_result.all():
        key = str(doc_id)
        if key not in conv_map:
            conv_map[key] = {"id": key, "user_messages": 0, "assistant_messages": 0}
        if role == "user":
            conv_map[key]["user_messages"] = cnt
        elif role == "assistant":
            conv_map[key]["assistant_messages"] = cnt

    # Enrich with document info (tool_id, title)
    conversations = []
    tool_stats: dict[str, int] = {}
    if conv_map:
        doc_ids = [uuid.UUID(k) for k in conv_map.keys()]
        doc_info = await db.execute(select(Document).where(Document.id.in_(doc_ids)))
        for d in doc_info.scalars().all():
            info = conv_map.get(str(d.id), {})
            total = info.get("user_messages", 0) + info.get("assistant_messages", 0)
            tool_stats[d.tool_id] = tool_stats.get(d.tool_id, 0) + total
            conversations.append({
                "id": str(d.id),
                "tool_id": d.tool_id,
                "title": d.title or d.relative_path,
                "user_messages": info.get("user_messages", 0),
                "assistant_messages": info.get("assistant_messages", 0),
                "content_type": d.content_type,
            })
        conversations.sort(key=lambda x: x["user_messages"], reverse=True)

    total_messages = sum(c["user_messages"] + c["assistant_messages"] for c in conversations)

    # Get daily summaries — scoped to the current user. admin/owner see all.
    summary_q = select(DailySummary).where(DailySummary.summary_date == target_date)
    if _user.role not in ("admin", "owner"):
        summary_q = summary_q.where(DailySummary.user_id == _user.id)
    summary_result = await db.execute(summary_q)
    summaries = summary_result.scalars().all()

    payload = {
        "date": date_str,
        "total_messages": total_messages,
        "overview": {
            "conversations": conversations,
            "key_changes": [],
            "tool_stats": tool_stats,
        },
        "summaries": [
            {
                "id": str(s.id),
                "tool_id": s.tool_id,
                "title": s.title,
                "summary": s.summary,
                "highlights": s.highlights,
            }
            for s in summaries
        ],
    }
    await cache_set(cache_key, payload, ttl_seconds=60)
    return payload


@router.get("/{date_str}/messages")
async def get_daily_messages(
    date_str: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    tz_offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get all conversation messages for a date, sorted by time."""
    mids = await user_machine_ids(db, _user)

    try:
        target_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    tz = _user_tz(tz_offset)
    next_date = target_date + timedelta(days=1)
    day_start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=tz)
    day_end = datetime(next_date.year, next_date.month, next_date.day, tzinfo=tz)

    # Filter conditions: user/assistant only, exclude tool noise
    msg_filter = [
        ConversationMessage.timestamp >= day_start,
        ConversationMessage.timestamp < day_end,
        ConversationMessage.role.in_(["user", "assistant"]),
        ~ConversationMessage.content.like("[Result]%"),
        ~ConversationMessage.content.like("[Tool:%"),
    ]
    # Exclude Claude Code sub-agent duplicates (they copy parent messages)
    subagent_filter = ~Document.relative_path.like("%/subagents/%")
    # User isolation filter
    user_filter = [Document.machine_id.in_(mids)] if mids is not None else []

    # Count total (needs join for subagent filter)
    count_result = await db.execute(
        select(func.count())
        .select_from(ConversationMessage)
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(*msg_filter, subagent_filter, *user_filter)
    )
    total = count_result.scalar() or 0

    # Get messages with document info
    msg_result = await db.execute(
        select(ConversationMessage, Document.tool_id, Document.title)
        .join(Document, ConversationMessage.document_id == Document.id)
        .where(*msg_filter, subagent_filter, *user_filter)
        .order_by(ConversationMessage.timestamp, ConversationMessage.document_id, ConversationMessage.line_number)
        .offset(offset)
        .limit(limit)
    )

    messages = []
    for cm, tool_id, doc_title in msg_result.all():
        messages.append({
            "role": cm.role,
            "content": cm.content or "",
            "timestamp": cm.timestamp.isoformat() if cm.timestamp else None,
            "tool_id": tool_id,
            "conversation_title": doc_title,
        })

    return {"date": date_str, "total": total, "offset": offset, "limit": limit, "messages": messages}


@router.get("/{date_str}/summary")
async def get_daily_summary(
    date_str: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Get the AI-generated daily summary for a date."""
    try:
        target_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    q = select(DailySummary).where(
        DailySummary.summary_date == target_date,
        DailySummary.tool_id.is_(None),
        DailySummary.user_id == _user.id,
    )
    result = await db.execute(q)
    summary = result.scalar_one_or_none()

    if not summary:
        raise HTTPException(status_code=404, detail="No summary for this date")

    return {
        "date": date_str,
        "title": summary.title,
        "summary": summary.summary,
        "highlights": summary.highlights,
        "created_at": summary.created_at.isoformat(),
    }


@router.post("/{date_str}/generate-summary")
async def generate_daily_summary_endpoint(
    date_str: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Generate (or regenerate) an AI summary for a specific date."""
    from ..services.ai_summary_service import generate_daily_summary_from_digests

    mids = await user_machine_ids(db, _user)

    try:
        target_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    next_date = target_date + timedelta(days=1)
    # Generate summary uses Asia/Shanghai (UTC+8) as default
    tz_cst = timezone(timedelta(hours=8))
    day_start = datetime(target_date.year, target_date.month, target_date.day, tzinfo=tz_cst)
    day_end = datetime(next_date.year, next_date.month, next_date.day, tzinfo=tz_cst)

    # Get messages directly from conversation_messages table (exclude noise)
    gen_q = (
        select(ConversationMessage)
        .where(
            ConversationMessage.timestamp >= day_start,
            ConversationMessage.timestamp < day_end,
            ConversationMessage.role.in_(["user", "assistant"]),
            ~ConversationMessage.content.like("[Result]%"),
            ~ConversationMessage.content.like("[Tool:%"),
        )
    )
    if mids is not None:
        gen_q = gen_q.join(Document, ConversationMessage.document_id == Document.id).where(
            Document.machine_id.in_(mids)
        )
    gen_q = gen_q.order_by(ConversationMessage.timestamp)
    msg_result = await db.execute(gen_q)
    messages = msg_result.scalars().all()

    if not messages:
        raise HTTPException(status_code=404, detail="No conversation messages on this date")

    # Group messages by document, get document info
    from collections import defaultdict
    msgs_by_doc: dict[str, list] = defaultdict(list)
    for m in messages:
        msgs_by_doc[str(m.document_id)].append(m)

    doc_ids = [uuid.UUID(k) for k in msgs_by_doc.keys()]
    doc_info_result = await db.execute(select(Document).where(Document.id.in_(doc_ids)))
    doc_map = {str(d.id): d for d in doc_info_result.scalars().all()}

    # Build conversation data for AI summary — no per-conversation limit
    conv_data = []
    for doc_id, doc_msgs in msgs_by_doc.items():
        d = doc_map.get(doc_id)
        tool_id = d.tool_id if d else "unknown"
        title = (d.title if d else doc_id) or doc_id

        parts = []
        for m in doc_msgs:
            prefix = "👤 用户" if m.role == "user" else "🤖 AI"
            text = m.content[:800] if m.content else ""
            if text:
                parts.append(f"{prefix}: {text}")

        conv_data.append({
            "tool_id": tool_id,
            "title": title,
            "digest": "\n".join(parts),
        })

    summary_text = await generate_daily_summary_from_digests(target_date, conv_data)
    if not summary_text:
        raise HTTPException(status_code=500, detail="AI summary generation failed")

    # Upsert daily summary for this user
    existing = await db.execute(
        select(DailySummary)
        .where(
            DailySummary.summary_date == target_date,
            DailySummary.tool_id.is_(None),
            DailySummary.user_id == _user.id,
        )
    )
    summary = existing.scalar_one_or_none()

    if summary:
        summary.title = f"AI 日报 - {date_str}"
        summary.summary = summary_text
    else:
        summary = DailySummary(
            user_id=_user.id,
            summary_date=target_date,
            tool_id=None,
            title=f"AI 日报 - {date_str}",
            summary=summary_text,
        )
        db.add(summary)

    await db.flush()

    return {
        "date": date_str,
        "title": summary.title,
        "summary": summary_text,
        "status": "generated",
    }
