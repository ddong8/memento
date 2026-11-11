"""Collaborative tasks: a big task split into sub-tasks run in parallel on several devices and agents."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AgentPlan, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import plan_service

router = APIRouter(prefix="/api/plans", tags=["plans"])


class CreatePlanBody(BaseModel):
    goal: str
    title: str = ""
    cwd: str | None = None
    # The device the code is on; steps sent to other devices work on a copy and send the changes back
    source_device_id: str | None = None
    project_id: str | None = None
    auto_start: bool = True
    review: bool = True
    max_parallel: int | None = None


class EditStepsBody(BaseModel):
    steps: list[dict[str, Any]]


async def _own(db: AsyncSession, user: User, plan_id: str) -> AgentPlan:
    try:
        pid = uuid.UUID(plan_id)
    except ValueError:
        raise HTTPException(status_code=404)
    plan = await db.get(AgentPlan, pid)
    if not plan or plan.user_id != user.id:
        raise HTTPException(status_code=404)
    return plan


@router.post("")
async def create_plan(body: CreatePlanBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    goal = body.goal.strip()
    if not goal:
        raise HTTPException(status_code=400, detail="任务内容不能为空")
    options: dict[str, Any] = {"review": body.review}
    if body.max_parallel:
        options["max_parallel"] = max(1, min(int(body.max_parallel), 8))
    plan = await plan_service.create_plan(
        db, user, goal, cwd=body.cwd, source_device_id=body.source_device_id, project_id=body.project_id,
        auto_start=body.auto_start, title=body.title, options=options,
    )
    return plan_service.plan_out(plan)


@router.get("")
async def list_plans(limit: int = 30, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(
        select(AgentPlan).where(AgentPlan.user_id == user.id).order_by(AgentPlan.created_at.desc()).limit(max(1, min(limit, 100)))
    )).scalars().all()
    return [plan_service.plan_out(p, full=False) for p in rows]


@router.get("/capabilities")
async def capabilities(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """What the planner sees: devices online, their agents, quota, load and track record."""
    return await plan_service.capability_snapshot(db, user)


@router.get("/{plan_id}")
async def get_plan(plan_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    return plan_service.plan_out(await _own(db, user, plan_id))


def _out(plan: AgentPlan | None) -> dict:
    if not plan:
        raise HTTPException(status_code=404)
    return plan_service.plan_out(plan)


@router.post("/{plan_id}/start")
async def start_plan(plan_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    if plan.status != "ready":
        raise HTTPException(status_code=409, detail="只有规划好、还没开始的任务能开始")
    return _out(await plan_service.start_plan(plan.id))


@router.post("/{plan_id}/cancel")
async def cancel_plan(plan_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    return _out(await plan_service.cancel_plan(plan.id))


@router.post("/{plan_id}/replan")
async def replan(plan_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    if plan.status not in ("ready", "failed", "cancelled"):
        raise HTTPException(status_code=409, detail="运行中的任务不能重新规划，先停止")
    return _out(await plan_service.replan(plan.id))


@router.put("/{plan_id}/steps")
async def edit_steps(plan_id: str, body: EditStepsBody, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    if plan.status != "ready":
        raise HTTPException(status_code=409, detail="只能在开始前修改子任务")
    return _out(await plan_service.edit_steps(db, user, plan.id, body.steps))


@router.post("/{plan_id}/steps/{step_id}/retry")
async def retry_step(plan_id: str, step_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    return _out(await plan_service.retry_step(plan.id, step_id))


@router.post("/{plan_id}/steps/{step_id}/cancel")
async def cancel_step(plan_id: str, step_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    plan = await _own(db, user, plan_id)
    return _out(await plan_service.cancel_step(plan.id, step_id))
