"""Auth API — user registration, login, and management."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

import httpx
import xml.etree.ElementTree as ET
from fastapi import APIRouter, Depends, File, Header, HTTPException, Request, Response, UploadFile
from fastapi.responses import PlainTextResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import InviteCode, User
from ..db.session import get_db
from ..services import rate_limit
from ..services.cache import cache_get, cache_set
from ..middleware.auth import (
    create_access_token, get_current_user, hash_password, verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Brute-force guards. Login counts failures only, so a user who signs in
# normally never gets near the limit; register counts every attempt.
LOGIN_WINDOW = 15 * 60
LOGIN_MAX_PER_ACCOUNT = 10
LOGIN_MAX_PER_IP = 30
REGISTER_WINDOW = 60 * 60
REGISTER_MAX_PER_IP = 10


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str | None = None
    invite_code: str | None = None


class RegistrationModeResponse(BaseModel):
    mode: str  # open | invite_only | closed
    has_any_user: bool
    github_enabled: bool = False
    wechat_enabled: bool = False


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    role: str


class UserResponse(BaseModel):
    id: str
    email: str
    name: str | None
    role: str
    status: str
    collector_token: str | None = None
    avatar_url: str | None = None


class UpdateProfileRequest(BaseModel):
    name: str | None = None
    avatar_url: str | None = None


@router.get("/registration-mode", response_model=RegistrationModeResponse)
async def registration_mode(db: AsyncSession = Depends(get_db)) -> RegistrationModeResponse:
    """Public: so the register page can show the right UI (invite input / closed banner)."""
    count_result = await db.execute(select(User.id).limit(1))
    has_any = count_result.scalar_one_or_none() is not None
    return RegistrationModeResponse(
        mode=settings.registration_mode,
        has_any_user=has_any,
        github_enabled=bool(settings.github_client_id and settings.github_client_secret),
        wechat_enabled=bool(settings.wechat_token),
    )


@router.post("/register", response_model=UserResponse)
async def register(
    req: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    ip_key = f"register:ip:{rate_limit.client_ip(request) or 'unknown'}"
    await rate_limit.check(ip_key, REGISTER_MAX_PER_IP)
    await rate_limit.hit(ip_key, REGISTER_WINDOW)

    # Check if email already exists
    result = await db.execute(select(User).where(User.email == req.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Is this the very first user? (bypasses registration_mode — bootstrap owner)
    count_result = await db.execute(select(User.id).limit(1))
    is_first_user = count_result.scalar_one_or_none() is None

    # Invite code path (checked whenever provided, required when mode = invite_only)
    invite: InviteCode | None = None
    if req.invite_code:
        inv_result = await db.execute(
            select(InviteCode).where(InviteCode.code == req.invite_code)
        )
        invite = inv_result.scalar_one_or_none()
        if not invite:
            raise HTTPException(status_code=400, detail="Invalid invite code")
        if invite.expires_at and invite.expires_at < datetime.now(timezone.utc):
            raise HTTPException(status_code=400, detail="Invite code expired")
        if invite.use_count >= invite.max_uses:
            raise HTTPException(status_code=400, detail="Invite code already used up")

    # Apply registration_mode gating (skipped for first user + when a valid invite consumed)
    if not is_first_user and invite is None:
        if settings.registration_mode == "closed":
            raise HTTPException(status_code=403, detail="Registration is closed")
        if settings.registration_mode == "invite_only":
            raise HTTPException(status_code=403, detail="invite_code is required")

    if is_first_user:
        role, user_status = "owner", "active"
        token = secrets.token_hex(32)
    elif invite is not None:
        # Invite flow: pre-approved, auto-active with invite's target role
        role = invite.role_on_accept if invite.role_on_accept in {"viewer", "admin"} else "viewer"
        user_status = "active"
        token = secrets.token_hex(32)
    else:
        # Open self-register: instant active + token, NO admin gate.
        # The "register → wait for admin → approve → then fetch token"
        # round-trip was the #1 onboarding complaint. `open` now means
        # genuinely open — you self-register and immediately get a
        # collector token to start syncing. Operators who want a human
        # gate set registration_mode = invite_only (or closed).
        role, user_status = "viewer", "active"
        token = secrets.token_hex(32)

    user = User(
        email=req.email,
        name=req.name,
        hashed_password=hash_password(req.password),
        role=role,
        status=user_status,
        collector_token=token,
    )
    db.add(user)

    if invite is not None:
        invite.use_count += 1

    await db.flush()

    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


@router.post("/token-exchange", response_model=TokenResponse)
async def token_exchange(
    db: AsyncSession = Depends(get_db),
    x_collector_token: str = Header(None),
) -> TokenResponse:
    """Exchange a collector_token for a JWT. Used by MCP server setup."""
    if not x_collector_token:
        raise HTTPException(status_code=401, detail="X-Collector-Token header required")

    # Try per-user token first
    result = await db.execute(select(User).where(User.collector_token == x_collector_token))
    user = result.scalar_one_or_none()

    # Fallback: legacy global token → owner user
    if not user:
        from ..config import settings
        if x_collector_token == settings.collector_token:
            result = await db.execute(
                select(User).where(User.role == "owner", User.status == "active").limit(1)
            )
            user = result.scalar_one_or_none()

    if not user or user.status != "active":
        raise HTTPException(status_code=401, detail="Invalid collector token")
    token = create_access_token(str(user.id), user.role)
    return TokenResponse(access_token=token, user_id=str(user.id), role=user.role)


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(user: User = Depends(get_current_user)) -> TokenResponse:
    """Mint a fresh access token for the currently-authenticated user.

    Web clients call this on mount + every 12 h while open so the JWT
    slides forward; in practice, any user who opens the app at least
    once before the (30-day default) expiry stays logged in forever.
    `get_current_user` already rejects a stale/inactive account, so this
    endpoint can't be used to "resurrect" a revoked session.
    """
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not active")
    token = create_access_token(str(user.id), user.role)
    return TokenResponse(access_token=token, user_id=str(user.id), role=user.role)


@router.post("/login", response_model=TokenResponse)
async def login(
    req: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    account_key = f"login:account:{req.email.strip().lower()}"
    ip_key = f"login:ip:{rate_limit.client_ip(request) or 'unknown'}"
    await rate_limit.check(account_key, LOGIN_MAX_PER_ACCOUNT)
    await rate_limit.check(ip_key, LOGIN_MAX_PER_IP)

    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()
    if not user or not user.hashed_password or not verify_password(req.password, user.hashed_password):
        await rate_limit.hit(account_key, LOGIN_WINDOW)
        await rate_limit.hit(ip_key, LOGIN_WINDOW)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not yet approved")

    await rate_limit.reset(account_key)
    token = create_access_token(str(user.id), user.role)
    return TokenResponse(access_token=token, user_id=str(user.id), role=user.role)


# ---------------------------------------------------------------------------
# GitHub OAuth login
# ---------------------------------------------------------------------------

def _github_redirect_uri(request: Request) -> str:
    """OAuth redirect_uri — public_url when configured, else derived from the request."""
    if settings.public_url:
        return f"{settings.public_url.rstrip('/')}/api/auth/github/callback"
    return str(request.base_url).rstrip("/") + "/api/auth/github/callback"


def _sanitize_next(next_path: str | None) -> str:
    """Only same-origin relative paths. Reject "//host" (protocol-relative)
    AND "/\\host" — browsers normalize backslash to slash per the WHATWG URL
    spec, so "/\\evil.com" becomes "//evil.com" at navigation time."""
    if (
        next_path
        and next_path.startswith("/")
        and not next_path.startswith(("//", "/\\"))
    ):
        return next_path
    return ""


def _sign_state(payload_b64: str) -> str:
    return hmac.new(
        settings.secret_key.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def _make_state(next_path: str) -> str:
    """Stateless CSRF state: base64url(json) + "." + HMAC-SHA256 signature."""
    payload = {"n": secrets.token_hex(16), "t": int(time.time()), "next": next_path}
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")
    return f"{payload_b64}.{_sign_state(payload_b64)}"


def _verify_state(state: str) -> str | None:
    """Return the validated `next` path ("" if none) or None when state is invalid/expired."""
    try:
        payload_b64, sig = state.split(".", 1)
        if not hmac.compare_digest(sig, _sign_state(payload_b64)):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
        if abs(time.time() - int(payload["t"])) > 600:
            return None
        return _sanitize_next(payload.get("next"))
    except Exception:
        return None


@router.get("/github/authorize")
async def github_authorize(request: Request, next: str = "") -> RedirectResponse:
    """Kick off the GitHub OAuth flow — full-page redirect to GitHub."""
    if not settings.github_client_id:
        raise HTTPException(status_code=404, detail="GitHub OAuth not configured")
    params = urlencode({
        "client_id": settings.github_client_id,
        "redirect_uri": _github_redirect_uri(request),
        "scope": "read:user user:email",
        "state": _make_state(_sanitize_next(next)),
    })
    return RedirectResponse(
        f"https://github.com/login/oauth/authorize?{params}", status_code=302
    )


@router.get("/github/callback")
async def github_callback(
    request: Request,
    code: str = "",
    state: str = "",
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """GitHub redirects here. Exchange code → login/link/register → redirect to web."""
    # Frontend base: empty when public_url unset — relative redirect works since
    # web + api share the same domain via ingress.
    frontend = settings.public_url.rstrip("/") if settings.public_url else ""

    def _error(error_code: str) -> RedirectResponse:
        return RedirectResponse(f"{frontend}/auth/login?error={error_code}", status_code=302)

    next_path = _verify_state(state)
    if next_path is None or not code:
        return _error("github_oauth_failed")

    # Talk to GitHub. Never 500 to the browser mid-OAuth — any failure becomes
    # an error redirect. httpx honors HTTPS_PROXY automatically (trust_env=True);
    # operators in restricted networks set HTTPS_PROXY on the pod.
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            token_resp = await client.post(
                "https://github.com/login/oauth/access_token",
                headers={"Accept": "application/json"},
                json={
                    "client_id": settings.github_client_id,
                    "client_secret": settings.github_client_secret,
                    "code": code,
                    "redirect_uri": _github_redirect_uri(request),
                },
            )
            token_resp.raise_for_status()
            gh_token = token_resp.json().get("access_token")
            if not gh_token:
                return _error("github_oauth_failed")

            gh_headers = {
                "Authorization": f"Bearer {gh_token}",
                "Accept": "application/vnd.github+json",
            }
            user_resp = await client.get("https://api.github.com/user", headers=gh_headers)
            user_resp.raise_for_status()
            gh_user = user_resp.json()

            # Prefer the primary verified email, fall back to any verified one.
            verified_email: str | None = None
            emails_resp = await client.get(
                "https://api.github.com/user/emails", headers=gh_headers
            )
            if emails_resp.status_code == 200:
                emails = emails_resp.json()
                chosen = next(
                    (e for e in emails if e.get("primary") and e.get("verified")), None
                ) or next((e for e in emails if e.get("verified")), None)
                if chosen:
                    verified_email = chosen.get("email")
    except Exception:
        return _error("github_oauth_failed")

    if not gh_user.get("id"):
        return _error("github_oauth_failed")
    gh_id = str(gh_user["id"])

    # We key accounts on email. No verified email and no public profile email
    # → nothing safe to key on; bail rather than synthesizing one.
    email = verified_email or (gh_user.get("email") or "").strip() or None
    if not email:
        return _error("github_oauth_failed")

    # 1) Already linked → login
    result = await db.execute(select(User).where(User.github_id == gh_id))
    user = result.scalar_one_or_none()

    # 2) VERIFIED email matches an existing account → link + login. An
    #    unverified email must NOT link to an existing account.
    if user is None and verified_email:
        result = await db.execute(select(User).where(User.email == verified_email))
        user = result.scalar_one_or_none()
        if user is not None:
            user.github_id = gh_id

    # 3) New user — mirror /register's registration_mode gating.
    if user is None:
        # Unverified email colliding with an existing account: refuse (would
        # otherwise violate the unique email constraint or hijack the account).
        result = await db.execute(select(User).where(User.email == email))
        if result.scalar_one_or_none() is not None:
            return _error("github_oauth_failed")

        count_result = await db.execute(select(User.id).limit(1))
        is_first_user = count_result.scalar_one_or_none() is None
        if is_first_user:
            role, user_status = "owner", "active"
        elif settings.registration_mode == "open":
            role, user_status = "viewer", "active"
        else:
            # invite_only / closed — the GitHub flow can't carry invite codes.
            return _error("registration_closed")

        user = User(
            email=email,
            name=gh_user.get("name") or gh_user.get("login"),
            avatar_url=gh_user.get("avatar_url"),
            hashed_password=None,
            role=role,
            status=user_status,
            collector_token=secrets.token_hex(32),
            github_id=gh_id,
        )
        db.add(user)

    if user.status != "active":
        return _error("account_disabled")

    await db.flush()
    token = create_access_token(str(user.id), user.role)
    # Token goes in the URL FRAGMENT — fragments never reach server logs.
    return RedirectResponse(
        f"{frontend}/auth/callback#token={token}&next={quote(next_path)}",
        status_code=302,
    )


@router.get("/me", response_model=UserResponse)
async def get_me(user: User = Depends(get_current_user)) -> UserResponse:
    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


@router.patch("/me", response_model=UserResponse)
async def update_profile(
    req: UpdateProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Update caller's name and/or avatar."""
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not active")

    if req.name is not None:
        name_clean = req.name.strip()
        user.name = name_clean[:255] if name_clean else None

    if req.avatar_url is not None:
        avatar = req.avatar_url.strip()
        if not avatar:
            user.avatar_url = None
        else:
            if avatar.startswith("data:image/"):
                if len(avatar) > 2 * 1024 * 1024:
                    raise HTTPException(status_code=400, detail="Avatar image size exceeds 2MB limit")
                user.avatar_url = avatar
            elif avatar.startswith("http://") or avatar.startswith("https://"):
                user.avatar_url = avatar[:2048]
            else:
                raise HTTPException(status_code=400, detail="Invalid avatar URL or data URI format")

    await db.flush()
    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


