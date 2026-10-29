"""Database session factory."""

from __future__ import annotations

import json
import re
from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from ..config import settings

# PostgreSQL can't store U+0000 at all: as a json/jsonb escape it fails with "unsupported Unicode
# escape sequence", as a raw byte in text with "invalid byte sequence". One such character in a
# tool's output (binary file contents, `strings`, a terminal dump) used to fail the whole write and
# lose a finished task's result and the conversation's turns. Every write drops it instead, as
# ingest already did for message text.
_JSON_NUL = re.compile(r"(?<!\\)((?:\\\\)*)\\u0000")  # the escape itself, not an escaped backslash before "u0000"


def json_dumps(value: Any) -> str:
    out = json.dumps(value)
    return _JSON_NUL.sub(r"\1", out) if "\\u0000" in out else out


def without_nul(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("\x00", "") if "\x00" in value else value
    if isinstance(value, tuple):
        return tuple(without_nul(v) for v in value)
    if isinstance(value, list):
        return [without_nul(v) for v in value]
    if isinstance(value, dict):
        return {k: without_nul(v) for k, v in value.items()}
    return value


def _strip_nul_params(conn, cursor, statement, parameters, context, executemany):
    return statement, without_nul(parameters)


def _guard(engine: AsyncEngine) -> AsyncEngine:
    event.listen(engine.sync_engine, "before_cursor_execute", _strip_nul_params, retval=True)
    return engine


engine = _guard(create_async_engine(
    settings.database_url,
    echo=settings.debug,
    json_serializer=json_dumps,
    # docker-compose.yml bumps Postgres max_connections to 200, so we have
    # ~50 connection budget per service across api / celery-worker /
    # celery-beat + admin/migration headroom. Pool 30+30=60 gives the
    # ingest semaphore (24 concurrent) breathing room when each ingest
    # holds a connection 1-3s while waiting on post-ingest queueing,
    # without starving the every-10s collector heartbeats + command polls.
    pool_size=30,
    max_overflow=30,
    pool_recycle=3600,
    pool_timeout=10,  # fail fast instead of stalling user requests 30s
    pool_pre_ping=True,  # drop connections Postgres or the network closed while pooled
))

# Separate engine for post-ingest (embedding + knowledge graph) so a re-sync
# storm can't starve the user-facing request pool. Smaller pool because
# post-ingest is already capped at 8 concurrent tasks via Semaphore.
post_ingest_engine = _guard(create_async_engine(
    settings.database_url,
    echo=False,
    json_serializer=json_dumps,
    pool_size=12,
    max_overflow=8,
    pool_recycle=3600,
    pool_timeout=15,
    pool_pre_ping=True,
))

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)

post_ingest_session_factory = async_sessionmaker(
    post_ingest_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that provides a database session."""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
