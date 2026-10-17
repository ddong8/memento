"""Phone push settings (Bark)."""

from __future__ import annotations


from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import get_current_user
from ..services.notify_service import mask_push_url, parse_push_url

router = APIRouter(prefix="/api/notify", tags=["notify"])


class NotifySettingsBody(BaseModel):
    bark_url: str | None = None  # "" clears it; None leaves it unchanged
    notify_risky: bool | None = None
    notify_task_done: bool | None = None
    notify_health: bool | None = None
    notify_learning: bool | None = None
    notify_todo: bool | None = None


def _settings_out(user: User) -> dict:
    prefs = user.notify_settings or {}
    device_tokens = prefs.get("device_tokens") or []
    return {
        "bark_configured": bool(prefs.get("bark_url")),
        "bark_masked": mask_push_url(prefs.get("bark_url")),
        "device_tokens_count": len(device_tokens),
        "native_configured": len(device_tokens) > 0,
        "notify_risky": prefs.get("notify_risky", True),
        "notify_task_done": prefs.get("notify_task_done", True),
        "notify_health": prefs.get("notify_health", True),
        "notify_learning": prefs.get("notify_learning", True),
        "notify_todo": prefs.get("notify_todo", True),
    }


@router.get("/settings")
async def get_settings(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    ua = request.headers.get("user-agent", "")
    # 自动识别 MementoMobile 客户端并激活移动端原生设备状态
    if "MementoMobile" in ua:
        prefs = dict(user.notify_settings or {})
        tokens: list[str] = list(prefs.get("device_tokens") or [])
        if not tokens:
            tokens.append("ios_memento_mobile_device")
            prefs["device_tokens"] = tokens
            user.notify_settings = prefs
            await db.commit()
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
        elif not parse_push_url(raw):
            raise HTTPException(
                status_code=400,
                detail="不是有效的推送地址。iOS 请使用 https://api.day.app/Key，Android 请使用 https://ntfy.sh/Topic",
            )
        else:
            prefs["bark_url"] = raw
    if body.notify_risky is not None:
        prefs["notify_risky"] = body.notify_risky
    if body.notify_task_done is not None:
        prefs["notify_task_done"] = body.notify_task_done
    if body.notify_health is not None:
        prefs["notify_health"] = body.notify_health
    if body.notify_learning is not None:
        prefs["notify_learning"] = body.notify_learning
    if body.notify_todo is not None:
        prefs["notify_todo"] = body.notify_todo
    user.notify_settings = prefs
    await db.commit()
    return _settings_out(user)


class DeviceTokenBody(BaseModel):
    token: str
    platform: str | None = "mobile"


@router.post("/device-token")
async def register_device_token(
    body: DeviceTokenBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Register native mobile push token for Memento App."""
    tok = body.token.strip()
    if not tok:
        raise HTTPException(status_code=400, detail="Token cannot be empty")

    prefs = dict(user.notify_settings or {})
    tokens: list[str] = list(prefs.get("device_tokens") or [])

    # If registering a real APNs hex token (typically 64 hex characters) or Expo token,
    # clean out dummy fallback placeholders (ios_*, memento_*, client_*)
    is_real_token = tok.startswith("ExponentPushToken") or tok.startswith("ExpoPushToken") or (len(tok) == 64 and all(c in "0123456789abcdefABCDEF" for c in tok))
    if is_real_token:
        tokens = [t for t in tokens if not t.startswith("ios_") and not t.startswith("memento_") and not t.startswith("client_")]

    if tok not in tokens:
        tokens.append(tok)
    tokens = list(dict.fromkeys(tokens))
    prefs["device_tokens"] = tokens
    user.notify_settings = prefs
    await db.commit()
    return {"status": "ok", "registered": True, "device_tokens_count": len(tokens)}


@router.delete("/device-token")
async def unregister_device_token(
    body: DeviceTokenBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Unregister mobile push token upon sign-out."""
    tok = body.token.strip()
    prefs = dict(user.notify_settings or {})
    tokens: list[str] = list(prefs.get("device_tokens") or [])
    if tok in tokens:
        tokens.remove(tok)
        prefs["device_tokens"] = tokens
        user.notify_settings = prefs
        await db.commit()
    return {"status": "ok", "unregistered": True}


class LiveActivityTokenBody(BaseModel):
    push_to_start_token: str | None = None
    activity_push_token: str | None = None
    conversation_id: str | None = None


@router.post("/live-activity-token")
async def register_live_activity_token(
    body: LiveActivityTokenBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Register iOS ActivityKit pushToStartToken or per-conversation activity pushToken for Dynamic Island."""
    prefs = dict(user.notify_settings or {})
    changed = False

    if body.push_to_start_token:
        pts_tok = body.push_to_start_token.strip()
        if pts_tok:
            pts_list: list[str] = list(prefs.get("live_activity_start_tokens") or [])
            if pts_tok not in pts_list:
                pts_list.insert(0, pts_tok)
                prefs["live_activity_start_tokens"] = pts_list[:5]
                changed = True

    if body.activity_push_token and body.conversation_id:
        act_tok = body.activity_push_token.strip()
        cid = body.conversation_id.strip()
        if act_tok and cid:
            act_map: dict[str, str] = dict(prefs.get("live_activity_tokens") or {})
            act_map[cid] = act_tok
            # Keep at most 20 recent conversation activity tokens
            if len(act_map) > 20:
                keys = list(act_map.keys())
                for k in keys[:-20]:
                    act_map.pop(k, None)
            prefs["live_activity_tokens"] = act_map
            changed = True

    if changed:
        user.notify_settings = prefs
        await db.commit()

    return {"status": "ok", "registered": changed}



@router.get("/feed")
async def get_notification_feed(
    request: Request,
    since: str | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Fetch unread/recent notification items for real-time mobile push & popups."""
    ua = request.headers.get("user-agent", "")
    if "MementoMobile" in ua:
        prefs = dict(user.notify_settings or {})
        tokens: list[str] = list(prefs.get("device_tokens") or [])
        if not tokens:
            tokens.append("ios_memento_mobile_device")
            prefs["device_tokens"] = tokens
            user.notify_settings = prefs
            await db.commit()
    prefs = user.notify_settings or {}
    feed: list[dict] = list(prefs.get("recent_notifications") or [])
    if since:
        feed = [n for n in feed if n.get("created_at", "") > since]
    return feed


@router.post("/test")
async def send_test(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    from ..services.notify_service import notify_user

    ok = await notify_user(
        user.id,
        kind="todo",
        title="🔔 Memento 本机与全终端原生测试通知",
        body="恭喜！您的 Memento 桌面电脑与移动终端原生通知通道已完全通畅！",
        url="/profile?tab=account",
    )
    return {"ok": ok}
