"""Phone push settings (Bark)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.notify_service import mask_bark_url, parse_bark_url, send_bark

router = APIRouter(prefix="/api/notify", tags=["notify"])


class NotifySettingsBody(BaseModel):
    bark_url: str | None = None  # "" clears it; None leaves it unchanged
    notify_risky: bool | None = None
    notify_task_done: bool | None = None


def _settings_out(user: User) -> dict:
    prefs = user.notify_settings or {}
    return {
        "bark_configured": bool(prefs.get("bark_url")),
        "bark_masked": mask_bark_url(prefs.get("bark_url")),
        "notify_risky": prefs.get("notify_risky", True),
        "notify_task_done": prefs.get("notify_task_done", True),
    }


@router.get("/settings")
async def get_settings(user: User = Depends(get_current_user)) -> dict:
    return _settings_out(user)


@router.put("/settings")
async def update_settings(
    body: NotifySettingsBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    prefs = dict(user.notify_settings or {})
    if body.bark_url is not None:
        raw = body.bark_url.strip()
        if not raw:
            prefs.pop("bark_url", None)
        elif not parse_bark_url(raw):
            raise HTTPException(
                status_code=400,
                detail="不是有效的 Bark 推送地址，应形如 https://api.day.app/你的key",
            )
        else:
            prefs["bark_url"] = raw
    if body.notify_risky is not None:
        prefs["notify_risky"] = body.notify_risky
    if body.notify_task_done is not None:
        prefs["notify_task_done"] = body.notify_task_done
    user.notify_settings = prefs
    await db.commit()
    return _settings_out(user)


@router.post("/test")
async def send_test(user: User = Depends(get_current_user)) -> dict:
    bark_url = (user.notify_settings or {}).get("bark_url")
    if not bark_url:
        raise HTTPException(status_code=400, detail="还没有设置 Bark 推送地址")
    ok = await send_bark(bark_url, "Memento 测试通知", "收到这条说明推送已经通了。之后危险操作和任务完成都会推到这里。")
    if not ok:
        raise HTTPException(status_code=502, detail="推送失败，请检查 Bark 地址是否正确")
    return {"ok": True}
