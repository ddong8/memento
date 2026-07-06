"""Auth API — user registration, login, and management."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import InviteCode, User
from ..db.session import get_db
from ..middleware.auth import (
    create_access_token, get_current_user, hash_password, require_role, verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str | None = None
    invite_code: str | None = None


class RegistrationModeResponse(BaseModel):
    mode: str  # open | invite_only | closed
    has_any_user: bool
    github_enabled: bool = False


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


@router.get("/registration-mode", response_model=RegistrationModeResponse)
async def registration_mode(db: AsyncSession = Depends(get_db)) -> RegistrationModeResponse:
    """Public: so the register page can show the right UI (invite input / closed banner)."""
    count_result = await db.execute(select(User.id).limit(1))
    has_any = count_result.scalar_one_or_none() is not None
    return RegistrationModeResponse(
        mode=settings.registration_mode,
        has_any_user=has_any,
        github_enabled=bool(settings.github_client_id and settings.github_client_secret),
    )


@router.post("/register", response_model=UserResponse)
async def register(
    req: RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
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
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    result = await db.execute(select(User).where(User.email == req.email))
    user = result.scalar_one_or_none()
    if not user or not user.hashed_password or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.status != "active":
        raise HTTPException(status_code=403, detail="Account not yet approved")

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
    )
