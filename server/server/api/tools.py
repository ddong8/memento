"""Tools API — browse AI tools and their files, with optional device filter."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Document, Machine, Tool, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.user_filter import user_machine_ids, apply_user_filter

router = APIRouter(prefix="/api/tools", tags=["tools"])


class ToolSummary(BaseModel):
    id: str
    display_name: str
    icon: str | None
    total_files: int
    total_size_bytes: int
    last_sync_at: str | None


class DocumentSummary(BaseModel):
    id: str
    relative_path: str
    category: str
    content_type: str
    title: str | None
    file_size_bytes: int
    synced_at: str
    ai_summary: str | None = None
    device_name: str | None = None


def _device_filter(query, device_id: str | None):
    """Add device filter by looking up machine_id from collector_token_hash."""
    if not device_id:
        return query
    return query.where(Document.machine_id.in_(
        select(Machine.id).where(Machine.collector_token_hash == device_id)
    ))


@router.get("", response_model=list[ToolSummary])
async def list_tools(
    device_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[ToolSummary]:
    mids = await user_machine_ids(db, _user)

    if not device_id and mids is None:
        # Admin/owner without device filter — return raw Tool stats
        result = await db.execute(select(Tool).order_by(Tool.display_name))
        tools = result.scalars().all()
        return [
            ToolSummary(
                id=t.id, display_name=t.display_name, icon=t.icon,
                total_files=t.total_files, total_size_bytes=t.total_size_bytes,
                last_sync_at=t.last_sync_at.isoformat() if t.last_sync_at else None,
            ) for t in tools
        ]

    # Device-specific or user-filtered tool stats
    query = select(Document.tool_id, func.count().label("cnt"))
    if device_id:
        query = query.where(Document.machine_id.in_(
            select(Machine.id).where(Machine.collector_token_hash == device_id)
        ))
    query = apply_user_filter(query, mids, Document.machine_id)
    query = query.group_by(Document.tool_id)
    result = await db.execute(query)
    tool_counts = {r[0]: r[1] for r in result.all()}

    tools_result = await db.execute(select(Tool).order_by(Tool.display_name))
    return [
        ToolSummary(
            id=t.id, display_name=t.display_name, icon=t.icon,
            total_files=tool_counts.get(t.id, 0),
            total_size_bytes=0,
            last_sync_at=t.last_sync_at.isoformat() if t.last_sync_at else None,
        ) for t in tools_result.scalars().all()
        if t.id in tool_counts
    ]


TOOL_DISPLAY_NAMES = {
    "claude_code": "Claude Code", "openclaw": "OpenClaw", "codex": "Codex",
    "antigravity": "Antigravity", "obsidian": "Obsidian", "cursor": "Cursor",
    "windsurf": "Windsurf", "vscode": "VS Code", "hermes": "Hermes",
}


@router.get("/{tool_id}")
async def get_tool(
    tool_id: str,
    device_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> dict:
    mids = await user_machine_ids(db, _user)

    result = await db.execute(select(Tool).where(Tool.id == tool_id))
    tool = result.scalar_one_or_none()

    if not tool:
        return {
            "id": tool_id, "display_name": TOOL_DISPLAY_NAMES.get(tool_id, tool_id),
            "total_files": 0, "total_size_bytes": 0, "last_sync_at": None, "categories": {},
        }

    cat_query = (
        select(Document.category, func.count())
        .where(Document.tool_id == tool_id)
    )
    cat_query = _device_filter(cat_query, device_id)
    cat_query = apply_user_filter(cat_query, mids, Document.machine_id)
    cat_result = await db.execute(cat_query.group_by(Document.category))
    categories = {row[0]: row[1] for row in cat_result.all()}

    total = sum(categories.values())

    return {
        "id": tool.id, "display_name": tool.display_name,
        "total_files": total if (device_id or mids is not None) else tool.total_files,
        "total_size_bytes": tool.total_size_bytes,
        "last_sync_at": tool.last_sync_at.isoformat() if tool.last_sync_at else None,
        "categories": categories,
    }


@router.get("/{tool_id}/files", response_model=list[DocumentSummary])
async def list_tool_files(
    tool_id: str,
    category: str | None = None,
    device_id: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
) -> list[DocumentSummary]:
    mids = await user_machine_ids(db, _user)

    query = select(Document).where(Document.tool_id == tool_id)
    if category:
        query = query.where(Document.category == category)
    query = _device_filter(query, device_id)
    query = apply_user_filter(query, mids, Document.machine_id)
    query = query.order_by(Document.synced_at.desc()).offset(offset).limit(limit)

    result = await db.execute(query)
    docs = result.scalars().all()

    # Get device names
    machine_names: dict[str, str] = {}
    machine_ids = {d.machine_id for d in docs if d.machine_id}
    if machine_ids:
        m_result = await db.execute(select(Machine).where(Machine.id.in_(machine_ids)))
        machine_names = {str(m.id): m.name for m in m_result.scalars().all()}

    return [
        DocumentSummary(
            id=str(d.id), relative_path=d.relative_path, category=d.category,
            content_type=d.content_type, title=d.title,
            file_size_bytes=d.file_size_bytes, synced_at=d.synced_at.isoformat(),
            ai_summary=d.ai_summary,
            device_name=machine_names.get(str(d.machine_id)) if d.machine_id else None,
        ) for d in docs
    ]
