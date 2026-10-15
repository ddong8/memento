"""API endpoints for daily life rhythm, sleep tracking, screen time allocation and AI lifestyle advice."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user, get_current_user_or_collector
from ..services import life_service

router = APIRouter(prefix="/api/life", tags=["life_rhythm"])


class RecordRhythmBody(BaseModel):
    log_date: str | None = None  # YYYY-MM-DD, defaults to today
    wakeup_time: str | None = None
    bedtime: str | None = None
    sleep_hours: float | None = None
    app_usages: list[dict[str, Any]] = []


class ParseImageBody(BaseModel):
    image: str  # Base64 string or data:image/... data URL


class SyncRhythmBody(BaseModel):
    days: int = 7
    tz_offset: int = 0


@router.get("/rhythm")
async def get_rhythms(
    days: int = Query(7, ge=1, le=90),
    tz_offset: int = Query(0, description="Client timezone offset in minutes, e.g. -480 for UTC+8"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get user's daily life rhythms and screen time allocation for the past N days."""
    return await life_service.get_recent_rhythms(db, user, days=days, tz_offset=tz_offset)


@router.post("/rhythm/sync")
async def sync_collector_rhythms(
    body: SyncRhythmBody = SyncRhythmBody(),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Explicitly trigger sync and recompute life rhythms from collector interaction events."""
    synced = await life_service.sync_rhythms_from_collector(
        db, user, days=body.days, tz_offset=body.tz_offset
    )
    from ..services.cache import cache_set
    await cache_set(f"life:sync_cooldown:{user.id}:{body.days}", "1", ttl_seconds=300)
    return {
        "status": "ok",
        "synced_days": len(synced),
        "records": [
            {
                "id": str(r.id),
                "date": r.log_date.isoformat(),
                "wakeup_time": r.wakeup_time,
                "bedtime": r.bedtime,
                "sleep_hours": r.sleep_hours,
                "total_screen_minutes": r.total_screen_minutes,
                "productive_minutes": r.productive_minutes,
                "distraction_minutes": r.distraction_minutes,
                "app_usages": r.app_usages,
                "ai_advice": r.ai_advice,
            }
            for r in synced
        ],
    }


@router.post("/rhythm")
async def record_rhythm(
    body: RecordRhythmBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user_or_collector),
):
    """Record daily sleep times, wake-up times, and app usage minutes."""
    target_date = date.fromisoformat(body.log_date) if body.log_date else date.today()
    record = await life_service.record_daily_rhythm(
        db,
        user,
        log_date=target_date,
        app_usages=body.app_usages,
        wakeup_time=body.wakeup_time,
        bedtime=body.bedtime,
        sleep_hours=body.sleep_hours,
    )
    return {
        "status": "ok",
        "id": str(record.id),
        "log_date": record.log_date.isoformat(),
        "total_screen_minutes": record.total_screen_minutes,
        "productive_minutes": record.productive_minutes,
        "distraction_minutes": record.distraction_minutes,
    }


@router.post("/rhythm/parse-image")
@router.post("/rhythm/ocr")
async def parse_screentime_image(
    body: ParseImageBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user_or_collector),
):
    """Parse iOS or Android Screen Time screenshot using multimodal AI vision."""
    return await life_service.parse_screen_time_screenshot(db, user, body.image)


@router.post("/rhythm/clear")
@router.delete("/rhythm")
async def clear_rhythms(
    log_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Clear all or specific date's life rhythm data (e.g. remove sample data)."""
    target_date = date.fromisoformat(log_date) if log_date else None
    count = await life_service.clear_user_rhythms(db, user, target_date)
    return {"status": "ok", "deleted_count": count}



@router.post("/rhythm/advice")
async def get_life_advice(
    log_date: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate comprehensive AI lifestyle decisions based on tracked sleep & app usage."""
    target_date = date.fromisoformat(log_date) if log_date else date.today()
    advice = await life_service.generate_life_decision_advice(db, user, target_date=target_date)
    return {"status": "ok", "advice": advice}


@router.post("/rhythm/sample")
async def populate_sample_rhythm(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Populate sample realistic life rhythm data so user can preview the feature immediately."""
    from datetime import timedelta
    today = date.today()

    sample_days = [
        {
            "offset": 0,
            "wakeup": "07:30",
            "bed": "00:45",
            "apps": [
                {"name": "VS Code", "minutes": 260, "category": "work"},
                {"name": "Chrome (研发文档)", "minutes": 140, "category": "work"},
                {"name": "微信", "minutes": 95, "category": "social"},
                {"name": "哔哩哔哩", "minutes": 55, "category": "entertainment"},
                {"name": "微信读书", "minutes": 35, "category": "reading"},
                {"name": "抖音", "minutes": 40, "category": "entertainment"},
            ],
        },
        {
            "offset": 1,
            "wakeup": "07:45",
            "bed": "01:15",
            "apps": [
                {"name": "VS Code", "minutes": 220, "category": "work"},
                {"name": "Terminal", "minutes": 80, "category": "work"},
                {"name": "微信", "minutes": 110, "category": "social"},
                {"name": "抖音", "minutes": 85, "category": "entertainment"},
                {"name": "小红书", "minutes": 45, "category": "entertainment"},
            ],
        },
        {
            "offset": 2,
            "wakeup": "07:15",
            "bed": "23:45",
            "apps": [
                {"name": "Cursor", "minutes": 310, "category": "work"},
                {"name": "飞书", "minutes": 90, "category": "work"},
                {"name": "微信读书", "minutes": 60, "category": "reading"},
                {"name": "微信", "minutes": 70, "category": "social"},
                {"name": "哔哩哔哩", "minutes": 30, "category": "entertainment"},
            ],
        },
    ]

    for item in sample_days:
        d = today - timedelta(days=item["offset"])
        await life_service.record_daily_rhythm(
            db,
            user,
            log_date=d,
            app_usages=item["apps"],
            wakeup_time=item["wakeup"],
            bedtime=item["bed"],
        )

    # Generate initial advice
    advice = await life_service.generate_life_decision_advice(db, user, target_date=today)
    return {"status": "ok", "message": "已生成示例作息与时间分配数据", "advice": advice}
