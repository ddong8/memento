"""Proactive Agent Settings & Test Endpoints."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services import pulse_service

router = APIRouter(prefix="/api/proactive", tags=["proactive"])


class ProactiveSettingsBody(BaseModel):
    enabled: bool = True
    morning_brief_enabled: bool = True
    morning_brief_time: str = "08:30"
    evening_reflection_enabled: bool = True
    evening_reflection_time: str = "22:30"
    device_alert_enabled: bool = True
    quiet_hours_start: str = "23:30"
    quiet_hours_end: str = "07:30"
    timezone_offset_hours: int = 8
    auto_approve_safe: bool = True


@router.get("/settings")
async def get_settings(user: User = Depends(get_current_user)):
    """Retrieve the proactive agent settings for the current user."""
    return pulse_service.get_user_settings(user)


@router.put("/settings")
async def update_settings(
    body: ProactiveSettingsBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update proactive agent settings for the current user."""
    merged = pulse_service.get_user_settings(user)
    merged.update(body.model_dump())
    user.proactive_settings = merged
    await db.commit()
    return {"status": "ok", "settings": merged}


import asyncio
import logging
import traceback
import uuid
from ..db.session import async_session_factory
from ..services.notify_service import notify_user, send_apns_push, send_expo_push, send_bark

logger = logging.getLogger("server.proactive")


@router.get("/version")
async def get_version():
    """Diagnostic version endpoint to verify deployment status."""
    return {"version": "2026-10-02-v2", "status": "active"}


@router.post("/test-morning-brief")
async def test_morning_brief(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Instantly test and send a morning brief to the user's phone."""
    try:
        prefs = pulse_service.get_user_settings(user)
        offset = prefs.get("timezone_offset_hours", 8)
        user_now = datetime.now(timezone.utc) + timedelta(hours=offset)

        # Run detailed LLM-powered briefing generation in background
        user_id = user.id
        async def _async_brief():
            try:
                async with async_session_factory() as async_db:
                    u = (await async_db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
                    if u:
                        await pulse_service._send_morning_brief(async_db, u, user_now)
            except Exception as e:
                logger.warning("Background morning brief failed for %s: %s", user_id, e)

        asyncio.create_task(_async_brief())
        return {"status": "ok", "message": "Morning brief triggered"}
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception("test_morning_brief crashed: %s", e)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}\n{tb}")


@router.post("/test-evening-reflection")
async def test_evening_reflection(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Instantly test and run memory dreaming reflection and push summary."""
    try:
        prefs = pulse_service.get_user_settings(user)
        offset = prefs.get("timezone_offset_hours", 8)
        user_now = datetime.now(timezone.utc) + timedelta(hours=offset)

        # Run dreaming pipeline in background
        user_id = user.id
        async def _async_reflection():
            try:
                async with async_session_factory() as async_db:
                    u = (await async_db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
                    if u:
                        await pulse_service._send_evening_reflection(async_db, u, user_now)
            except Exception as e:
                logger.warning("Background evening reflection failed for %s: %s", user_id, e)

        asyncio.create_task(_async_reflection())
        return {"status": "ok", "message": "Evening reflection triggered"}
    except Exception as e:
        tb = traceback.format_exc()
        logger.exception("test_evening_reflection crashed: %s", e)
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {str(e)}\n{tb}")


