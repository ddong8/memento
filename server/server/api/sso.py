"""Single sign-on with an OpenID Connect provider (authorization code flow with PKCE).

Works with any standard provider: Keycloak, Authing, Azure AD / Entra ID, Okta, Google Workspace,
or a company directory (LDAP / AD) put behind Keycloak. Configured by MEMENTO_OIDC_* (config.py);
the provider's redirect URI is {public_url}/api/auth/oidc/callback.

Accounts are matched by the provider's subject first, then by email when the provider vouches for it
(email_verified, or the email is in an allowed company domain). With MEMENTO_OIDC_ADMIN_GROUP set,
the role follows the provider's groups on every sign-in (admin / viewer; an owner stays owner).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from urllib.parse import quote, urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from jose import jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import create_access_token
from ..services import audit_service

router = APIRouter(prefix="/api/auth/oidc", tags=["auth"])
logger = logging.getLogger("server.sso")

STATE_TTL = 600
# Provider metadata and keys (plain cache: refetched when missing or stale)
_DISCOVERY_TTL = 3600
_cache: dict[str, tuple[float, dict]] = {}


def oidc_enabled() -> bool:
    return bool(settings.oidc_issuer and settings.oidc_client_id and settings.oidc_client_secret)


def _issuer() -> str:
    return settings.oidc_issuer.rstrip("/")


def _redirect_uri(request: Request) -> str:
    base = settings.public_url.rstrip("/") if settings.public_url else str(request.base_url).rstrip("/")
    return f"{base}/api/auth/oidc/callback"


def _frontend() -> str:
    return settings.public_url.rstrip("/") if settings.public_url else ""


async def _get_json(client: httpx.AsyncClient, url: str, key: str) -> dict:
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < _DISCOVERY_TTL:
        return hit[1]
    resp = await client.get(url)
    resp.raise_for_status()
    data = resp.json()
    _cache[key] = (time.time(), data)
    return data


async def _discovery(client: httpx.AsyncClient) -> dict:
    return await _get_json(client, f"{_issuer()}/.well-known/openid-configuration", "discovery")


# --- stateless state: payload + HMAC; the nonce and the PKCE verifier are derived from it ---

def _sign(data: str) -> str:
    return hmac.new(settings.secret_key.encode(), ("oidc:" + data).encode(), hashlib.sha256).hexdigest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def make_state(next_path: str) -> str:
    payload = _b64(json.dumps({"n": secrets.token_hex(16), "t": int(time.time()), "next": next_path}).encode())
    return f"{payload}.{_sign(payload)}"


def read_state(state: str) -> dict | None:
    try:
        payload, sig = state.split(".", 1)
        if not hmac.compare_digest(sig, _sign(payload)):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if abs(time.time() - int(data["t"])) > STATE_TTL:
            return None
        return data
    except Exception:
        return None


def _nonce(n: str) -> str:
    return _sign("nonce:" + n)[:32]


def _verifier(n: str) -> str:
    return _sign("pkce:" + n)  # 64 hex chars, within PKCE's 43..128


def _challenge(verifier: str) -> str:
    return _b64(hashlib.sha256(verifier.encode("ascii")).digest())


def _sanitize_next(next_path: str | None) -> str:
    if next_path and next_path.startswith("/") and not next_path.startswith(("//", "/\\")):
        return next_path
    return ""


# --- who may sign in, as what ---

def _allowed_domains() -> list[str]:
    return [d.strip().lower().lstrip("@") for d in (settings.oidc_allowed_domains or "").split(",") if d.strip()]


def email_trusted(claims: dict) -> bool:
    """The provider vouches for the email: verified, or in one of the company's domains."""
    email = (claims.get("email") or "").lower()
    if not email:
        return False
    if claims.get("email_verified") is True or str(claims.get("email_verified")).lower() == "true":
        return True
    domains = _allowed_domains()
    return bool(domains) and email.rsplit("@", 1)[-1] in domains


def domain_allowed(email: str) -> bool:
    domains = _allowed_domains()
    return not domains or email.lower().rsplit("@", 1)[-1] in domains


def role_from_groups(claims: dict) -> str | None:
    """admin / viewer from the groups claim when an admin group is configured, else None (leave as is)."""
    group = (settings.oidc_admin_group or "").strip()
    if not group:
        return None
    groups = claims.get("groups") or claims.get("roles") or []
    if isinstance(groups, str):
        groups = [groups]
    return "admin" if group in groups else "viewer"