@router.post("/me/avatar", response_model=UserResponse)
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Upload custom avatar image file (JPG, PNG, WebP, GIF, max 2MB). Stored self-contained as base64 data URI."""
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not active")

    content_type = (file.content_type or "").lower()
    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported image format. Please upload JPG, PNG, WebP or GIF.")

    content = await file.read()
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(content) > 2 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Avatar file size exceeds 2MB limit")

    b64_data = base64.b64encode(content).decode("ascii")
    user.avatar_url = f"data:{content_type};base64,{b64_data}"
    await db.flush()

    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


@router.delete("/me/avatar", response_model=UserResponse)
async def delete_avatar(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Clear/remove custom avatar."""
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not active")

    user.avatar_url = None
    await db.flush()

    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


@router.post("/me/rotate-collector-token", response_model=UserResponse)
async def rotate_collector_token(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    """Rotate the caller's own collector_token. Old token immediately invalidated.
    Any running collectors with the old token will start getting 401s until re-configured."""
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not active")
    user.collector_token = secrets.token_hex(32)
    await db.flush()
    return UserResponse(
        id=str(user.id),
        email=user.email,
        name=user.name,
        role=user.role,
        status=user.status,
        collector_token=user.collector_token,
        avatar_url=user.avatar_url,
    )


# ---------------------------------------------------------------------------
# WeChat Official Account Login (Subscription / Service Account Webhook)
# ---------------------------------------------------------------------------

_wechat_tickets: dict[str, dict] = {}


def _clean_expired_tickets() -> None:
    now = time.time()
    expired = [k for k, v in _wechat_tickets.items() if now - v.get("created_at", 0) > 600]
    for k in expired:
        _wechat_tickets.pop(k, None)


async def _get_ticket_data(code: str) -> dict | None:
    cached = await cache_get(f"wechat_ticket:{code}")
    if cached:
        return cached
    return _wechat_tickets.get(code)


async def _set_ticket_data(code: str, data: dict, ttl_seconds: int = 300) -> None:
    _wechat_tickets[code] = data
    await cache_set(f"wechat_ticket:{code}", data, ttl_seconds=ttl_seconds)


async def _delete_ticket_data(code: str) -> None:
    _wechat_tickets.pop(code, None)
    await cache_set(f"wechat_ticket:{code}", {"status": "used"}, ttl_seconds=60)


async def _create_wechat_ticket() -> str:
    _clean_expired_tickets()
    for _ in range(20):
        code = f"{secrets.randbelow(900000) + 100000}"
        if not await _get_ticket_data(code):
            break
    data = {"status": "pending", "openid": None, "created_at": time.time()}
    await _set_ticket_data(code, data, ttl_seconds=300)
    return code


async def _match_wechat_ticket(code: str, openid: str) -> bool:
    ticket = await _get_ticket_data(code)
    if ticket and ticket.get("status") == "pending":
        if time.time() - ticket.get("created_at", 0) <= 300:
            ticket["status"] = "success"
            ticket["openid"] = openid
            ticket["completed_at"] = time.time()
            await _set_ticket_data(code, ticket, ttl_seconds=300)
            return True
    return False


def _xml_reply(to_user: str, from_user: str, content: str) -> str:
    now = int(time.time())
    return (
        f"<xml>\n"
        f"  <ToUserName><![CDATA[{to_user}]]></ToUserName>\n"
        f"  <FromUserName><![CDATA[{from_user}]]></FromUserName>\n"
        f"  <CreateTime>{now}</CreateTime>\n"
        f"  <MsgType><![CDATA[text]]></MsgType>\n"
        f"  <Content><![CDATA[{content}]]></Content>\n"
        f"</xml>"
    )


@router.get("/wechat/webhook", response_class=PlainTextResponse)
async def wechat_verify_webhook(
    signature: str = "",
    timestamp: str = "",
    nonce: str = "",
    echostr: str = "",
) -> PlainTextResponse:
    """WeChat Server URL verification handshake.
    When setting up Webhook in WeChat Developer Console, WeChat calls this GET endpoint.
    """
    if not signature or not echostr:
        return PlainTextResponse("Memento WeChat Webhook is active.", status_code=200)

    token = settings.wechat_token
    items = sorted([token, timestamp, nonce])
    computed_sig = hashlib.sha1("".join(items).encode("utf-8")).hexdigest()
    if computed_sig == signature:
        return PlainTextResponse(content=echostr, status_code=200)

    return PlainTextResponse(content="Invalid signature", status_code=403)


@router.post("/wechat/webhook")
async def wechat_message_webhook(request: Request, db: AsyncSession = Depends(get_db)) -> Response:
    """WeChat messages and events receiver (XML format)."""
    body_bytes = await request.body()
    if not body_bytes:
        return PlainTextResponse("success", status_code=200)

    try:
        root = ET.fromstring(body_bytes.decode("utf-8", errors="replace"))
        msg_type = (root.findtext("MsgType") or "").strip().lower()
        from_user = (root.findtext("FromUserName") or "").strip()  # User openid
        to_user = (root.findtext("ToUserName") or "").strip()      # Developer account

        if msg_type == "text":
            content = (root.findtext("Content") or "").strip()
            # 1) Check if the message is a 6-digit login ticket
            if content.isdigit() and len(content) == 6:
                matched = await _match_wechat_ticket(content, from_user)
                if matched:
                    reply = "✅ 登录口令验证成功！请返回网页或桌面端，正在为您自动登录。"
                    return Response(content=_xml_reply(from_user, to_user, reply), media_type="application/xml")
                else:
                    reply = "⚠️ 口令已过期或不存在，请在屏幕上点击「刷新」获取新口令。"
                    return Response(content=_xml_reply(from_user, to_user, reply), media_type="application/xml")
            elif content in {"登录", "登陆", "验证码", "login"}:
                reply = "收到登录请求！请在 Memento 客户端点击「微信登录」，直接发送屏幕上显示的 6 位口令即可自动登录。"
                return Response(content=_xml_reply(from_user, to_user, reply), media_type="application/xml")
            else:
                reply = "收到您的消息！\n若需登录 Memento，请在网页/客户端点击「微信登录」并发送屏幕上显示的 6 位口令。"
                return Response(content=_xml_reply(from_user, to_user, reply), media_type="application/xml")

        elif msg_type == "event":
            event = (root.findtext("Event") or "").strip().lower()
            if event == "subscribe":
                reply = "欢迎关注！\n在登录 Memento 时，请直接发送登录屏幕上显示的 6 位数字口令即可自动登录。"
                return Response(content=_xml_reply(from_user, to_user, reply), media_type="application/xml")

    except Exception as e:
        import logging
        logging.getLogger("auth").error("WeChat webhook error: %s", e)

    return PlainTextResponse("success", status_code=200)


@router.get("/wechat/ticket")
async def create_wechat_ticket_endpoint(response: Response) -> dict:
    """Generate a 6-digit numeric login ticket for WeChat QR login."""
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    ticket = await _create_wechat_ticket()
    return {"ticket": ticket, "expires_in": 300}


@router.get("/wechat/poll")
async def poll_wechat_ticket_endpoint(
    ticket: str,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Poll the status of a WeChat login ticket."""
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    ticket_data = await _get_ticket_data(ticket)
    if not ticket_data:
        return {"status": "not_found"}

    if time.time() - ticket_data.get("created_at", 0) > 300:
        return {"status": "expired"}

    if ticket_data.get("status") != "success":
        return {"status": "pending"}

    openid = ticket_data.get("openid")
    if not openid:
        return {"status": "pending"}

    # Find or create User by wechat_openid
    result = await db.execute(select(User).where(User.wechat_openid == openid))
    user = result.scalar_one_or_none()

    if user is None:
        count_result = await db.execute(select(User.id).limit(1))
        is_first_user = count_result.scalar_one_or_none() is None

        if is_first_user:
            role, user_status = "owner", "active"
        elif settings.registration_mode == "open":
            role, user_status = "viewer", "active"
        else:
            return {"status": "registration_closed", "detail": "系统注册已关闭"}

        base_email = f"wx_{openid[:10].lower()}@memento.local"
        email = base_email
        chk = await db.execute(select(User).where(User.email == email))
        if chk.scalar_one_or_none() is not None:
            email = f"wx_{openid[:8].lower()}_{secrets.token_hex(4)}@memento.local"

        user = User(
            email=email,
            name=f"微信用户_{openid[-4:]}",
            role=role,
            status=user_status,
            collector_token=secrets.token_hex(32),
            wechat_openid=openid,
        )
        db.add(user)
        await db.flush()

    if user.status != "active":
        return {"status": "account_disabled", "detail": "账号已被停用"}

    # Invalidate ticket so it cannot be reused
    await _delete_ticket_data(ticket)

    token = create_access_token(str(user.id), user.role)
    return {
        "status": "success",
        "access_token": token,
        "user_id": str(user.id),
        "role": user.role,
    }
