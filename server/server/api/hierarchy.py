"""Hierarchy API — Device → Tool → Project → Conversation drill-down."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, Project, Tool, User
from ..db.session import get_db
from ..middleware.auth import get_current_user

router = APIRouter(prefix="/api/hierarchy", tags=["hierarchy"])


def _check_machine_access(machine: Machine | None, user: User) -> Machine | None:
    """Return None if user has no access to the machine."""
    if machine is None:
        return None
    if user.role in ("admin", "owner"):
        return machine
    if machine.user_id != user.id:
        return None
    return machine


async def _find_machine(db: AsyncSession, device_id: str) -> Machine | None:
    """Find machine by collector_token_hash OR by primary key UUID (following merged records)."""
    from ..services.device_merge import resolve_merged
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id)
    )
    m = result.scalar_one_or_none()
    if m:
        return await resolve_merged(db, m)
    # Fallback: try as UUID primary key
    try:
        import uuid as _uuid
        uid = _uuid.UUID(device_id)
        result = await db.execute(select(Machine).where(Machine.id == uid))
        return await resolve_merged(db, result.scalar_one_or_none())
    except (ValueError, AttributeError):
        return None


@router.get("/devices")
async def list_devices_with_tools(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Level 1: All devices with tool counts."""
    from ..services.cache import cache_get, cache_set
    cache_key = f"hierarchy:devices:{_user.id}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    machines_q = select(Machine).where(Machine.merged_into.is_(None)).order_by(Machine.name)
    if _user.role not in ("admin", "owner"):
        machines_q = machines_q.where(Machine.user_id == _user.id)
    machines_res = await db.execute(machines_q)
    machines_list = list(machines_res.scalars().all())
    if not machines_list:
        return []

    mids = [m.id for m in machines_list]
    tools_result = await db.execute(
        select(Document.machine_id, Document.tool_id, func.count().label("cnt"))
        .where(Document.machine_id.in_(mids), Document.tool_id != "system")
        .group_by(Document.machine_id, Document.tool_id)
    )
    tool_counts_by_mid: dict[uuid.UUID, dict[str, int]] = {}
    for mid, tid, cnt in tools_result.all():
        tool_counts_by_mid.setdefault(mid, {})[tid] = cnt

    items = []
    for m in machines_list:
        tool_counts = tool_counts_by_mid.get(m.id, {})
        total = sum(tool_counts.values())
        items.append({
            "id": str(m.id),
            "device_id": m.collector_token_hash,
            "name": m.name,
            "last_heartbeat": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "total_files": total,
            "tools": [{"id": tid, "file_count": cnt} for tid, cnt in sorted(tool_counts.items())],
        })
    await cache_set(cache_key, items, ttl_seconds=30)
    return items


@router.get("/devices/{device_id}/tools")
async def list_device_tools(
    device_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Level 2: Tools for a specific device, with category breakdown."""
    m = _check_machine_access(await _find_machine(db, device_id), _user)
    if not m:
        return []

    # Single query with JOIN — no N+1, exclude "system" pseudo-tool
    tools_result = await db.execute(
        select(Document.tool_id, Tool.display_name, Document.category, func.count().label("cnt"))
        .outerjoin(Tool, Document.tool_id == Tool.id)
        .where(Document.machine_id == m.id, Document.tool_id != "system")
        .group_by(Document.tool_id, Tool.display_name, Document.category)
    )

    tool_data: dict[str, dict] = {}
    for tool_id, display_name, category, count in tools_result.all():
        if tool_id not in tool_data:
            tool_data[tool_id] = {
                "id": tool_id,
                "display_name": display_name or tool_id,
                "categories": {},
                "total_files": 0,
            }
        tool_data[tool_id]["categories"][category] = count
        tool_data[tool_id]["total_files"] += count

    return sorted(tool_data.values(), key=lambda t: t["total_files"], reverse=True)


@router.get("/devices/{device_id}/tools/{tool_id}/projects")
async def list_device_tool_projects(
    device_id: str, tool_id: str,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[dict]:
    """Level 3: Projects for a device+tool, with recent file info."""
    m = _check_machine_access(await _find_machine(db, device_id), _user)
    if not m:
        return []

    # Get documents for this device+tool
    rows = list((await db.execute(
        select(Document.project_id, func.count().label("cnt"), func.max(Document.synced_at).label("last"))
        .where(Document.machine_id == m.id, Document.tool_id == tool_id)
        .group_by(Document.project_id)
    )).all())

    # Batch-fetch every referenced project in a single query instead of
    # looping N SELECT-by-id's (one per project).
    project_ids = [pid for pid, _c, _l in rows if pid]
    project_map: dict = {}
    if project_ids:
        proj_rows = await db.execute(
            select(Project.id, Project.title, Project.slug).where(Project.id.in_(project_ids))
        )
        project_map = {pid: (title, slug) for pid, title, slug in proj_rows.all()}

    items = []
    for project_id, count, last_sync in rows:
        if project_id:
            title, slug = project_map.get(project_id, ("Unknown", ""))
        else:
            title = "(No Project)"
            slug = ""
            project_id = "none"

        items.append({
            "id": str(project_id),
            "title": title,
            "slug": slug,
            "file_count": count,
            "last_sync": last_sync.isoformat() if last_sync else None,
        })

    return sorted(items, key=lambda p: p["file_count"], reverse=True)


@router.get("/devices/{device_id}/tools/{tool_id}/files")
async def list_device_tool_files(
    device_id: str, tool_id: str,
    project_id: str | None = None,
    category: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    """Level 4: Files (conversations/docs) for a device+tool, with optional project/category filter."""
    m = _check_machine_access(await _find_machine(db, device_id), _user)
    if not m:
        return {"total": 0, "files": []}

    query = (
        select(Document)
        .options(
            defer(Document.content),
            defer(Document.content_tsv),
            defer(Document.metadata_),
            defer(Document.rendered_html),
        )
        .where(Document.machine_id == m.id, Document.tool_id == tool_id)
    )
    if project_id and project_id != "none":
        query = query.where(Document.project_id == uuid.UUID(project_id))
    elif project_id == "none":
        query = query.where(Document.project_id.is_(None))
    if category:
        query = query.where(Document.category == category)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    result = await db.execute(query.order_by(Document.synced_at.desc()).offset(offset).limit(limit))
    docs = result.scalars().all()

    return {
        "total": total,
        "files": [
            {
                "id": str(d.id),
                "title": d.title,
                "relative_path": d.relative_path,
                "category": d.category,
                "content_type": d.content_type,
                "file_size_bytes": d.file_size_bytes,
                "synced_at": d.synced_at.isoformat(),
            }
            for d in docs
        ],
    }
