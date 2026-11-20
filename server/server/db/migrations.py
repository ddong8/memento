"""Versioned database schema migration runner.

Supports two execution modes:
1. Standalone pre-deploy CLI / Kubernetes Job:
       python -m server.db.migrations          # acquire advisory lock & migrate idempotently
       python -m server.db.migrations --check  # verify core tables and version table exist
2. Legacy auto-migrate on API startup when MEMENTO_SKIP_DDL_MIGRATIONS is unset.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from .models import Base

logger = logging.getLogger("server.migrations")

# Taken for the migration transaction so replicas starting together migrate one at a time
MIGRATION_LOCK_ID = 0x6D656D656E746F  # "memento"
CURRENT_SCHEMA_VERSION = "20261120_001_baseline"


def _record_schema_version(conn, version: str = CURRENT_SCHEMA_VERSION) -> None:
    """Create schema_migrations tracking table and record applied version idempotently."""
    conn.execute(text(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        " version VARCHAR(64) PRIMARY KEY,"
        " applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    ))
    conn.execute(
        text(
            "INSERT INTO schema_migrations (version) VALUES (:v) "
            "ON CONFLICT (version) DO NOTHING"
        ),
        {"v": version},
    )


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
    # Opt-out instead of opt-in (2026-11-17): every device injects into all its installed tools
    if "profile_targets_off" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN profile_targets_off JSONB NOT NULL DEFAULT '[]'"))
    if "profile_status" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN profile_status JSONB NOT NULL DEFAULT '{}'"))
    if "skill_status" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN skill_status JSONB NOT NULL DEFAULT '{}'"))
    if "collect_status" not in machine_cols:
        conn.execute(text("ALTER TABLE machines ADD COLUMN collect_status JSONB NOT NULL DEFAULT '{}'"))

    # SyncState.last_end_offset: where the collector's last slice of a file ended
    if "sync_state" in tables:
        sync_cols = {c["name"] for c in insp.get_columns("sync_state")}
        if "last_end_offset" not in sync_cols:
            conn.execute(text("ALTER TABLE sync_state ADD COLUMN last_end_offset BIGINT"))
        # A file of a project the user stopped collecting: its slices are taken and dropped (project_exclusion)
        if "excluded_project" not in sync_cols:
            conn.execute(text("ALTER TABLE sync_state ADD COLUMN excluded_project VARCHAR(255)"))

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
        # DeviceTask.session_id — the agent session the device reports it ran.
        if "session_id" not in task_cols:
            conn.execute(text("ALTER TABLE device_tasks ADD COLUMN session_id VARCHAR(128)"))

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
    # User.collect_settings — projects the user doesn't want collected (project_exclusion)
    if "collect_settings" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN collect_settings JSONB NOT NULL DEFAULT '{}'"))

    # AskConversation.config — stores tool/engine, project, session, model, effort, worktree, compact preferences.
    if "ask_conversations" in tables:
        ask_cols = {c["name"] for c in insp.get_columns("ask_conversations")}
        if "config" not in ask_cols:
            conn.execute(text("ALTER TABLE ask_conversations ADD COLUMN config JSONB NOT NULL DEFAULT '{}'"))
        if "message_count" not in ask_cols:
            conn.execute(text("ALTER TABLE ask_conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0"))
            conn.execute(text("UPDATE ask_conversations SET message_count = jsonb_array_length(turns)"))

    # User.oidc_subject — single sign-on identity (api/sso.py); one account per identity
    if "oidc_subject" not in user_cols:
        conn.execute(text("ALTER TABLE users ADD COLUMN oidc_subject VARCHAR(512)"))
    conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_oidc_subject ON users (oidc_subject) WHERE oidc_subject IS NOT NULL"
    ))

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

    # The full-text index (jieba tokens of title + content) lives in document_search, not on documents.
    # There, every sync re-inserted the row's lexemes into the GIN index: a sync changes synced_at, which
    # is indexed, so the update can't be HOT and every index gets the new row version. ~1300 lexemes a
    # document made changing a hash and a timestamp write 240 KB of WAL (7.3 GB in 12 days). On copies of
    # production rows, 300 such updates wrote 51 MB of WAL in 950 ms with the index, 1.2 MB in 15 ms
    # without (2026-11-08). Moving the existing vectors over takes ~15 s, once; the column on documents
    # stayed while replicas of the release before could still write it, and is dropped at the end.
    if "document_search" not in tables:
        conn.execute(text(
            "CREATE TABLE document_search ("
            " document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,"
            " content_tsv tsvector COMPRESSION lz4 NOT NULL)"
        ))
        if "content_tsv" in doc_cols:
            conn.execute(text(
                "INSERT INTO document_search (document_id, content_tsv) "
                "SELECT id, content_tsv FROM documents WHERE content_tsv IS NOT NULL"
            ))
        conn.execute(text("SET LOCAL maintenance_work_mem = '256MB'"))
        conn.execute(text("CREATE INDEX idx_document_search_tsv ON document_search USING gin (content_tsv)"))

    # DocumentEmbedding.embedding HNSW 向量索引：消除全表暴力余弦扫描，实现毫秒级 ANN 图检索。
    # 建在半精度上（models.embedding_half）：全精度索引 787 MB 装不进 512 MB 共享缓冲，冷查询要读盘。
    # 线上的表大，先 CREATE INDEX CONCURRENTLY 建好再发版，这里就只是确认存在。
    if "document_embeddings" in tables:
        sp_hnsw = conn.begin_nested()
        try:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_doc_embedding_hnsw_half "
                "ON document_embeddings USING hnsw (CAST(embedding AS HALFVEC(1024)) halfvec_cosine_ops) "
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
    # HNSW 向量索引：消除用户核心记忆语义检索暴力扫描，实现毫秒级 ANN 图索引搜索
    sp_um_hnsw = conn.begin_nested()
    try:
        conn.execute(text(
            "CREATE INDEX IF NOT EXISTS idx_user_memories_embedding_hnsw "
            "ON user_memories USING hnsw (embedding vector_cosine_ops)"
        ))
        sp_um_hnsw.commit()
    except Exception:
        sp_um_hnsw.rollback()

    # Knowledge graph: merged same-name entities and summaries later conversations contradict
    if "knowledge_entities" in tables:
        conn.execute(text("ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb"))
        conn.execute(text("ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ"))
        conn.execute(text("ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS stale_reason TEXT"))

    # Retrieval eval: the quote that answers each question
    if "eval_cases" in tables:
        conn.execute(text("ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS evidence TEXT"))

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
        "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_search_trgm ON knowledge_entities USING gin ((name || ' ' || coalesce(summary, '')) gin_trgm_ops)",
        # entity_canon.find_entity: one entity per name however it is cased or hyphenated
        "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_norm_name ON knowledge_entities (user_id, regexp_replace(lower(name), '[-_\\s]+', '', 'g'))",
        "CREATE INDEX IF NOT EXISTS idx_device_tasks_user_active ON device_tasks (user_id, created_at DESC) WHERE status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')",
        "CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_synced ON document_versions (document_id, synced_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_documents_metadata_session_id ON documents (((metadata->>'session_id'))) WHERE (metadata->>'session_id') IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_documents_metadata_cascade_id ON documents (((metadata->>'cascade_id'))) WHERE (metadata->>'cascade_id') IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_machines_collector_token_hash ON machines (collector_token_hash)",
        "CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines (user_id)",
        # Re-extracting a document's knowledge first clears its observations by source document.
        "CREATE INDEX IF NOT EXISTS idx_observation_source_doc ON knowledge_observations (source_document_id)",
        "CREATE INDEX IF NOT EXISTS idx_observation_entity_observed ON knowledge_observations (entity_id, observed_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_observation_entity_source ON knowledge_observations (entity_id, source_document_id)",
        "CREATE INDEX IF NOT EXISTS idx_ask_conv_session_id ON ask_conversations (((config->>'session_id'))) WHERE (config->>'session_id') IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_ask_conv_user_device ON ask_conversations (user_id, device_id, updated_at DESC)",
        "CREATE INDEX IF NOT EXISTS idx_device_tasks_status_created ON device_tasks (status, created_at) WHERE status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')",
        # Vector ANN index for semantic search. Without this, /api/memory/semantic
        # seq-scans document_embeddings — fine at 50 rows, fatal at 1M. HNSW
        # preferred over IVFFlat: no training step, better recall, pgvector
        # 0.7+ required for halfvec. Dim must match EMBEDDING_INDEX_DIM in models.
        "CREATE INDEX IF NOT EXISTS idx_doc_embedding_hnsw_half "
        "ON document_embeddings USING hnsw (CAST(embedding AS HALFVEC(1024)) halfvec_cosine_ops) "
        "WITH (m = 16, ef_construction = 64)",
        # UserMemory HNSW 图向量索引，实现毫秒级记忆召回
        "CREATE INDEX IF NOT EXISTS idx_user_memories_embedding_hnsw "
        "ON user_memories USING hnsw (embedding vector_cosine_ops)",
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

    # Searches order by the half-precision index since 10-27: the full-precision one is no longer read,
    # yet every new chunk still updated it. Drop it once its replacement is built and valid.
    sp = conn.begin_nested()
    try:
        half_ready = conn.execute(text(
            "SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid "
            "WHERE c.relname = 'idx_doc_embedding_hnsw_half'"
        )).scalar()
        if half_ready:
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text("DROP INDEX IF EXISTS idx_doc_embedding_hnsw"))
            conn.execute(text("SET LOCAL lock_timeout TO DEFAULT"))
        sp.commit()
    except Exception:
        sp.rollback()

    # These columns are rewritten whole on every synced turn (a 5 MB transcript ~1400 times in 9 hours).
    # Compressing one such value took pglz ~120 ms and lz4 ~22 ms, a third smaller too (measured on
    # production data, 2026-10-25). Only values written from now on use lz4; nothing is rewritten here.
    for table, column in (
        ("documents", "content"), ("document_search", "content_tsv"), ("documents", "rendered_html"),
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

    # The GIN index on documents.content_tsv is replaced by document_search's (see above). Dropping it takes
    # an exclusive lock on documents until this transaction commits, so it comes last, and gives up rather
    # than queue behind busy writers for long (the next start tries again).
    sp = conn.begin_nested()
    try:
        conn.execute(text("SET LOCAL lock_timeout = '5s'"))
        conn.execute(text("DROP INDEX IF EXISTS idx_documents_content_tsv"))
        conn.execute(text("SET LOCAL lock_timeout TO DEFAULT"))
        sp.commit()
    except Exception:
        sp.rollback()

    # Then the column itself (191 MB on 2026-11-08), unused since the release that moved it. A vector only
    # it has is copied over first, never the other way round: nothing has written it since, so where both
    # have one the new table's is the current one. Dropping a column only changes the catalog but takes
    # the same exclusive lock, so it gives up the same way; the space comes back as syncs rewrite the rows.
    if "content_tsv" in doc_cols:
        sp = conn.begin_nested()
        try:
            conn.execute(text(
                "INSERT INTO document_search (document_id, content_tsv) "
                "SELECT d.id, d.content_tsv FROM documents d WHERE d.content_tsv IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM document_search s WHERE s.document_id = d.id) "
                "ON CONFLICT (document_id) DO NOTHING"
            ))
            conn.execute(text("SET LOCAL lock_timeout = '5s'"))
            conn.execute(text("ALTER TABLE documents DROP COLUMN content_tsv"))
            conn.execute(text("SET LOCAL lock_timeout TO DEFAULT"))
            sp.commit()
        except Exception:
            sp.rollback()


async def run_all_migrations(db_engine: AsyncEngine) -> str:
    """Acquire advisory lock, run idempotent DDL migrations + create_all, and record version."""
    async with db_engine.begin() as conn:
        try:
            await conn.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": MIGRATION_LOCK_ID})
        except Exception:
            pass  # SQLite or non-Postgres test engine
        await conn.run_sync(_run_migrations)
        await conn.run_sync(Base.metadata.create_all)
        try:
            await conn.run_sync(_record_schema_version, CURRENT_SCHEMA_VERSION)
        except Exception as e:
            logger.debug("Skipping schema_migrations version write: %s", e)
    return CURRENT_SCHEMA_VERSION


async def check_schema_ready(db_engine: AsyncEngine) -> bool:
    """Lightweight readiness probe used when MEMENTO_SKIP_DDL_MIGRATIONS=1."""
    async with db_engine.connect() as conn:
        await conn.execute(text("SELECT 1 FROM machines LIMIT 1"))
    return True


async def _cli_main(check_only: bool) -> int:
    from .session import engine
    try:
        if check_only:
            await check_schema_ready(engine)
            logger.info("Schema check passed (expected version %s)", CURRENT_SCHEMA_VERSION)
        else:
            ver = await run_all_migrations(engine)
            logger.info("Database migrations completed at version %s", ver)
        return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Run Memento database migrations.")
    parser.add_argument("--check", action="store_true", help="Only verify schema readiness without running DDL.")
    args = parser.parse_args()
    sys.exit(asyncio.run(_cli_main(args.check)))
