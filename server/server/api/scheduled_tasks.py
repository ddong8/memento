"""Scheduled agent tasks (工作待办 → 定时任务): CRUD and "run now". See services/scheduled_tasks.py."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import ScheduledTask, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import scheduled_tasks as svc
from ..services.ask_stream import AGENT_MODES, normalize_permission_mode

router = APIRouter(prefix="/api/scheduled-tasks", tags=["scheduled-tasks"])


class ScheduledTaskBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    device: str = Field(..., min_length=1, max_length=255)
    agent: str = "claude"
    prompt: str = Field(..., min_length=1, max_length=20_000)
    cwd: str | None = None
    permission_mode: str = "full"
    schedule: str
    tz_offset_min: int = Field(480, ge=-720, le=840)
    enabled: bool = True


class ScheduledTaskPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    prompt: str | None = Field(None, min_length=1, max_length=20_000)
    cwd: str | None = None
    permission_mode: str | None = None
    schedule: str | None = None
    tz_offset_min: int | None = Field(None, ge=-720, le=840)
    enabled: bool | None = None


def _check(agent: str | None, schedule: str | None) -> None:
    if agent is not None and agent not in (*AGENT_MODES, "shell"):
        raise HTTPException(status_code=400, detail=f"不认识的智能体：{agent}")
    if schedule is not None and not svc.valid_schedule(schedule):
        raise HTTPException(status_code=400, detail="周期格式不对：hourly:MM、daily:HH:MM 或 weekly:D:HH:MM（D 0=周一）")


def _out(st: ScheduledTask) -> dict:
    return {
        "id": str(st.id), "title": st.title, "device": st.device, "agent": st.agent, "prompt": st.prompt, "cwd": st.cwd,
        "permission_mode": st.permission_mode, "schedule": st.schedule, "tz_offset_min": st.tz_offset_min, "enabled": st.enabled,
        "next_run_at": st.next_run_at.isoformat() if st.next_run_at else None,
        "last_run_at": st.last_run_at.isoformat() if st.last_run_at else None,
        "last_task_id": str(st.last_task_id) if st.last_task_id else None, "last_status": st.last_status,
    }


@router.get("")
async def list_scheduled(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(select(ScheduledTask).where(ScheduledTask.user_id == user.id).order_by(ScheduledTask.created_at))).scalars().all()
    return {"tasks": [_out(r) for r in rows]}


@router.post("")
async def create_scheduled(body: ScheduledTaskBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    _check(body.agent, body.schedule)
    st = ScheduledTask(
        user_id=user.id, title=body.title.strip(), device=body.device.strip(), agent=body.agent, prompt=body.prompt,
        cwd=(body.cwd or "").strip() or None, permission_mode=normalize_permission_mode(body.permission_mode),
        schedule=body.schedule.strip(), tz_offset_min=body.tz_offset_min, enabled=body.enabled,
    )
    st.next_run_at = svc.next_run(st.schedule, st.tz_offset_min, datetime.now(timezone.utc)) if st.enabled else None
    db.add(st)
    await db.commit()
    await db.refresh(st)
    return _out(st)


@router.patch("/{sid}")
async def update_scheduled(sid: str, body: ScheduledTaskPatch, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    st = await svc.owned(db, user, sid)
    if st is None:
        raise HTTPException(status_code=404)
    _check(None, body.schedule)
    for field in ("title", "prompt", "schedule", "tz_offset_min", "enabled"):
        v = getattr(body, field)
        if v is not None:
            setattr(st, field, v.strip() if isinstance(v, str) else v)
    if body.cwd is not None:
        st.cwd = body.cwd.strip() or None
    if body.permission_mode is not None:
        st.permission_mode = normalize_permission_mode(body.permission_mode)
    st.next_run_at = svc.next_run(st.schedule, st.tz_offset_min, datetime.now(timezone.utc)) if st.enabled else None
    await db.commit()
    await db.refresh(st)
    return _out(st)


@router.delete("/{sid}")
async def delete_scheduled(sid: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    st = await svc.owned(db, user, sid)
    if st is None:
        raise HTTPException(status_code=404)
    await db.delete(st)
    await db.commit()
    return {"ok": True}


@router.post("/{sid}/run")
async def run_scheduled_now(sid: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    st = await svc.owned(db, user, sid)
    if st is None:
        raise HTTPException(status_code=404)
    task = await svc.start(db, st, datetime.now(timezone.utc))
    return {"ok": True, "task_id": str(task.id) if task else None, "status": task.status if task else None}
