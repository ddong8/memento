"""Standalone DDL database migration runner for Kubernetes initContainer or deployment Jobs.

Decouples heavy schema migrations from fast-boot API pods to prevent table locks
and deadlocks during rolling updates in multi-replica deployments.
"""
from __future__ import annotations

import asyncio
import logging
from sqlalchemy import text

from .db.session import engine
from .db.models import Base
from .main import _run_migrations, _MIGRATION_LOCK_ID

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("memento.migrate")


async def run_migrations() -> None:
    logger.info("Starting Memento DDL database migrations...")
    async with engine.begin() as conn:
        try:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _MIGRATION_LOCK_ID})
            logger.info("Acquired PostgreSQL migration advisory lock (%s)", hex(_MIGRATION_LOCK_ID))
        except Exception as e:
            logger.warning("Advisory lock skipped (non-PostgreSQL or restricted): %s", e)

        await conn.run_sync(_run_migrations)
        await conn.run_sync(Base.metadata.create_all)

    logger.info("Memento DDL database migrations completed successfully.")


if __name__ == "__main__":
    asyncio.run(run_migrations())
