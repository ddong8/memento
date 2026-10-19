"""Dashboard API — aggregated overview for the home page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Machine, Project, Tool, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.cache import cache_get, cache_set
from ..services.user_filter import user_machine_ids, apply_user_filter

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _apply_device_filter(query, device_id: str | None):
    if not device_id:
        return query
    return query.where(Document.machine_id.in_(
        select(Machine.id).where(Machine.collector_token_hash == device_id)
    ))


@router.get("")
async def get_dashboard(
    device_id: str | None = None,
    tz_offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Aggregated dashboard data for home page."""
    cache_key = f"dashboard:{_user.id}:{device_id or 'all'}:{tz_offset}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    mids = await user_machine_ids(db, _user)

    # tz_offset: JS getTimezoneOffset() value (e.g. -480 for UTC+8)
    tz = timezone(timedelta(minutes=-tz_offset))
    now = datetime.now(tz)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Tools with stats — one-shot aggregation instead of 3 COUNT queries per
    # tool. With N tools, this was 3N+1 round-trips; now it's 2 (tool list +
    # single GROUP BY).
    tools_result = await db.execute(select(Tool).order_by(Tool.display_name))
    tool_records = list(tools_result.scalars().all())

    cat_agg_q = select(Document.tool_id, Document.category, func.count().label("n"))
    cat_agg_q = _apply_device_filter(cat_agg_q, device_id)
    cat_agg_q = apply_user_filter(cat_agg_q, mids, Document.machine_id)
    cat_agg_q = cat_agg_q.group_by(Document.tool_id, Document.category)
    categories_by_tool: dict[str, dict[str, int]] = {}
    for tid, cat, n in (await db.execute(cat_agg_q)).all():
        categories_by_tool.setdefault(tid, {})[cat] = n

    today_q = (
        select(Document.tool_id, func.count().label("n"))
        .where(Document.synced_at >= today_start)
    )
    today_q = _apply_device_filter(today_q, device_id)
    today_q = apply_user_filter(today_q, mids, Document.machine_id)
    today_q = today_q.group_by(Document.tool_id)
    today_by_tool: dict[str, int] = {tid: n for tid, n in (await db.execute(today_q)).all()}

    tools = []
    for t in tool_records:
        categories = categories_by_tool.get(t.id, {})
        if (device_id or mids is not None) and not categories:
            continue
        tools.append({
            "id": t.id,
            "display_name": t.display_name,
            "total_files": sum(categories.values()) if (device_id or mids is not None) else t.total_files,
            "last_sync_at": t.last_sync_at.isoformat() if t.last_sync_at else None,
            "categories": categories,
            "today_count": today_by_tool.get(t.id, 0),
            "conversation_count": categories.get("conversation", 0),
        })

    # Recent conversations (last 10 across all tools)
    recent_convos_q = (
        select(Document.id, Document.tool_id, Document.title,
               Document.synced_at, Document.project_id, Document.file_size_bytes,
               Project.title.label("project_title"))
        .outerjoin(Project, Document.project_id == Project.id)
        .where(Document.category == "conversation")
        .order_by(Document.synced_at.desc())
        .limit(10)
    )
    recent_convos_q = _apply_device_filter(recent_convos_q, device_id)
    recent_convos_q = apply_user_filter(recent_convos_q, mids, Document.machine_id)
    convos_rows = list((await db.execute(recent_convos_q)).all())

    # Batch message counts for these 10 docs in one GROUP BY instead of one
    # COUNT per iteration (N+1 → 1 round-trip).
    msg_counts: dict = {}
    if convos_rows:
        msg_count_q = (
            select(ConversationMessage.document_id, func.count())
            .where(ConversationMessage.document_id.in_([r.id for r in convos_rows]))
            .group_by(ConversationMessage.document_id)
        )
        msg_counts = {did: n for did, n in (await db.execute(msg_count_q)).all()}

    recent_conversations = []
    for r in convos_rows:
        recent_conversations.append({
            "id": str(r.id),
            "tool_id": r.tool_id,
            "title": r.title,
            "synced_at": r.synced_at.isoformat(),
            "project_title": r.project_title,
            "message_count": msg_counts.get(r.id, 0),
        })

    # Recent activity (last 7 days by date, timezone-adjusted)
    cutoff = now - timedelta(days=7)
    tz_adjusted_synced = Document.synced_at + timedelta(minutes=-tz_offset)
    daily_q = (
        select(cast(tz_adjusted_synced, Date).label("day"), func.count().label("count"))
        .where(Document.synced_at >= cutoff)
    )
    daily_q = _apply_device_filter(daily_q, device_id)
    daily_q = apply_user_filter(daily_q, mids, Document.machine_id)
    daily_result = await db.execute(daily_q.group_by("day").order_by("day"))
    daily = [{"date": str(r.day), "count": r.count} for r in daily_result.all()]

    # Activity by tool (last 7 days)
    tool_daily_q = (
        select(Document.tool_id,
               cast(tz_adjusted_synced, Date).label("day"),
               func.count().label("count"))
        .where(Document.synced_at >= cutoff)
    )
    tool_daily_q = _apply_device_filter(tool_daily_q, device_id)
    tool_daily_q = apply_user_filter(tool_daily_q, mids, Document.machine_id)
    tool_daily_result = await db.execute(
        tool_daily_q.group_by(Document.tool_id, "day").order_by("day")
    )
    tool_daily: dict[str, list] = {}
    for r in tool_daily_result.all():
        tool_daily.setdefault(r.tool_id, []).append({"date": str(r.day), "count": r.count})

    # Active devices — batch per-device document counts in a single GROUP BY
    # instead of N+1.
    devices_q = select(Machine).where(Machine.merged_into.is_(None), Machine.is_archived.is_(False)).order_by(Machine.name).limit(10)
    if mids is not None:
        devices_q = devices_q.where(Machine.id.in_(mids))
    machine_rows = list((await db.execute(devices_q)).scalars().all())

    dev_counts: dict = {}
    if machine_rows:
        dev_count_q = (
            select(Document.machine_id, func.count())
            .where(Document.machine_id.in_([m.id for m in machine_rows]))
            .group_by(Document.machine_id)
        )
        dev_counts = {mid: n for mid, n in (await db.execute(dev_count_q)).all()}

    devices = []
    for m in machine_rows:
        devices.append({
            "id": str(m.id),
            "device_id": m.collector_token_hash,
            "name": m.name,
            "last_heartbeat": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "collector_version": m.collector_version,
            "total_files": dev_counts.get(m.id, 0),
        })

    # Today's stats — single conditional aggregation query instead of 2 count round-trips
    today_agg_q = (
        select(
            func.count().label("total"),
            func.count().filter(Document.category == "conversation").label("conversations"),
        )
        .where(Document.synced_at >= today_start)
    )
    today_agg_q = _apply_device_filter(today_agg_q, device_id)
    today_agg_q = apply_user_filter(today_agg_q, mids, Document.machine_id)
    today_row = (await db.execute(today_agg_q)).one()
    today_total = today_row.total or 0
    today_conversations = today_row.conversations or 0

    # Total stats — single aggregation query combining total docs and unique projects
    total_agg_q = (
        select(
            func.count().label("total_docs"),
            func.count(func.distinct(Document.project_id)).label("total_projects"),
        )
    )
    total_agg_q = _apply_device_filter(total_agg_q, device_id)
    total_agg_q = apply_user_filter(total_agg_q, mids, Document.machine_id)
    total_row = (await db.execute(total_agg_q)).one()
    total_docs = total_row.total_docs or 0
    total_projects = total_row.total_projects or 0

    payload = {
        "tools": tools,
        "recent_conversations": recent_conversations,
        "daily": daily,
        "tool_daily": tool_daily,
        "devices": devices,
        "stats": {
            "total_documents": total_docs,
            "total_projects": total_projects,
            "total_tools": len(tools),
            "total_devices": len(devices),
            "today_total": today_total,
            "today_conversations": today_conversations,
        },
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload
