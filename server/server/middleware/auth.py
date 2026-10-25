"""Authentication middleware and utilities."""

from __future__ import annotations

import secrets
import time
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, Header, HTTPException, Query, status
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import User
from ..db.session import get_db


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_access_token(user_id: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": user_id, "role": role, "exp": expire}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from e


# ---------------------------------------------------------------------------
# Short-term user auth cache (60s TTL) to alleviate high-frequency DB pressure
# ---------------------------------------------------------------------------
_USER_CACHE_TTL_SEC: float = 60.0
_user_cache: dict[str, tuple[float, User]] = {}
_collector_cache: dict[str, tuple[float, User]] = {}


def get_cached_user(user_id: str) -> User | None:
    now = time.monotonic()
    entry = _user_cache.get(user_id)
    if entry:
        if entry[0] > now:
            return entry[1]
        _user_cache.pop(user_id, None)
    return None


def set_cached_user(user_id: str, user: User) -> None:
    expire_at = time.monotonic() + _USER_CACHE_TTL_SEC
    _user_cache[user_id] = (expire_at, user)
    if user.collector_token:
        _collector_cache[user.collector_token] = (expire_at, user)


def get_cached_collector(token: str) -> User | None:
    now = time.monotonic()
    entry = _collector_cache.get(token)
    if entry:
        if entry[0] > now:
            return entry[1]
        _collector_cache.pop(token, None)
    return None


def set_cached_collector(token: str, user: User) -> None:
    expire_at = time.monotonic() + _USER_CACHE_TTL_SEC
    _collector_cache[token] = (expire_at, user)
    _user_cache[str(user.id)] = (expire_at, user)


def invalidate_user_cache(user_id: str | uuid.UUID | None = None, collector_token: str | None = None) -> None:
    """Evict user from short-term cache when settings or tokens are updated."""
    if user_id:
        uid = str(user_id)
        entry = _user_cache.pop(uid, None)
        if entry and entry[1].collector_token:
            _collector_cache.pop(entry[1].collector_token, None)
    if collector_token:
        _collector_cache.pop(collector_token, None)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------

async def _signed_in(db: AsyncSession, user: User) -> User:
    """Ends the read transaction the lookup began. A request that then streams for minutes
    (an ask, an attached run, a video from a device) would otherwise hold it open until the
    database cuts the connection (idle_in_transaction_session_timeout, 60 s)."""
    await db.commit()
    return user


async def verify_collector_token(
    x_collector_token: str = Header(...),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Verify the collector auth token. Returns the owning User.

    Supports per-user tokens (User.collector_token) and legacy global token
    (settings.collector_token → maps to the first owner user).
    """
    cached = get_cached_collector(x_collector_token)
    if cached is not None:
        if cached.status != "active":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid collector token")
        return await db.merge(cached, load=False)

    # Try per-user token first
    result = await db.execute(select(User).where(User.collector_token == x_collector_token))
    user = result.scalar_one_or_none()
    if user:
        set_cached_collector(x_collector_token, user)
        return await _signed_in(db, user)

    # Fallback: legacy global token → owner user
    if secrets.compare_digest(x_collector_token, settings.collector_token):
        result = await db.execute(
            select(User).where(User.role == "owner", User.status == "active").limit(1)
        )
        owner = result.scalar_one_or_none()
        if owner:
            set_cached_collector(x_collector_token, owner)
            return await _signed_in(db, owner)

    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid collector token")


async def get_current_user(
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Extract and validate the current user from JWT token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization")

    token = authorization[7:]
    payload = decode_token(token)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    cached = get_cached_user(user_id)
    if cached is not None:
        if cached.status != "active":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
        return await db.merge(cached, load=False)

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    set_cached_user(user_id, user)
    return await _signed_in(db, user)


async def get_current_user_flexible(
    authorization: str = Header(None),
    token_query: str = Query(None, alias="token"),
    token_bearer: str = Query(None, alias="access_token"),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Extract and validate the current user from Header OR Query param (token/access_token)."""
    raw_token = None
    if authorization and authorization.startswith("Bearer "):
        raw_token = authorization[7:]
    elif token_query:
        raw_token = token_query
    elif token_bearer:
        raw_token = token_bearer

    if not raw_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization")

    payload = decode_token(raw_token)
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")

    cached = get_cached_user(user_id)
    if cached is not None:
        if cached.status != "active":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")
        return await db.merge(cached, load=False)

    result = await db.execute(select(User).where(User.id == uuid.UUID(user_id)))
    user = result.scalar_one_or_none()
    if user is None or user.status != "active":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or inactive")

    set_cached_user(user_id, user)
    return await _signed_in(db, user)


async def get_optional_user(
    authorization: str = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Like get_current_user but returns None if no token provided."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return await get_current_user(authorization, db)
    except HTTPException:
        return None


def require_role(*roles: str):
    """Dependency factory that requires the user to have one of the given roles."""
    async def checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return user
    return checker


async def get_current_user_or_collector(
    authorization: str = Header(None),
    x_collector_token: str = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Accepts either Bearer JWT token or X-Collector-Token header."""
    if authorization and authorization.startswith("Bearer "):
        return await get_current_user(authorization, db)
    if x_collector_token:
        return await verify_collector_token(x_collector_token, db)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization")

