"""FastAPI application entry point."""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import admin, auth, conversations, daily, dashboard, devices, documents, events, hierarchy, ingest, install_bootstrap, memory, projects, public, search, tools
from .config import settings
from .db.models import Base
from .db.session import engine


def _run_migrations(conn) -> None:
    """Add missing columns to existing tables (lightweight migration)."""
    import secrets
    from sqlalchemy import text, inspect
    insp = inspect(conn)

    # Enable pgvector extension
    try:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    except Exception:
        pass  # May not have pgvector installed

    tables = insp.get_table_names()
    if "machines" not in tables or "users" not in tables:
        return  # Fresh install — create_all will handle everything

    # Machine.user_id
    machine_cols = {c["name"] for c in insp.get_columns("machines")}
    if "user_id" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN user_id UUID REFERENCES users(id)"))

    # User.collector_token
    user_cols = {c["name"] for c in insp.get_columns("users")}
    if "collector_token" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN collector_token VARCHAR(64) UNIQUE"))

    # Data migration: assign owner token + bind existing machines to owner
    result = conn.execute(text(
        "SELECT id, collector_token FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1"
    ))
    owner = result.first()
    if owner:
        owner_id, owner_token = owner[0], owner[1]
        if not owner_token:
            token = secrets.token_hex(32)
            conn.execute(text(
                "UPDATE users SET collector_token = :token WHERE id = :uid AND collector_token IS NULL"
            ), {"token": token, "uid": owner_id})
        conn.execute(text("UPDATE machines SET user_id = :uid WHERE user_id IS NULL"),
                     {"uid": owner_id})

    # pg_trgm extension (required for trigram indexes below)
    sp = conn.begin_nested()
    try:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
        sp.commit()
    except Exception:
        sp.rollback()

    # Performance indexes (idempotent). Each runs in its own savepoint so a
    # single failure doesn't abort the whole migration tx.
    for stmt in (
        "CREATE INDEX IF NOT EXISTS idx_conv_msg_timestamp ON conversation_messages (timestamp)",
        "CREATE INDEX IF NOT EXISTS idx_conv_msg_doc_ts ON conversation_messages (document_id, timestamp)",
        "CREATE INDEX IF NOT EXISTS idx_documents_tool_synced ON documents (tool_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_project_synced ON documents (project_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_project_category ON documents (project_id, category)",
        "CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_documents_path_trgm ON documents USING gin (relative_path gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops)",
    ):
        sp = conn.begin_nested()
        try:
            conn.execute(text(stmt))
            sp.commit()
        except Exception:
            sp.rollback()


async def _schedule_daily_compaction():
    """Run memory compaction once per day in background."""
    import asyncio
    await asyncio.sleep(60)  # Wait for startup to complete
    while True:
        try:
            from .db.session import async_session_factory
            from .services.memory_compaction import run_compaction
            async with async_session_factory() as db:
                await run_compaction(db)
        except Exception as e:
            import logging
            logging.getLogger("compaction").info("Compaction skipped: %s", e)
        await asyncio.sleep(86400)  # Every 24 hours


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import asyncio
    settings.validate_production()
    async with engine.begin() as conn:
        await conn.run_sync(_run_migrations)
        await conn.run_sync(Base.metadata.create_all)
    # Start daily compaction in background
    compaction_task = asyncio.create_task(_schedule_daily_compaction())
    yield
    compaction_task.cancel()
    await engine.dispose()


app = FastAPI(
    title="Memento",
    description="A shared brain for your AI coding tools — collects, indexes and surfaces conversations, memory, plans across every AI IDE and every device.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(https?://localhost:\d+|https?://mem\.ihasy\.com)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register routers
app.include_router(dashboard.router)
app.include_router(ingest.router)
app.include_router(tools.router)
app.include_router(documents.router)
app.include_router(conversations.router)
app.include_router(projects.router)
app.include_router(daily.router)
app.include_router(search.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(events.router)
app.include_router(devices.router)
app.include_router(hierarchy.router)
app.include_router(memory.router)
app.include_router(install_bootstrap.router)
app.include_router(public.router)

# Mount MCP Memory Server (best-effort, skip if deps not available)
try:
    from .api.mcp_mount import mount_mcp
    mount_mcp(app)
except Exception:
    pass


@app.get("/")
async def root() -> dict:
    return {
        "name": "Memento",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}
