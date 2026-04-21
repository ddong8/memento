"""Permission service — checks user access to documents and projects."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..db.models import Document, Permission, Project, User


async def can_view_document(
    db: AsyncSession, user: User | None, doc: Document,
) -> bool:
    """Check if a user can view a document."""
    # Public documents are visible to everyone
    if doc.visibility == "public":
        return True

    # In debug/dev mode, allow anonymous read access
    if settings.debug or not settings.secret_key or settings.secret_key == "change-me-in-production":
        return True

    # No user = no access to non-public
    if user is None:
        return False

    # Owner/admin can see everything
    if user.role in ("owner", "admin"):
        return True

    # Check project-level permission
    if doc.project_id:
        return await _has_project_permission(db, user.id, doc.project_id, doc.tool_id)

    # Check tool-level permission
    return await _has_tool_permission(db, user.id, doc.tool_id)


async def can_view_project(
    db: AsyncSession, user: User | None, project: Project,
) -> bool:
    """Check if a user can view a project."""
    if project.visibility == "public":
        return True
    if user is None:
        return False
    if user.role in ("owner", "admin"):
        return True
    return await _has_project_permission(db, user.id, project.id, project.tool_id)


async def _has_project_permission(
    db: AsyncSession, user_id: uuid.UUID, project_id: uuid.UUID, tool_id: str | None,
) -> bool:
    """Check if user has explicit permission for a project or its tool."""
    result = await db.execute(
        select(Permission).where(
            Permission.user_id == user_id,
            (Permission.project_id == project_id) | (Permission.project_id.is_(None)),
            (Permission.tool_id == tool_id) | (Permission.tool_id.is_(None)),
        ).limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _has_tool_permission(
    db: AsyncSession, user_id: uuid.UUID, tool_id: str,
) -> bool:
    """Check if user has permission for a tool (any project)."""
    result = await db.execute(
        select(Permission).where(
            Permission.user_id == user_id,
            (Permission.tool_id == tool_id) | (Permission.tool_id.is_(None)),
        ).limit(1)
    )
    return result.scalar_one_or_none() is not None
