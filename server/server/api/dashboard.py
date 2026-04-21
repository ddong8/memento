"""Dashboard API — aggregated overview for the home page."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select, cast, Date
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ConversationMessage, Document, Machine, Project, Tool, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
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
    mids = await user_machine_ids(db, _user)

    # tz_offset: JS getTimezoneOffset() value (e.g. -480 for UTC+8)
    tz = timezone(timedelta(minutes=-tz_offset))
    now = datetime.now(tz)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    # Tools with stats
    tools_result = await db.execute(select(Tool).order_by(Tool.display_name))
    tools = []
    for t in tools_result.scalars().all():
        cat_query = select(Document.category, func.count()).where(Document.tool_id == t.id)
        cat_query = _apply_device_filter(cat_query, device_id)
        cat_query = apply_user_filter(cat_query, mids, Document.machine_id)
        cat_result = await db.execute(cat_query.group_by(Document.category))
        categories = {r[0]: r[1] for r in cat_result.all()}
        if (device_id or mids is not None) and not categories:
            continue
        # Today's sync count for this tool
        today_q = select(func.count()).where(
            Document.tool_id == t.id, Document.synced_at >= today_start,
        )
        today_q = _apply_device_filter(today_q, device_id)
        today_q = apply_user_filter(today_q, mids, Document.machine_id)
        today_count = (await db.execute(today_q)).scalar() or 0
        # Conversation count for this tool
        conv_q = select(func.count()).where(
            Document.tool_id == t.id, Document.category == "conversation",
        )
        conv_q = _apply_device_filter(conv_q, device_id)
        conv_q = apply_user_filter(conv_q, mids, Document.machine_id)
        conv_count = (await db.execute(conv_q)).scalar() or 0
        tools.append({
            "id": t.id,
            "display_name": t.display_name,
            "total_files": sum(categories.values()) if (device_id or mids is not None) else t.total_files,
            "last_sync_at": t.last_sync_at.isoformat() if t.last_sync_at else None,
            "categories": categories,
            "today_count": today_count,
            "conversation_count": conv_count,
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
    convos_result = await db.execute(recent_convos_q)
    recent_conversations = []
    for r in convos_result.all():
        # Get message count
        msg_count = (await db.execute(
            select(func.count()).where(ConversationMessage.document_id == r.id)
        )).scalar() or 0
        recent_conversations.append({
            "id": str(r.id),
            "tool_id": r.tool_id,
            "title": r.title,
            "synced_at": r.synced_at.isoformat(),
            "project_title": r.project_title,
            "message_count": msg_count,
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

    # Active devices
    devices_q = select(Machine).order_by(Machine.name).limit(10)
    if mids is not None:
        devices_q = devices_q.where(Machine.id.in_(mids))
    devices_result = await db.execute(devices_q)
    devices = []
    for m in devices_result.scalars().all():
        # Count files per device
        dev_count = (await db.execute(
            select(func.count()).where(Document.machine_id == m.id)
        )).scalar() or 0
        devices.append({
            "id": str(m.id),
            "device_id": m.collector_token_hash,
            "name": m.name,
            "last_heartbeat": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "collector_version": m.collector_version,
            "total_files": dev_count,
        })

    # Today's stats
    today_total_q = select(func.count()).where(Document.synced_at >= today_start)
    today_total_q = _apply_device_filter(today_total_q, device_id)
    today_total_q = apply_user_filter(today_total_q, mids, Document.machine_id)
    today_total = (await db.execute(today_total_q)).scalar() or 0

    today_conv_q = select(func.count()).where(
        Document.synced_at >= today_start, Document.category == "conversation",
    )
    today_conv_q = _apply_device_filter(today_conv_q, device_id)
    today_conv_q = apply_user_filter(today_conv_q, mids, Document.machine_id)
    today_conversations = (await db.execute(today_conv_q)).scalar() or 0

    # Total stats
    doc_count_q = select(func.count()).select_from(Document)
    doc_count_q = _apply_device_filter(doc_count_q, device_id)
    doc_count_q = apply_user_filter(doc_count_q, mids, Document.machine_id)
    total_docs = (await db.execute(doc_count_q)).scalar() or 0
    total_projects = (await db.execute(select(func.count()).select_from(Project))).scalar() or 0

    return {
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
