"""Auth API — user registration, login, and management."""

from __future__ import annotations

import secrets
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import User
from ..db.session import get_db
from ..middleware.auth import (
    create_access_token, get_current_user, hash_password, require_role, verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str | None = None


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


@router.post("/register", response_model=UserResponse)
async def register(
    req: RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> UserResponse:
    # Check if email already exists
    result = await db.execute(select(User).where(User.email == req.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    # Check if this is the first user (auto-promote to owner)
    count_result = await db.execute(select(User.id).limit(1))
    is_first_user = count_result.scalar_one_or_none() is None

    user = User(
        email=req.email,
        name=req.name,
        hashed_password=hash_password(req.password),
        role="owner" if is_first_user else "pending",
        status="active" if is_first_user else "pending",
        collector_token=secrets.token_hex(32) if is_first_user else None,
    )
    db.add(user)
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
