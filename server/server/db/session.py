"""Database session factory."""

from __future__ import annotations

import json
import os
import re
from collections.abc import AsyncGenerator
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from ..config import settings


def _env_int(name: str, default: int, *, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.environ.get(name, str(default))))
    except ValueError:
        return default

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
    # Postgres max_connections defaults to 200 in self-hosted deploys; with 2 API replicas +
    # celery-worker + celery-beat, cap each replica at 20+15=35 (primary) and 8+4=12 (post-ingest)
    # = 47 max/replica (~94 across 2 API pods), leaving comfortable headroom for workers & admin.
    # All sizes remain overridable via MEMENTO_DB_POOL_* env vars.
    pool_size=_env_int("MEMENTO_DB_POOL_SIZE", 20),
    max_overflow=_env_int("MEMENTO_DB_MAX_OVERFLOW", 15, minimum=0),
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
    pool_size=_env_int("MEMENTO_DB_POST_INGEST_POOL_SIZE", 8),
    max_overflow=_env_int("MEMENTO_DB_POST_INGEST_MAX_OVERFLOW", 4, minimum=0),
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
