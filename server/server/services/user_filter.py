"""User data isolation — filter queries to only show data from user's devices."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine, User


async def user_machine_ids(db: AsyncSession, user: User) -> list[uuid.UUID] | None:
    """Return list of machine IDs belonging to the user.

    Returns None for admin/owner (no filtering needed — they see everything).
    Returns empty list if user has no devices (sees nothing).
    """
    if user.role in ("admin", "owner"):
        return None
    result = await db.execute(
        select(Machine.id).where(Machine.user_id == user.id)
    )
    return [r[0] for r in result.all()]


def apply_user_filter(query, machine_ids: list[uuid.UUID] | None, machine_id_col):
    """Apply user device filter to a query. No-op for admin/owner (machine_ids=None)."""
    if machine_ids is None:
        return query
    return query.where(machine_id_col.in_(machine_ids))
