"""FastAPI application entry point."""

from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import admin, auth, conversations, daily, dashboard, data_io, devices, documents, events, hierarchy, ingest, install_bootstrap, memory, projects, public, search, share, tools
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

    # Document.embedding_status + embedding_attempts: tracks whether the
    # embedding pipeline produced vectors so failures can be retried instead
    # of silently dropped. Existing rows get 'ok' if they already have any
    # embedding rows, else 'pending' — the periodic retry task picks those up.
    doc_cols = {c["name"] for c in insp.get_columns("documents")}
    if "embedding_status" not in doc_cols:
        conn.execute(text(
            "ALTER TABLE documents ADD COLUMN embedding_status VARCHAR(20) "
            "NOT NULL DEFAULT 'pending'"
        ))
        # Classify existing rows so retry loop (which scans 'failed' only)
        # picks up historical ingest failures without blasting the embedding
        # server with docs that were legitimately skipped.
        conn.execute(text(
            "UPDATE documents SET embedding_status = 'ok' "
            "WHERE id IN (SELECT DISTINCT document_id FROM document_embeddings)"
        ))
        conn.execute(text(
            "UPDATE documents SET embedding_status = 'skipped' "
            "WHERE embedding_status = 'pending' "
            "AND (content IS NULL OR LENGTH(content) < 100 "
            "     OR content_type IN ('sqlite', 'sqlite_export', 'binary'))"
        ))
        conn.execute(text(
            "UPDATE documents SET embedding_status = 'failed' "
            "WHERE embedding_status = 'pending'"
        ))
    if "embedding_attempts" not in doc_cols:
        conn.execute(text(
            "ALTER TABLE documents ADD COLUMN embedding_attempts INTEGER "
            "NOT NULL DEFAULT 0"
        ))

    # knowledge_status / knowledge_attempts: same pattern as the embedding
    # pair, added later to give a way to retry LLM extraction. Existing rows
    # get classified the same way: 'ok' when there's already at least one
    # observation pointing to them, 'skipped' for short/binary content,
    # everything else 'failed' so the knowledge_retry beat picks them up.
    if "knowledge_status" not in doc_cols:
        conn.execute(text(
            "ALTER TABLE documents ADD COLUMN knowledge_status VARCHAR(20) "
            "NOT NULL DEFAULT 'pending'"
        ))
        conn.execute(text(
            "UPDATE documents SET knowledge_status = 'ok' "
            "WHERE id IN (SELECT DISTINCT source_document_id FROM "
            "knowledge_observations WHERE source_document_id IS NOT NULL)"
        ))
        conn.execute(text(
            "UPDATE documents SET knowledge_status = 'skipped' "
            "WHERE knowledge_status = 'pending' "
            "AND (content IS NULL OR LENGTH(content) < 200 "
            "     OR category NOT IN ('conversation', 'memory', 'learning', 'plan'))"
        ))
        conn.execute(text(
            "UPDATE documents SET knowledge_status = 'failed' "
            "WHERE knowledge_status = 'pending'"
        ))
    if "knowledge_attempts" not in doc_cols:
        conn.execute(text(
            "ALTER TABLE documents ADD COLUMN knowledge_attempts INTEGER "
            "NOT NULL DEFAULT 0"
        ))

    # Document.content_tsv: tsvector of jieba-tokenized content+title for
    # full-text search fallback when the embedding server is slow/down. We
    # populate it from Python (jieba) on ingest; Postgres just stores +
    # indexes. Backfill is done by a one-shot script, not here, to avoid
    # blocking startup on large tables.
    if "content_tsv" not in doc_cols:
        conn.execute(text("ALTER TABLE documents ADD COLUMN content_tsv tsvector"))
    sp3 = conn.begin_nested()
    try:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_documents_content_tsv "
            "ON documents USING gin (content_tsv)"
        ))
        sp3.commit()
    except Exception:
        sp3.rollback()

    # DailySummary.user_id + swap unique index so each user has their own digest
    # per date+tool. Before this, the table was globally scoped and any user's
    # call to /generate-summary wrote a summary visible to every other user.
    if "daily_summaries" in tables:
        ds_cols = {c["name"] for c in insp.get_columns("daily_summaries")}
        if "user_id" not in ds_cols:
            conn.execute(text(
                "ALTER TABLE daily_summaries ADD COLUMN user_id UUID "
                "REFERENCES users(id) ON DELETE CASCADE"
            ))
        # Drop old (summary_date, tool_id) unique index if present; create the
        # user-scoped one. Wrapped in savepoints so the overall tx doesn't abort
        # if the old index name varies or already exists.
        for stmt in (
            "DROP INDEX IF EXISTS uq_daily_summary_date_tool",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_summary_user_date_tool "
            "ON daily_summaries (user_id, summary_date, tool_id)",
            "CREATE INDEX IF NOT EXISTS idx_daily_summary_user "
            "ON daily_summaries (user_id)",
        ):
            sp2 = conn.begin_nested()
            try:
                conn.execute(text(stmt))
                sp2.commit()
            except Exception:
                sp2.rollback()

    # ShareLink.target_user_id: when set, the share is only viewable by that
    # logged-in user (vs the legacy "anyone with the link" public default).
    # Lets owners forward project timelines / dailies / memory to specific
    # viewer accounts without exposing them anonymously.
    if "share_links" in tables:
        sl_cols = {c["name"] for c in insp.get_columns("share_links")}
        if "target_user_id" not in sl_cols:
            conn.execute(text(
                "ALTER TABLE share_links ADD COLUMN target_user_id UUID "
                "REFERENCES users(id) ON DELETE CASCADE"
            ))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_share_target_user "
                "ON share_links (target_user_id)"
            ))

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
        # Partial index for the daily / dashboard hot path: filter user+assistant
        # messages by recent timestamp. Without it the planner seq-scans the
        # whole 117K+ row conversation_messages table and cold-cache first hits
        # take ~6s; with it, the same query is <200ms cold.
        "CREATE INDEX IF NOT EXISTS idx_conv_msg_role_ts "
        "ON conversation_messages (role, timestamp DESC) "
        "WHERE role IN ('user', 'assistant')",
        "CREATE INDEX IF NOT EXISTS idx_documents_tool_synced ON documents (tool_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_project_synced ON documents (project_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_project_category ON documents (project_id, category)",
        "CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_documents_path_trgm ON documents USING gin (relative_path gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops)",
        # Vector ANN index for semantic search. Without this, /api/memory/semantic
        # seq-scans document_embeddings — fine at 50 rows, fatal at 1M. HNSW
        # preferred over IVFFlat: no training step, better recall, pgvector
        # 0.5+ required. Dim must match Vector(1024) in DocumentEmbedding.
        "CREATE INDEX IF NOT EXISTS idx_doc_embedding_hnsw "
        "ON document_embeddings USING hnsw (embedding vector_cosine_ops)",
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


