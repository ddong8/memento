"""Device service — registers and updates collector devices."""

from __future__ import annotations

from datetime import datetime, timezone

from passlib.hash import sha256_crypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import Machine


async def ensure_device(
    db: AsyncSession,
    device_id: str,
    device_name: str,
    device_platform: str,
    user_id: "uuid.UUID | None" = None,
) -> Machine:
    """Find or create a machine record for this device."""
    import uuid
    result = await db.execute(
        select(Machine).where(Machine.collector_token_hash == device_id)
    )
    machine = result.scalar_one_or_none()
    now = datetime.now(timezone.utc)

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
        # Bind to user if not already bound
        if user_id and not machine.user_id:
            machine.user_id = user_id

    return machine


async def list_devices(db: AsyncSession) -> list[Machine]:
    """List all registered devices."""
    result = await db.execute(
        select(Machine).order_by(Machine.last_heartbeat.desc())
    )
    return list(result.scalars().all())
