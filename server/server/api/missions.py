"""Autonomous Background Missions API & Mobile Quick Approval Endpoints."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import defer
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AgentMission, User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import mission_service

router = APIRouter(prefix="/api/missions", tags=["missions"])


class CreateMissionBody(BaseModel):
    title: str
    goal: str
    risk_level: str = "low"
    context: dict[str, Any] = {}


class ApproveMissionBody(BaseModel):
    token: str | None = None


class RejectMissionBody(BaseModel):
    token: str | None = None
    reason: str = "用户驳回"


@router.get("")
async def list_missions(
    status: str | None = None,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List autonomous missions for the current user."""
    query = (
        select(AgentMission)
        .options(defer(AgentMission.context))
        .where(AgentMission.user_id == user.id)
    )
    if status:
        query = query.where(AgentMission.status == status)
    query = query.order_by(AgentMission.created_at.desc()).limit(limit)

    missions = (await db.execute(query)).scalars().all()
    return [
        {
            "id": str(m.id),
            "title": m.title,
            "goal": m.goal,
            "status": m.status,
            "risk_level": m.risk_level,
            "current_step": m.current_step,
            "steps_count": len(m.steps),
            "pending_action": m.pending_action,
            "summary": m.summary,
            "error": m.error,
            "last_heartbeat": m.last_heartbeat.isoformat() if m.last_heartbeat else None,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in missions
    ]


@router.post("")
async def create_mission(
    body: CreateMissionBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create and kick off a new autonomous mission."""
    mission = await mission_service.create_mission(
        db, user, title=body.title, goal=body.goal, context=body.context, risk_level=body.risk_level
    )
    return {"id": str(mission.id), "status": mission.status, "title": mission.title}


@router.get("/{mission_id}")
async def get_mission_detail(
    mission_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get full details and timeline of a mission."""
    mission = (await db.execute(
        select(AgentMission).where(AgentMission.id == mission_id, AgentMission.user_id == user.id)
    )).scalar_one_or_none()
    if not mission:
        raise HTTPException(status_code=404, detail="Mission not found")

    return {
        "id": str(mission.id),
        "title": mission.title,
        "goal": mission.goal,
        "status": mission.status,
        "risk_level": mission.risk_level,
        "current_step": mission.current_step,
        "steps": mission.steps,
        "pending_action": mission.pending_action,
        "summary": mission.summary,
        "error": mission.error,
        "last_heartbeat": mission.last_heartbeat.isoformat() if mission.last_heartbeat else None,
        "created_at": mission.created_at.isoformat() if mission.created_at else None,
    }


@router.get("/{mission_id}/approve", response_class=HTMLResponse)
async def mobile_one_click_approve(
    mission_id: uuid.UUID,
    token: str = Query(...),
    db: AsyncSession = Depends(get_db),
):
    """One-click approval handler for mobile push links."""
    success = await mission_service.approve_mission(db, mission_id, token=token, user_id=None)
    if success:
        return HTMLResponse("""
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>审批通过 - Memento 智能执事</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
            .card { background: #1E293B; border: 1px solid #334155; border-radius: 20px; padding: 32px 24px; max-width: 400px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
            .icon { font-size: 48px; margin-bottom: 16px; }
            h1 { font-size: 20px; margin: 0 0 12px; font-weight: 600; color: #10B981; }
            p { font-size: 14px; color: #94A3B8; line-height: 1.6; margin: 0 0 24px; }
            .badge { display: inline-block; background: rgba(16,185,129,0.15); color: #34D399; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="icon">✅</div>
            <h1>高危操作已授权放行</h1>
            <p>任务已恢复执行，AI 正在远程设备上继续推进工作。执行完毕后将自动向您汇报。</p>
            <div class="badge">Memento 24/7 Always-On</div>
          </div>
        </body>
        </html>
        """)
    return HTMLResponse("""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>授权无效 - Memento</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; }
        .card { background: #1E293B; border: 1px solid #334155; border-radius: 20px; padding: 32px 24px; max-width: 400px; text-align: center; }
        h1 { font-size: 20px; margin: 0 0 12px; color: #EF4444; }
        p { font-size: 14px; color: #94A3B8; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>授权无效或已过期</h1>
        <p>该操作可能已被处理、撤销或令牌已失效。</p>
      </div>
    </body>
    </html>
    """, status_code=400)


@router.post("/{mission_id}/approve")
async def api_approve_mission(
    mission_id: uuid.UUID,
    body: ApproveMissionBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """API endpoint to approve a pending mission."""
    success = await mission_service.approve_mission(db, mission_id, token=body.token, user_id=user.id)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot approve mission (invalid state or credentials)")
    return {"status": "ok", "message": "Mission resumed successfully"}


@router.post("/{mission_id}/reject")
async def api_reject_mission(
    mission_id: uuid.UUID,
    body: RejectMissionBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """API endpoint to reject a pending mission."""
    success = await mission_service.reject_mission(db, mission_id, token=body.token, user_id=user.id, reason=body.reason)
    if not success:
        raise HTTPException(status_code=400, detail="Cannot reject mission")
    return {"status": "ok", "message": "Mission rejected and cancelled"}