async def _warm_embedding_server() -> None:
    """Send a single tiny encode request shortly after boot so the first
    real /api/memory/semantic call doesn't pay the BGE-M3 model's
    first-encode cost (model is loaded at embedding-server startup but
    the actual encode pipeline has JIT/cache warmup that can push 5-10 s
    on a cold CPU). 5 s delay lets the api itself finish lifespan first.
    """
    import asyncio, logging
    log = logging.getLogger("memento.warmup")
    await asyncio.sleep(5)
    try:
        from .services.embedding_service import _call_embedding_server
        v = await _call_embedding_server(["warmup"], timeout=30.0)
        if v and v[0]:
            log.info("embedding server warmed (dim=%d)", len(v[0]))
        else:
            log.info("embedding server warmup returned empty — service likely down")
    except Exception as e:
        log.info("embedding warmup skipped: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import asyncio
    settings.validate_production()
    async with engine.begin() as conn:
        await conn.run_sync(_run_migrations)
        await conn.run_sync(Base.metadata.create_all)
    # Start daily compaction in background
    compaction_task = asyncio.create_task(_schedule_daily_compaction())
    # Fire-and-forget warmup of the embedding server (5s after boot)
    warmup_task = asyncio.create_task(_warm_embedding_server())
    yield
    compaction_task.cancel()
    warmup_task.cancel()
    await engine.dispose()


app = FastAPI(
    title="Memento",
    description="A shared brain for your AI coding tools — collects, indexes and surfaces conversations, memory, plans across every AI IDE and every device.",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — regex source is settings.cors_allow_origin_regex (see config.py).
# Self-hosted deployments on LAN IPs (192.168.x / 10.x / 172.16-31.x) are
# allowed by default; users with a public custom domain set
# MEMENTO_CORS_ALLOW_ORIGIN_REGEX in .env.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=settings.cors_allow_origin_regex,
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
app.include_router(share.router)
app.include_router(data_io.router)

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