async def resolve_user(db: AsyncSession, claims: dict) -> tuple[User | None, str | None]:
    """The account these ID token claims sign in to (creating it when allowed), or an error code."""
    subject = f"{_issuer()}|{claims.get('sub')}"
    email = (claims.get("email") or claims.get("preferred_username") or "").strip().lower()
    if not claims.get("sub"):
        return None, "sso_failed"
    if email and "@" in email and not domain_allowed(email):
        return None, "sso_domain_not_allowed"

    user = (await db.execute(select(User).where(User.oidc_subject == subject))).scalar_one_or_none()
    if user is None and email and email_trusted({**claims, "email": email}):
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        if user is not None:
            user.oidc_subject = subject
    if user is None:
        if not email or "@" not in email:
            return None, "sso_no_email"
        if (await db.execute(select(User).where(User.email == email))).scalar_one_or_none() is not None:
            # An account with this email exists, but the provider doesn't vouch for the email
            return None, "sso_email_unverified"
        if not settings.oidc_auto_create:
            return None, "sso_no_account"
        first = (await db.execute(select(User.id).limit(1))).scalar_one_or_none() is None
        user = User(
            email=email,
            name=claims.get("name") or claims.get("preferred_username") or email.split("@")[0],
            avatar_url=claims.get("picture"),
            hashed_password=None,
            role="owner" if first else (role_from_groups(claims) or "viewer"),
            status="active",
            collector_token=secrets.token_hex(32),
            oidc_subject=subject,
        )
        db.add(user)
        await db.flush()
        return user, None

    if user.status != "active":
        return None, "account_disabled"
    role = role_from_groups(claims)
    if role and user.role in ("viewer", "admin") and user.role != role:
        user.role = role
    return user, None


@router.get("/authorize")
async def oidc_authorize(request: Request, next: str = "") -> RedirectResponse:
    if not oidc_enabled():
        raise HTTPException(status_code=404, detail="SSO not configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            meta = await _discovery(client)
    except Exception:
        logger.exception("OIDC discovery failed")
        return RedirectResponse(f"{_frontend()}/auth/login?error=sso_failed", status_code=302)
    state = make_state(_sanitize_next(next))
    n = read_state(state)["n"]
    params = urlencode({
        "response_type": "code",
        "client_id": settings.oidc_client_id,
        "redirect_uri": _redirect_uri(request),
        "scope": settings.oidc_scopes or "openid email profile",
        "state": state,
        "nonce": _nonce(n),
        "code_challenge": _challenge(_verifier(n)),
        "code_challenge_method": "S256",
    })
    return RedirectResponse(f"{meta['authorization_endpoint']}?{params}", status_code=302)


async def _exchange(request: Request, code: str, n: str) -> dict:
    """Code → verified ID token claims."""
    async with httpx.AsyncClient(timeout=15) as client:
        meta = await _discovery(client)
        resp = await client.post(
            meta["token_endpoint"],
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(request),
                "code_verifier": _verifier(n),
                "client_id": settings.oidc_client_id,
            },
            auth=(settings.oidc_client_id, settings.oidc_client_secret),
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        tokens = resp.json()
        id_token = tokens.get("id_token")
        if not id_token:
            raise ValueError("no id_token")
        jwks = await _get_json(client, meta["jwks_uri"], "jwks")
        header = jwt.get_unverified_header(id_token)
        try:
            claims = _decode(id_token, jwks, header, tokens.get("access_token"), meta)
        except Exception:
            # Keys rotated since they were cached: fetch them again once
            _cache.pop("jwks", None)
            jwks = await _get_json(client, meta["jwks_uri"], "jwks")
            claims = _decode(id_token, jwks, header, tokens.get("access_token"), meta)
        if claims.get("nonce") != _nonce(n):
            raise ValueError("nonce mismatch")
        # Some providers put email / groups only in userinfo
        if (not claims.get("email") or (settings.oidc_admin_group and "groups" not in claims)) \
                and meta.get("userinfo_endpoint") and tokens.get("access_token"):
            ui = await client.get(meta["userinfo_endpoint"],
                                  headers={"Authorization": f"Bearer {tokens['access_token']}"})
            if ui.status_code == 200:
                info = ui.json()
                if info.get("sub") == claims.get("sub"):
                    claims = {**info, **{k: v for k, v in claims.items() if v not in (None, "")}}
        return claims


def _decode(id_token: str, jwks: dict, header: dict, access_token: str | None, meta: dict) -> dict:
    keys = jwks.get("keys", [])
    key = next((k for k in keys if k.get("kid") == header.get("kid")), keys[0] if len(keys) == 1 else None)
    if key is None:
        raise ValueError("signing key not found")
    return jwt.decode(
        id_token,
        key,
        algorithms=[header.get("alg") or "RS256"],
        audience=settings.oidc_client_id,
        issuer=meta.get("issuer") or _issuer(),
        access_token=access_token,
        options={"verify_at_hash": bool(access_token)},
    )


@router.get("/callback")
async def oidc_callback(
    request: Request,
    code: str = "",
    state: str = "",
    error: str = "",
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    def fail(code_: str) -> RedirectResponse:
        return RedirectResponse(f"{_frontend()}/auth/login?error={code_}", status_code=302)

    data = read_state(state) if state else None
    if error or data is None or not code or not oidc_enabled():
        return fail("sso_failed")
    try:
        claims = await _exchange(request, code, data["n"])
    except Exception:
        logger.exception("OIDC code exchange / token verification failed")
        return fail("sso_failed")

    user, err = await resolve_user(db, claims)
    if user is None:
        await audit_service.record(db, None, "auth.sso.denied", detail={
            "reason": err, "email": claims.get("email"), "sub": claims.get("sub"),
        }, request=request)
        await db.commit()
        return fail(err or "sso_failed")
    await audit_service.record(db, user, "auth.sso.login", request=request)
    await db.flush()
    token = create_access_token(str(user.id), user.role)
    next_path = _sanitize_next(data.get("next"))
    return RedirectResponse(f"{_frontend()}/auth/callback#token={token}&next={quote(next_path)}", status_code=302)
