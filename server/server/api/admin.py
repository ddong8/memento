"""Admin API — user management, permissions, sync status, audit log, invites."""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    AccessLog, ConversationMessage, Document, DocumentEmbedding, DocumentVersion,
    InviteCode, KnowledgeEntity, KnowledgeObservation, KnowledgeRelation,
    Machine, Permission, Project, SyncState, Tool, User,
)
from ..db.session import get_db
from ..middleware.auth import require_role

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Valid values for User.role and User.status. Anything else rejected by update_user.
_VALID_ROLES = {"pending", "viewer", "admin", "owner"}
_VALID_STATUSES = {"pending", "active", "disabled"}


# ---------------------------------------------------------------------------
# User listing / approval / edit
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
    caller: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Edit role / status. owner-only can promote to owner; admin can only set
    viewer/admin or toggle active/disabled. Anyone (admin+) can approve pending."""
    if req.role and req.role not in _VALID_ROLES:
        raise HTTPException(status_code=400, detail=f"role must be one of {sorted(_VALID_ROLES)}")
    if req.status and req.status not in _VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(_VALID_STATUSES)}")
    if req.role == "owner" and caller.role != "owner":
        raise HTTPException(status_code=403, detail="only owner can promote to owner")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404)

    # Safety net: don't let an admin accidentally disable the last active owner.
    if req.status == "disabled" and user.role == "owner":
        other_owners = await db.execute(
            select(User).where(User.role == "owner", User.status == "active", User.id != user_id)
        )
        if not other_owners.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="cannot disable the last active owner")

    if req.role:
        user.role = req.role
    if req.status:
        user.status = req.status
    return {"status": "updated", "user_id": str(user.id), "role": user.role, "user_status": user.status}


@router.post("/users/{user_id}/rotate-collector-token")
async def admin_rotate_user_token(
    user_id: uuid.UUID,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Admin-initiated token rotation for another user (e.g. device lost / suspected leak).
    Old token instantly invalidated; affected user must re-run `memento-collector setup`."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404)
    user.collector_token = secrets.token_hex(32)
    return {"status": "rotated", "user_id": str(user.id), "collector_token": user.collector_token}


@router.post("/users/{user_id}/transfer-ownership")
async def transfer_ownership(
    user_id: uuid.UUID,
    keep_self_as: str = "admin",
    caller: User = Depends(require_role("owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Promote target user to owner; caller downgrades to `keep_self_as` (default admin).
    Pass keep_self_as=owner to keep multi-owner mode. Target must already be active."""
    if keep_self_as not in {"owner", "admin", "viewer"}:
        raise HTTPException(status_code=400, detail="keep_self_as must be owner / admin / viewer")
    if user_id == caller.id:
        raise HTTPException(status_code=400, detail="cannot transfer to yourself")

    result = await db.execute(select(User).where(User.id == user_id))
    target = result.scalar_one_or_none()
    if not target:
        raise HTTPException(status_code=404)
    if target.status != "active":
        raise HTTPException(status_code=400, detail="target user must be active")

    target.role = "owner"
    caller_current = await db.get(User, caller.id)
    if caller_current:
        caller_current.role = keep_self_as
    return {
        "status": "transferred",
        "new_owner": str(target.id),
        "caller_role": keep_self_as,
    }


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: uuid.UUID,
    caller: User = Depends(require_role("owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete user + cascade their machines/documents/embeddings/knowledge.
    Only owner can do this. Cannot delete yourself; cannot delete the last owner."""
    if user_id == caller.id:
        raise HTTPException(status_code=400, detail="cannot delete yourself")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404)

    if user.role == "owner":
        others = await db.execute(
            select(User).where(User.role == "owner", User.id != user_id).limit(1)
        )
        if not others.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="cannot delete the only owner")

    # Cascade through the user's machines → documents → everything
    machine_ids = [r[0] for r in (await db.execute(
        select(Machine.id).where(Machine.user_id == user_id)
    )).all()]
    docs_deleted = 0
    for mid in machine_ids:
        doc_ids = [r[0] for r in (await db.execute(
            select(Document.id).where(Document.machine_id == mid)
        )).all()]
        docs_deleted += len(doc_ids)
        for i in range(0, len(doc_ids), 500):
            batch = doc_ids[i:i + 500]
            await db.execute(delete(AccessLog).where(AccessLog.document_id.in_(batch)))
            await db.execute(delete(ConversationMessage).where(ConversationMessage.document_id.in_(batch)))
            await db.execute(delete(DocumentVersion).where(DocumentVersion.document_id.in_(batch)))
            await db.execute(delete(DocumentEmbedding).where(DocumentEmbedding.document_id.in_(batch)))
            await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.source_document_id.in_(batch)))
            await db.execute(delete(Document).where(Document.id.in_(batch)))
        await db.execute(delete(SyncState).where(SyncState.machine_id == mid))

    if machine_ids:
        await db.execute(delete(Machine).where(Machine.id.in_(machine_ids)))

    # User-scoped knowledge entities
    ent_ids = [r[0] for r in (await db.execute(
        select(KnowledgeEntity.id).where(KnowledgeEntity.user_id == user_id)
    )).all()]
    if ent_ids:
        await db.execute(delete(KnowledgeRelation).where(
            KnowledgeRelation.source_id.in_(ent_ids) | KnowledgeRelation.target_id.in_(ent_ids)
        ))
        await db.execute(delete(KnowledgeObservation).where(KnowledgeObservation.entity_id.in_(ent_ids)))
        await db.execute(delete(KnowledgeEntity).where(KnowledgeEntity.id.in_(ent_ids)))

    # Orphaned projects (had docs only from this user's machines)
    orphan_projects = [r[0] for r in (await db.execute(
        select(Project.id).where(
            ~Project.id.in_(select(Document.project_id).where(Document.project_id.isnot(None)))
        )
    )).all()]
    if orphan_projects:
        await db.execute(delete(Project).where(Project.id.in_(orphan_projects)))

    # Permissions granted by / to this user
    # (Permission.user_id has ON DELETE CASCADE already; granted_by is SET NULL via nullable FK)
    # We could null out AccessLog.user_id to preserve audit — but simpler to drop them.
    await db.execute(delete(AccessLog).where(AccessLog.user_id == user_id))

    await db.execute(delete(User).where(User.id == user_id))

    return {
        "status": "deleted",
        "user_id": str(user_id),
        "machines_deleted": len(machine_ids),
        "documents_deleted": docs_deleted,
        "knowledge_entities_deleted": len(ent_ids),
        "orphaned_projects_deleted": len(orphan_projects),
    }


# ---------------------------------------------------------------------------
# Invite codes — enable invite-only registration
# ---------------------------------------------------------------------------

class InviteCreateRequest(BaseModel):
    max_uses: int = 1
    expires_days: int | None = None
    role_on_accept: str = "viewer"  # viewer | admin (owner refused)
    note: str | None = None


@router.get("/invites")
async def list_invites(
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = (await db.execute(select(InviteCode).order_by(InviteCode.created_at.desc()))).scalars().all()
    return [
        {
            "id": str(r.id),
            "code": r.code,
            "max_uses": r.max_uses,
            "use_count": r.use_count,
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "role_on_accept": r.role_on_accept,
            "note": r.note,
            "created_by": str(r.created_by) if r.created_by else None,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.post("/invites")
async def create_invite(
    req: InviteCreateRequest,
    admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if req.role_on_accept not in {"viewer", "admin"}:
        raise HTTPException(status_code=400, detail="role_on_accept must be viewer or admin")
    if req.max_uses < 1 or req.max_uses > 1000:
        raise HTTPException(status_code=400, detail="max_uses out of range (1..1000)")

    expires_at = None
    if req.expires_days is not None:
        from datetime import timedelta
        expires_at = datetime.now(timezone.utc) + timedelta(days=req.expires_days)

    invite = InviteCode(
        code=secrets.token_urlsafe(12),  # ~16 chars, URL-safe
        max_uses=req.max_uses,
        role_on_accept=req.role_on_accept,
        expires_at=expires_at,
        note=req.note,
        created_by=admin.id,
    )
    db.add(invite)
    await db.flush()
    return {
        "id": str(invite.id),
        "code": invite.code,
        "max_uses": invite.max_uses,
        "expires_at": invite.expires_at.isoformat() if invite.expires_at else None,
        "role_on_accept": invite.role_on_accept,
    }


@router.delete("/invites/{invite_id}")
async def revoke_invite(
    invite_id: uuid.UUID,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    result = await db.execute(select(InviteCode).where(InviteCode.id == invite_id))
    invite = result.scalar_one_or_none()
    if not invite:
        raise HTTPException(status_code=404)
    await db.delete(invite)
    return {"status": "revoked"}


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
    if req.permission not in {"read", "write"}:
        raise HTTPException(status_code=400, detail="permission must be read or write")
    if not req.project_id and not req.tool_id:
        raise HTTPException(status_code=400, detail="project_id or tool_id required")
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
    offset: int = 0,
    user_id: uuid.UUID | None = None,
    action: str | None = None,
    _admin: User = Depends(require_role("admin", "owner")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    q = select(AccessLog).order_by(AccessLog.created_at.desc())
    if user_id:
        q = q.where(AccessLog.user_id == user_id)
    if action:
        q = q.where(AccessLog.action == action)
    rows = (await db.execute(q.limit(limit).offset(offset))).scalars().all()
    return {
        "items": [
            {
                "id": l.id,
                "user_id": str(l.user_id) if l.user_id else None,
                "document_id": str(l.document_id) if l.document_id else None,
                "action": l.action,
                "ip_address": l.ip_address,
                "created_at": l.created_at.isoformat(),
            }
            for l in rows
        ],
        "limit": limit,
        "offset": offset,
    }
