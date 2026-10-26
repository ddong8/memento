"""FastAPI application entry point."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .middleware.etag import ETagMiddleware

from .api import admin, ask, auth, conversations, daily, dashboard, data_io, devices, documents, events, health, hierarchy, ingest, install_bootstrap, learning, life_rhythm, llm, media, memory, missions, notify, proactive, profile, projects, public, quotas, search, share, skills, todos, tools, updates
# Aliased: `server.api.tasks` (remote device task queue) is a different module
# from the `server.tasks` package (Celery jobs). Importing it bare here would
# read as the latter.
from .api import tasks as device_tasks_api
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
    if "merged_into" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN merged_into UUID REFERENCES machines(id)"))
    if "user_id" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN user_id UUID REFERENCES users(id)"))
    if "is_archived" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN is_archived BOOLEAN NOT NULL DEFAULT FALSE"))
    if "archived_at" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE"))

    # Machine.remote_exec_key — per-device secret for remote task execution.
    # Minted lazily on heartbeat when MEMENTO_REMOTE_EXEC is on, so existing
    # rows just stay NULL until then.
    if "remote_exec_key" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN remote_exec_key VARCHAR(64)"))

    # Machine.profile_targets / profile_status — resident-profile injection.
    if "profile_targets" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN profile_targets JSONB NOT NULL DEFAULT '[]'"))
    if "profile_status" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN profile_status JSONB NOT NULL DEFAULT '{}'"))
    if "skill_status" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN skill_status JSONB NOT NULL DEFAULT '{}'"))

    # CorrectionTopic.scope — a learned rule can hold in one project or on one device only.
    if "correction_topics" in tables:
        topic_cols = {c["name"] for c in insp.get_columns("correction_topics")}
        if "scope" not in topic_cols:
            conn.execute(text("ALTER TABLE correction_topics ADD COLUMN scope VARCHAR(200) NOT NULL DEFAULT 'global'"))

    # User.collector_token & wechat_openid
    user_cols = {c["name"] for c in insp.get_columns("users")}
    if "collector_token" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN collector_token VARCHAR(64) UNIQUE"))
    if "wechat_openid" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN wechat_openid VARCHAR(64) UNIQUE"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_wechat_openid ON users (wechat_openid)"))

    # DeviceTask.alerts — risky operations an agent performed during the task.
    if "device_tasks" in tables:
        task_cols = {c["name"] for c in insp.get_columns("device_tasks")}
        if "alerts" not in task_cols:
            conn.execute(text("ALTER TABLE device_tasks ADD COLUMN alerts JSONB NOT NULL DEFAULT '[]'"))
        # DeviceTask.events — steps of a structured agent run, for the task timeline.
        if "events" not in task_cols:
            conn.execute(text("ALTER TABLE device_tasks ADD COLUMN events JSONB NOT NULL DEFAULT '[]'"))

    # User.notify_settings — phone push (Bark) preferences.
    if "notify_settings" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN notify_settings JSONB NOT NULL DEFAULT '{}'"))
    # User.proactive_settings — 24/7 Always-on agent preferences (morning brief, evening reflection, quiet hours, auto-missions)
    if "proactive_settings" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN proactive_settings JSONB NOT NULL DEFAULT '{}'"))
    # User.llm_settings — User-customized LLM provider, base URL, keys, and model preferences
    if "llm_settings" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN llm_settings JSONB NOT NULL DEFAULT '{}'"))
    # User.avatar_settings — Digital twin avatar onboarding and styling settings
    if "avatar_settings" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN avatar_settings JSONB NOT NULL DEFAULT '{}'"))

    # AskConversation.config — stores tool/engine, project, session, model, effort, worktree, compact preferences.
    if "ask_conversations" in tables:
        ask_cols = {c["name"] for c in insp.get_columns("ask_conversations")}
        if "config" not in ask_cols:
            conn.execute(text("ALTER TABLE ask_conversations ADD COLUMN config JSONB NOT NULL DEFAULT '{}'"))
        if "message_count" not in ask_cols:
            conn.execute(text("ALTER TABLE ask_conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("UPDATE ask_conversations SET message_count = jsonb_array_length(turns)"))

    # User.github_id — GitHub OAuth login. Partial unique index: one account
    # per GitHub identity, while the many github_id IS NULL rows stay allowed.
    if "github_id" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN github_id VARCHAR(50)"))
    sp_gh = conn.begin_nested()
    try:
        conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_github_id "
            "ON users (github_id) WHERE github_id IS NOT NULL"
        ))
        sp_gh.commit()
    except Exception:
        sp_gh.rollback()

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
    # embedded_at / embedding_next_at: the embedding sweep embeds documents that went
    # quiet (or waited too long) and backs off after failures instead of giving up.
    if "embedded_at" not in doc_cols:
        conn.execute(text("ALTER TABLE documents ADD COLUMN embedded_at TIMESTAMPTZ"))
    if "embedding_next_at" not in doc_cols:
        conn.execute(text("ALTER TABLE documents ADD COLUMN embedding_next_at TIMESTAMPTZ"))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS ix_documents_embedding_due ON documents "
        "(embedding_status, embedding_next_at) WHERE embedding_status IN ('pending', 'failed')"
    ))
    conn.execute(text(
        "CREATE INDEX IF NOT EXISTS idx_documents_machine_synced ON documents "
        "(machine_id, synced_at DESC)"
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

    # DocumentEmbedding.embedding HNSW 向量索引：消除全表暴力余弦扫描，实现毫秒级 ANN 图检索
    if "document_embeddings" in tables:
        sp_hnsw = conn.begin_nested()
        try:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_doc_embedding_hnsw "
                "ON document_embeddings USING hnsw (embedding vector_cosine_ops) "
                "WITH (m = 16, ef_construction = 64)"
            ))
            sp_hnsw.commit()
        except Exception:
            sp_hnsw.rollback()

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
            "DROP INDEX IF EXISTS idx_daily_summary_user",
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_summary_user_date_tool "
            "ON daily_summaries (user_id, summary_date, tool_id)",
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

    # User memories (L3 Core Memory / MEMORY.md)
    if "user_memories" not in tables:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS user_memories (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category VARCHAR(50) NOT NULL DEFAULT 'general',
                key VARCHAR(120) NOT NULL,
                content TEXT NOT NULL,
                confidence FLOAT DEFAULT 1.0,
                source VARCHAR(50) DEFAULT 'dreaming',
                parent_id UUID REFERENCES user_memories(id) ON DELETE CASCADE,
                tree_path VARCHAR(255),
                is_folder BOOLEAN DEFAULT FALSE,
                last_recalled_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                CONSTRAINT uq_user_memory_key UNIQUE (user_id, category, key)
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memories (user_id, updated_at DESC)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_parent ON user_memories (user_id, parent_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_tree_path ON user_memories (user_id, tree_path)"))
    else:
        conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES user_memories(id) ON DELETE CASCADE"))
        conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS tree_path VARCHAR(255)"))
        conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS is_folder BOOLEAN DEFAULT FALSE"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_parent ON user_memories (user_id, parent_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_tree_path ON user_memories (user_id, tree_path)"))
    # Memory lifecycle. Outside the branch above: its CREATE TABLE predates these columns.
    conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS recall_count INTEGER NOT NULL DEFAULT 0"))
    conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'"))
    conn.execute(text("ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS status_reason TEXT"))
    conn.execute(text(
        "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS superseded_by UUID "
        "REFERENCES user_memories(id) ON DELETE SET NULL"
    ))
    conn.execute(text("CREATE INDEX IF NOT EXISTS idx_user_memory_status ON user_memories (user_id, status)"))

    # Dream journals (DREAMS.md)
    if "dream_journals" not in tables:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dream_journals (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                dream_date DATE NOT NULL,
                stage_metrics JSONB DEFAULT '{}',
                light_sleep_notes TEXT,
                rem_reflections TEXT,
                deep_consolidations TEXT,
                report_markdown TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS idx_dream_journal_user_date ON dream_journals (user_id, dream_date, created_at DESC)"))

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
        "CREATE INDEX IF NOT EXISTS idx_conv_msg_doc_dialogue ON conversation_messages (document_id, line_number) WHERE role IN ('user', 'assistant')",
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
        "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name_trgm ON knowledge_entities USING gin (name gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_summary_trgm ON knowledge_entities USING gin (summary gin_trgm_ops)",
        "CREATE INDEX IF NOT EXISTS idx_device_tasks_user_active ON device_tasks (user_id, created_at DESC) WHERE status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')",
        "CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_synced ON document_versions (document_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_metadata_session_id ON documents (((metadata->>'session_id'))) WHERE (metadata->>'session_id') IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_documents_metadata_cascade_id ON documents (((metadata->>'cascade_id'))) WHERE (metadata->>'cascade_id') IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_machines_collector_token_hash ON machines (collector_token_hash)",
        "CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines (user_id)",
        # Re-extracting a document's knowledge first clears its observations by source document.
        "CREATE INDEX IF NOT EXISTS idx_observation_source_doc ON knowledge_observations (source_document_id)",
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

    # The trigram index on documents.content was never used by a query (search goes through
    # content_tsv), yet every synced conversation turn rewrote it: 1.2 GB that kept Postgres reading
    # from disk. Drop it where it still exists, without queueing behind busy writers for long.
    sp = conn.begin_nested()
    try:
        conn.execute(text("SET LOCAL lock_timeout = '5s'"))
        conn.execute(text("DROP INDEX IF EXISTS idx_documents_content_trgm"))
        conn.execute(text("SET LOCAL lock_timeout TO DEFAULT"))
        sp.commit()
    except Exception:
        sp.rollback()

    # These columns are rewritten whole on every synced turn (a 5 MB transcript ~1400 times in 9 hours).
    # Compressing one such value took pglz ~120 ms and lz4 ~22 ms, a third smaller too (measured on
    # production data, 2026-10-25). Only values written from now on use lz4; nothing is rewritten here.
    for table, column in (
        ("documents", "content"), ("documents", "content_tsv"), ("documents", "rendered_html"),
        ("ask_conversations", "turns"), ("conversation_messages", "content"),
    ):
        sp = conn.begin_nested()
        try:
            current = conn.execute(text(
                "SELECT attcompression::text FROM pg_attribute WHERE attrelid = CAST(:t AS regclass) AND attname = :c"
            ), {"t": table, "c": column}).scalar()
            if current is not None and current != "l":
                conn.execute(text("SET LOCAL lock_timeout = '5s'"))
                conn.execute(text(f"ALTER TABLE {table} ALTER COLUMN {column} SET COMPRESSION lz4"))
                conn.execute(text("SET LOCAL lock_timeout TO DEFAULT"))
            sp.commit()
        except Exception:
            sp.rollback()


async def _schedule_daily_compaction():
    """Run memory compaction once per day in background (on one replica: the
    first to get that day's lock)."""
    import asyncio
    from datetime import date
    from .services.cluster import cluster
    await asyncio.sleep(60)  # Wait for startup to complete
    while True:
        try:
            if await cluster.try_lock(f"compaction:{date.today().isoformat()}", 2 * 86400):
                from .db.session import async_session_factory
                from .services.memory_compaction import run_compaction
                async with async_session_factory() as db:
                    await run_compaction(db)
        except Exception as e:
            import logging
            logging.getLogger("compaction").info("Compaction skipped: %s", e)
        await asyncio.sleep(86400)  # Every 24 hours


async def _schedule_daily_dreaming():
    """Run Dreaming Memory Consolidation once per day in the background
    (coordinated across replicas via cluster lock), simulating biological sleep consolidation.
    """
    import asyncio
    from datetime import date
    from .services.cluster import cluster
    await asyncio.sleep(120)  # Wait for startup and warmup to settle
    while True:
        try:
            today_str = date.today().isoformat()
            if await cluster.try_lock(f"dreaming_consolidation:{today_str}", 2 * 86400):
                import logging
                log = logging.getLogger("dreaming.scheduler")
                log.info("Starting automated daily Dreaming consolidation for %s...", today_str)
                from .db.session import async_session_factory
                from .db.models import User
                from .services.dreaming_service import run_dreaming_pipeline
                from sqlalchemy import select
                async with async_session_factory() as db:
                    users = (await db.execute(select(User))).scalars().all()
                    for u in users:
                        try:
                            res = await run_dreaming_pipeline(db, u, target_date=None)
                            log.info("Dreaming pipeline finished for user %s: promoted=%s", u.id, res.get("promoted_memories_count"))
                        except Exception as user_err:
                            log.warning("Dreaming pipeline failed for user %s: %s", u.id, user_err)
        except Exception as e:
            import logging
            logging.getLogger("dreaming.scheduler").info("Daily dreaming skipped: %s", e)
        await asyncio.sleep(86400)


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


async def _warmup_jieba() -> None:
    """Pre-initialize jieba CJK token dictionary in background thread.

    Jieba loads a 20MB dictionary file and builds a prefix Trie on first cut.
    Warming it up at boot avoids a 1-2s freeze on the first search or ingest.
    """
    import asyncio, logging
    log = logging.getLogger("memento.warmup")
    try:
        def _init():
            try:
                import jieba
                jieba.initialize()
                return True
            except ImportError:
                return False

        loaded = await asyncio.to_thread(_init)
        if loaded:
            log.info("jieba prefix dictionary preloaded")
    except Exception as e:
        log.info("jieba warmup skipped: %s", e)


async def _merge_device_records() -> None:
    """Fold device records left behind by a changed device id (see services/device_merge.py).

    Runs in the background after startup so a slow merge never delays serving.
    """
    import logging
    log = logging.getLogger("memento.devices")
    try:
        from .db.session import async_session_factory
        from .services.cluster import cluster
        from .services.device_merge import merge_duplicate_machines
        if not await cluster.try_lock("merge-device-records", 600):
            return  # another replica that just started is doing it
        async with async_session_factory() as db:
            merged = await merge_duplicate_machines(db)
        for m in merged:
            log.warning("merged device record %s (%s) into %s: moved %s, kept %s",
                        m["from"], m["name"], m["into"], m["moved_counts"], m["kept_counts"])
    except Exception as e:
        log.warning("device record merge skipped: %s", e)


# Taken for the migration transaction, so replicas starting together migrate one at a time
_MIGRATION_LOCK_ID = 0x6D656D656E746F  # "memento"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    import asyncio
    from sqlalchemy import text
    from .services.ask_runs import ask_runs
    from .services.cluster import cluster
    settings.validate_production()
    async with engine.begin() as conn:
        await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": _MIGRATION_LOCK_ID})
        await conn.run_sync(_run_migrations)
        await conn.run_sync(Base.metadata.create_all)
    # Coordination with the other api replicas (device connections, runs, locks)
    await cluster.start()
    # One computer, one device record: fold in records left behind by a changed device id.
    merge_task = asyncio.create_task(_merge_device_records())
    # Start daily compaction & dreaming consolidation in background
    compaction_task = asyncio.create_task(_schedule_daily_compaction())
    dreaming_task = asyncio.create_task(_schedule_daily_dreaming())
    # Fire-and-forget warmup of the embedding server and jieba tokenizer
    warmup_task = asyncio.create_task(_warm_embedding_server())
    jieba_task = asyncio.create_task(_warmup_jieba())
    # Start 24/7 Always-on Proactive Agent Pulse service
    from .services.pulse_service import start_proactive_pulse, stop_proactive_pulse
    await start_proactive_pulse()
    yield
    # Out of the load balancer by now: let ask runs finish while their readers
    # reattach through the other replicas, then leave.
    await ask_runs.drain(settings.shutdown_drain_seconds)
    await stop_proactive_pulse()
    compaction_task.cancel()
    dreaming_task.cancel()
    warmup_task.cancel()
    jieba_task.cancel()
    merge_task.cancel()
    await cluster.stop()
    from .services.ai_provider import close_shared_chat_client
    await close_shared_chat_client()
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
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(ETagMiddleware)

# Register routers
app.include_router(dashboard.router)
app.include_router(ingest.router)
app.include_router(tools.router)
app.include_router(documents.router)
app.include_router(conversations.router)
app.include_router(projects.router)
app.include_router(daily.router)
app.include_router(search.router)
app.include_router(device_tasks_api.router)
app.include_router(ask.router)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(events.router)
app.include_router(devices.router)
app.include_router(hierarchy.router)
app.include_router(memory.router)
app.include_router(profile.router)
app.include_router(llm.router)
app.include_router(notify.router)
app.include_router(health.router)
app.include_router(learning.router)
app.include_router(skills.router)
app.include_router(todos.router)
app.include_router(install_bootstrap.router)
app.include_router(media.router)
app.include_router(public.router)
app.include_router(share.router)
app.include_router(data_io.router)
app.include_router(updates.router)
app.include_router(missions.router)
app.include_router(proactive.router)
app.include_router(life_rhythm.router)
app.include_router(quotas.router)
app.include_router(quotas.compat_router)
app.include_router(quotas.raw_router)
app.include_router(quotas.raw_compat_router)

from .api.ask import get_agent_capabilities, get_agent_models

app.get("/api/agent/capabilities", tags=["agent"])(get_agent_capabilities)
app.get("/api/agent/models", tags=["agent"])(get_agent_models)


@app.get("/")
async def root() -> dict:
    return {
        "name": "Memento",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> dict:
    # version = the commit this image was built from; the deploy workflow waits for it to go live
    return {"status": "ok", "version": os.environ.get("MEMENTO_BUILD_SHA", "dev")}


@app.get("/health/deep")
async def health_deep():
    """Also checks Postgres and Redis, for the outside monitor: /health stays up while either is down.
    Not the readiness probe: a database hiccup must not take every replica out of the Service at once."""
    import asyncio

    from fastapi.responses import JSONResponse
    from sqlalchemy import text

    from .services.cache import redis_client

    async def db_ok() -> None:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def redis_ok() -> None:
        client = redis_client()
        if client is None or not await client.ping():
            raise RuntimeError("no redis client")

    checks: dict[str, str] = {}
    for name, probe in (("db", db_ok), ("redis", redis_ok)):
        try:
            await asyncio.wait_for(probe(), timeout=5)
            checks[name] = "ok"
        except Exception as e:
            checks[name] = f"error: {type(e).__name__}"
    ok = all(v == "ok" for v in checks.values())
    body = {"status": "ok" if ok else "degraded", "version": os.environ.get("MEMENTO_BUILD_SHA", "dev"), **checks}
    return JSONResponse(body, status_code=200 if ok else 503)
