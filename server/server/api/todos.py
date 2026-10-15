"""Todos API — the app's list, and what MCP / the agent add and close."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Todo, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.todo_service import (
    add_todo,
    clean_title,
    close_todo,
    fingerprint,
    open_todos,
    parse_due,
    todo_counts,
    todo_out,
)

router = APIRouter(prefix="/api/todos", tags=["todos"])

CLOSED_DAYS = 14


class TodoCreate(BaseModel):
    title: str
    detail: str | None = None
    project: str | None = None
    due: str | None = None  # YYYY-MM-DD
    source: str | None = None  # manual (app) | mcp | agent


class TodoEdit(BaseModel):
    title: str | None = None
    detail: str | None = None
    project: str | None = None
    due: str | None = None  # "" clears it
    status: str | None = None  # open | done | dropped
    evidence: str | None = None


async def _own(db: AsyncSession, user: User, todo_id: str) -> Todo:
    try:
        tid = uuid.UUID(todo_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="not found")
    todo = await db.get(Todo, tid)
    if todo is None or todo.user_id != user.id:
        raise HTTPException(status_code=404, detail="not found")
    return todo


async def _bust_user_todo_cache(user_id: Any) -> None:
    from ..services.cache import cache_delete_prefix
    await cache_delete_prefix(f"todos:{user_id}:")


@router.get("")
async def list_todos(
    project: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from ..services.cache import cache_get, cache_set

    clean_proj = project.strip() if project and project.strip() else None
    cache_key = f"todos:{user.id}:{clean_proj.lower() if clean_proj else 'all'}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    opened = await open_todos(db, user, limit=200, project=clean_proj)
    since = datetime.now(timezone.utc) - timedelta(days=CLOSED_DAYS)
    closed_q = select(Todo).where(
        Todo.user_id == user.id, Todo.status != "open", Todo.closed_at >= since
    )
    if clean_proj:
        closed_q = closed_q.where(Todo.project.ilike(f"%{clean_proj}%"))
    closed = (await db.execute(
        closed_q.order_by(Todo.closed_at.desc()).limit(50)
    )).scalars().all()

    payload = {
        "open": [todo_out(t) for t in opened],
        "closed": [todo_out(t) for t in closed],
        "counts": await todo_counts(db, user),
    }
    await cache_set(cache_key, payload, ttl_seconds=30)
    return payload


@router.post("")
async def create_todo(
    body: TodoCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if not clean_title(body.title):
        raise HTTPException(status_code=400, detail="待办内容不能为空")
    source = body.source if body.source in ("manual", "mcp", "agent") else "manual"
    todo, created = await add_todo(
        db, user, body.title, detail=body.detail, project=body.project,
        due_at=parse_due(body.due), source=source,
    )
    await db.commit()
    await db.refresh(todo)
    await _bust_user_todo_cache(user.id)
    return {"todo": todo_out(todo), "created": created}


@router.put("/{todo_id}")
async def edit_todo(
    todo_id: str,
    body: TodoEdit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    todo = await _own(db, user, todo_id)
    if body.title is not None:
        title = clean_title(body.title)
        if not title:
            raise HTTPException(status_code=400, detail="待办内容不能为空")
        todo.title, todo.fingerprint = title, fingerprint(title)
    if body.detail is not None:
        todo.detail = body.detail.strip() or None
    if body.project is not None:
        todo.project = body.project.strip()[:120] or None
    if body.due is not None:
        todo.due_at = parse_due(body.due) if body.due else None
        todo.reminded_at = None
    if body.status is not None and body.status != todo.status:
        try:
            close_todo(todo, body.status, body.evidence or ("手动标记" if body.status != "open" else None))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    await db.commit()
    await db.refresh(todo)
    await _bust_user_todo_cache(user.id)
    return {"todo": todo_out(todo)}
