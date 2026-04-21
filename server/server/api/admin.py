"""Admin API — user management, permissions, sync status."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import AccessLog, Permission, SyncState, Tool, User
from ..db.session import get_db
from ..middleware.auth import require_role

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

class UserUpdateRequest(BaseModel):
    role: str | None = None
    status: str | None = None


@router.get("/users")
async def list_users(
    _user: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "status": u.status,
            "collector_token": u.collector_token,
            "created_at": u.created_at.isoformat(),
        }
        for u in users
    ]


@router.post("/users/{user_id}/approve")
async def approve_user(
    user_id: uuid.UUID,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404)
    import secrets
    user.status = "active"
    if user.role == "pending":
        user.role = "viewer"
    if not user.collector_token:
        user.collector_token = secrets.token_hex(32)
    return {
        "status": "approved",
        "user_id": str(user.id),
        "collector_token": user.collector_token,
        "role": user.role,
    }


@router.put("/users/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    req: UserUpdateRequest,
    _admin: User = Depends(require_role("owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404)
    if req.role:
        user.role = req.role
    if req.status:
        user.status = req.status
    return {"status": "updated", "user_id": str(user.id)}


# ---------------------------------------------------------------------------
# Permissions
# ---------------------------------------------------------------------------

class GrantPermissionRequest(BaseModel):
    user_id: str
    project_id: str | None = None
    tool_id: str | None = None
    permission: str = "read"


@router.get("/permissions")
async def list_permissions(
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await db.execute(select(Permission).order_by(Permission.created_at.desc()))
    perms = result.scalars().all()
    return [
        {
            "id": str(p.id),
            "user_id": str(p.user_id),
            "project_id": str(p.project_id) if p.project_id else None,
            "tool_id": p.tool_id,
            "permission": p.permission,
            "created_at": p.created_at.isoformat(),
        }
        for p in perms
    ]


@router.post("/permissions/grant")
async def grant_permission(
    req: GrantPermissionRequest,
    admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    perm = Permission(
        user_id=uuid.UUID(req.user_id),
        project_id=uuid.UUID(req.project_id) if req.project_id else None,
        tool_id=req.tool_id,
        permission=req.permission,
        granted_by=admin.id,
    )
    db.add(perm)
    await db.flush()
    return {"status": "granted", "permission_id": str(perm.id)}


@router.delete("/permissions/{perm_id}")
async def revoke_permission(
    perm_id: uuid.UUID,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await db.execute(select(Permission).where(Permission.id == perm_id))
    perm = result.scalar_one_or_none()
    if not perm:
        raise HTTPException(status_code=404)
    await db.delete(perm)
    return {"status": "revoked"}


# ---------------------------------------------------------------------------
# Sync status
# ---------------------------------------------------------------------------

@router.get("/sync/status")
async def sync_status(
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await db.execute(
        select(Tool).order_by(Tool.display_name)
    )
    tools = result.scalars().all()

    states = []
    for t in tools:
        sync_result = await db.execute(
            select(SyncState)
            .where(SyncState.tool_id == t.id)
            .order_by(SyncState.last_synced_at.desc())
            .limit(1)
        )
        latest = sync_result.scalar_one_or_none()
        states.append({
            "tool_id": t.id,
            "display_name": t.display_name,
            "total_files": t.total_files,
            "last_sync_at": t.last_sync_at.isoformat() if t.last_sync_at else None,
            "latest_file": latest.relative_path if latest else None,
        })

    return states


# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

@router.get("/audit-log")
async def get_audit_log(
    limit: int = 100,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    result = await db.execute(
        select(AccessLog).order_by(AccessLog.created_at.desc()).limit(limit)
    )
    logs = result.scalars().all()
    return [
        {
            "id": l.id,
            "user_id": str(l.user_id) if l.user_id else None,
            "document_id": str(l.document_id) if l.document_id else None,
            "action": l.action,
            "ip_address": l.ip_address,
            "created_at": l.created_at.isoformat(),
        }
        for l in logs
    ]
