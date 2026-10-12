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


async def find_machine_by_id_or_hash(
    db: AsyncSession, device_id: str | None, user: User | None = None
) -> Machine | None:
    """Find a machine by collector_token_hash, machine name, or UUID id, verifying ownership for non-admin users."""
    if not device_id or device_id in ("auto", "ask_only", "all"):
        return None

    from sqlalchemy import or_

    base_name = normalize_device_name(device_id)
    name_candidates = {device_id}
    if base_name:
        name_candidates.update({
            base_name,
            f"{base_name} (Darwin)",
            f"{base_name} (Windows)",
            f"{base_name} (Linux)",
        })

    # Try matching collector_token_hash or name
    conditions = [
        Machine.collector_token_hash == device_id,
        Machine.name.in_(name_candidates),
    ]
    if base_name:
        conditions.append(Machine.name.ilike(f"{base_name}%"))

    stmt = select(Machine).where(or_(*conditions)).order_by(
        Machine.merged_into.is_(None).desc(),
        Machine.last_heartbeat.desc().nullslast(),
    )
    if user and user.role not in ("admin", "owner"):
        stmt = stmt.where(Machine.user_id == user.id)
    m = (await db.execute(stmt)).scalars().first()
    if m:
        if m.merged_into is not None:
            from .device_merge import resolve_merged
            return await resolve_merged(db, m)
        return m

    # Fallback: try by UUID primary key
    try:
        uid = uuid.UUID(device_id)
        stmt = select(Machine).where(Machine.id == uid)
        if user and user.role not in ("admin", "owner"):
            stmt = stmt.where(Machine.user_id == user.id)
        m = (await db.execute(stmt)).scalars().first()
        if m is not None and m.merged_into is not None:
            from .device_merge import resolve_merged
            return await resolve_merged(db, m)
        return m
    except (ValueError, AttributeError):
        return None


def normalize_device_name(name: str | None) -> str:
    """Strip platform suffixes like ' (Darwin)', ' (Windows)', ' (Linux)'."""
    if not name:
        return ""
    for suffix in (" (Darwin)", " (Windows)", " (Linux)"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name

