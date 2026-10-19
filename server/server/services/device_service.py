"""Device service — registers and updates collector devices."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine


async def ensure_device(
    db: AsyncSession,
    device_id: str,
    device_name: str,
    device_platform: str,
    user_id: uuid.UUID | None = None,
) -> Machine:
    """Find or create a machine record for this device."""
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id)
    )
    machine = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)

    # An old device id of a computer whose records were merged: use the record it lives in now.
    if machine is not None and machine.merged_into is not None:
        from .device_merge import resolve_merged
        machine = await resolve_merged(db, machine)
        if machine is not None:
            machine.last_heartbeat = now
            return machine

    # If not found by collector_token_hash, check if an existing record exists for this user and machine name
    if machine is None and user_id and device_name:
        name_match = await db.execute(
            select(Machine)
            .where(Machine.name == device_name, Machine.user_id == user_id, Machine.merged_into.is_(None))
            .order_by(Machine.last_heartbeat.desc().nulls_last())
        )
        existing = name_match.scalars().first()
        if existing is not None:
            existing.collector_token_hash = device_id
            existing.last_heartbeat = now
            if getattr(existing, "is_archived", False):
                existing.is_archived = False
                existing.archived_at = None
            return existing

    if machine is None:
        machine = Machine(
            name=device_name,
            collector_token_hash=device_id,
            user_id=user_id,
            last_heartbeat=now,
        )
        db.add(machine)
        await db.flush()
    else:
        machine.name = device_name
        machine.last_heartbeat = now
        if getattr(machine, "is_archived", False):
            machine.is_archived = False
            machine.archived_at = None
        # Bind to user if not already bound
        if user_id and not machine.user_id:
            machine.user_id = user_id

    return machine
