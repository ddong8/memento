// Versioned PostgreSQL schema bootstrap & idempotent DDL migrations (replaces server/server/db/migrations.py).
// Works identically on an empty database (first-time desktop standalone / enterprise install) and on existing
// production databases, serialized across replicas via pg_advisory_xact_lock(MIGRATION_LOCK_ID).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

// Hex 0x6D656D656E746F == "memento" (same advisory lock key as legacy Python migrations.py)
export const MIGRATION_LOCK_ID = "30792277001925743";
export const CURRENT_SCHEMA_VERSION = "20261128_005_perf_tuning";

function locateSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "schema.sql"),
    resolve(here, "../db/schema.sql"),
    resolve(here, "../../db/schema.sql"),
    resolve(here, "../schema.sql"),
    resolve(process.cwd(), "db/schema.sql"),
    resolve(process.cwd(), "dist/schema.sql"),
    resolve(process.cwd(), "packages/server/db/schema.sql"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`schema.sql not found (searched: ${candidates.join(", ")})`);
}

function cleanSchemaDump(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      if (t.startsWith("\\")) return false; // pg_dump 16.10+ \restrict / \unrestrict meta-commands
      if (/^SELECT pg_catalog\.set_config\('search_path'/i.test(t)) return false;
      return true;
    })
    .join("\n");
}

async function execSavepoint(tx: postgres.Sql, spName: string, stmt: string): Promise<boolean> {
  await tx.unsafe(`SAVEPOINT ${spName}`);
  try {
    await tx.unsafe(stmt);
    await tx.unsafe(`RELEASE SAVEPOINT ${spName}`);
    return true;
  } catch {
    await tx.unsafe(`ROLLBACK TO SAVEPOINT ${spName}`);
    await tx.unsafe(`RELEASE SAVEPOINT ${spName}`);
    return false;
  }
}

const IDEMPOTENT_ALTERS: string[] = [
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES machines(id)",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id)",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS remote_exec_key VARCHAR(64)",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS profile_targets JSONB NOT NULL DEFAULT '[]'",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS profile_targets_off JSONB NOT NULL DEFAULT '[]'",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS profile_status JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS skill_status JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE machines ADD COLUMN IF NOT EXISTS collect_status JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS last_end_offset BIGINT",
  "ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS excluded_project VARCHAR(255)",
  "ALTER TABLE correction_topics ADD COLUMN IF NOT EXISTS scope VARCHAR(200) NOT NULL DEFAULT 'global'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS collector_token VARCHAR(64) UNIQUE",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS wechat_openid VARCHAR(64) UNIQUE",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_subject VARCHAR(512)",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id VARCHAR(50)",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS proactive_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS llm_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS collect_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS plugin_settings JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE device_tasks ADD COLUMN IF NOT EXISTS alerts JSONB NOT NULL DEFAULT '[]'",
  "ALTER TABLE device_tasks ADD COLUMN IF NOT EXISTS events JSONB NOT NULL DEFAULT '[]'",
  "ALTER TABLE device_tasks ADD COLUMN IF NOT EXISTS session_id VARCHAR(128)",
  "ALTER TABLE ask_conversations ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'",
  "ALTER TABLE ask_conversations ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_next_at TIMESTAMPTZ",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_status VARCHAR(20) NOT NULL DEFAULT 'pending'",
  "ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_attempts INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE daily_summaries ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE",
  "ALTER TABLE share_links ADD COLUMN IF NOT EXISTS target_user_id UUID REFERENCES users(id) ON DELETE CASCADE",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES user_memories(id) ON DELETE CASCADE",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS tree_path VARCHAR(255)",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS is_folder BOOLEAN DEFAULT FALSE",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS recall_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active'",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS status_reason TEXT",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES user_memories(id) ON DELETE SET NULL",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS feedback_pos INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE user_memories ADD COLUMN IF NOT EXISTS feedback_neg INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS aliases JSONB NOT NULL DEFAULT '[]'::jsonb",
  "ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ",
  "ALTER TABLE knowledge_entities ADD COLUMN IF NOT EXISTS stale_reason TEXT",
  "ALTER TABLE eval_cases ADD COLUMN IF NOT EXISTS evidence TEXT",
  // Lower autovacuum scale factors on large tables so dead tuples & planner stats stay fresh
  "ALTER TABLE conversation_messages SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)",
  "ALTER TABLE document_embeddings SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)",
  "ALTER TABLE documents SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02)",
];

const IDEMPOTENT_INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS ix_users_wechat_openid ON users (wechat_openid)",
  "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_oidc_subject ON users (oidc_subject) WHERE oidc_subject IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS ix_users_github_id ON users (github_id) WHERE github_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS ix_documents_embedding_due ON documents (embedding_status, embedding_next_at) WHERE embedding_status IN ('pending', 'failed')",
  "CREATE INDEX IF NOT EXISTS idx_documents_machine_synced ON documents (machine_id, synced_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_document_search_tsv ON document_search USING gin (content_tsv)",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_summary_user_date_tool ON daily_summaries (user_id, summary_date, tool_id)",
  "CREATE INDEX IF NOT EXISTS idx_share_target_user ON share_links (target_user_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memories (user_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_user_memory_parent ON user_memories (user_id, parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_user_memory_tree_path ON user_memories (user_id, tree_path)",
  "CREATE INDEX IF NOT EXISTS idx_user_memory_status ON user_memories (user_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_conv_msg_timestamp ON conversation_messages (timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_conv_msg_doc_ts ON conversation_messages (document_id, timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_conv_msg_doc_dialogue ON conversation_messages (document_id, line_number) WHERE role IN ('user', 'assistant')",
  "CREATE INDEX IF NOT EXISTS idx_conv_msg_role_ts ON conversation_messages (role, timestamp DESC) WHERE role IN ('user', 'assistant')",
  "CREATE INDEX IF NOT EXISTS idx_documents_tool_synced ON documents (tool_id, synced_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_documents_project_synced ON documents (project_id, synced_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_documents_project_category ON documents (project_id, category)",
  "CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_documents_path_trgm ON documents USING gin (relative_path gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name_trgm ON knowledge_entities USING gin (name gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_summary_trgm ON knowledge_entities USING gin (summary gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_search_trgm ON knowledge_entities USING gin ((name || ' ' || coalesce(summary, '')) gin_trgm_ops)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_entities_norm_name ON knowledge_entities (user_id, regexp_replace(lower(name), '[-_\\s]+', '', 'g'))",
  "CREATE INDEX IF NOT EXISTS idx_device_tasks_user_active ON device_tasks (user_id, created_at DESC) WHERE status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')",
  "CREATE INDEX IF NOT EXISTS idx_doc_versions_doc_synced ON document_versions (document_id, synced_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_documents_metadata_session_id ON documents (((metadata->>'session_id'))) WHERE (metadata->>'session_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_documents_metadata_cascade_id ON documents (((metadata->>'cascade_id'))) WHERE (metadata->>'cascade_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_machines_collector_token_hash ON machines (collector_token_hash)",
  "CREATE INDEX IF NOT EXISTS idx_machines_user_id ON machines (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_observation_source_doc ON knowledge_observations (source_document_id)",
  "CREATE INDEX IF NOT EXISTS idx_observation_entity_observed ON knowledge_observations (entity_id, observed_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_observation_entity_source ON knowledge_observations (entity_id, source_document_id)",
  "CREATE INDEX IF NOT EXISTS idx_ask_conv_session_id ON ask_conversations (((config->>'session_id'))) WHERE (config->>'session_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_ask_conv_user_device ON ask_conversations (user_id, device_id, updated_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_device_tasks_status_created ON device_tasks (status, created_at) WHERE status IN ('queued', 'running', 'still_running', 'pending', 'dispatched')",
  "CREATE INDEX IF NOT EXISTS idx_device_tasks_conv_id ON device_tasks (((payload->>'conversation_id'))) WHERE (payload->>'conversation_id') IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_doc_embedding_hnsw_half ON document_embeddings USING hnsw (CAST(embedding AS HALFVEC(1024)) halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)",
  "CREATE INDEX IF NOT EXISTS idx_user_memories_embedding_hnsw ON user_memories USING hnsw (embedding vector_cosine_ops)",
];

const LZ4_COLUMNS: [string, string][] = [
  ["documents", "content"],
  ["document_search", "content_tsv"],
  ["documents", "rendered_html"],
  ["ask_conversations", "turns"],
  ["conversation_messages", "content"],
];

export async function runAllMigrations(sqlClient: postgres.Sql, schemaPath?: string): Promise<string> {
  await sqlClient.begin(async (tx) => {
    const q = tx as unknown as postgres.Sql;
    await q.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`);

    // Extensions first (pgvector + pg_trgm)
    await execSavepoint(q, "sp_ext_vec", "CREATE EXTENSION IF NOT EXISTS vector");
    await execSavepoint(q, "sp_ext_trgm", "CREATE EXTENSION IF NOT EXISTS pg_trgm");

    // Detect fresh/empty database and bootstrap full 42-table schema from schema.sql
    const [reg] = await q<{ t: string | null }[]>`SELECT to_regclass('public.users')::text AS t`;
    if (!reg?.t) {
      const sqlFile = schemaPath || locateSchemaSql();
      const cleaned = cleanSchemaDump(readFileSync(sqlFile, "utf8"));
      await q.unsafe(cleaned);
    }

    // Idempotent column upgrades on existing databases
    for (let i = 0; i < IDEMPOTENT_ALTERS.length; i++) {
      await execSavepoint(q, `sp_alt_${i}`, IDEMPOTENT_ALTERS[i]!);
    }

    // Half-precision vector upgrade if an older database still uses vector(1024)
    const [embType] = await q<{ typ: string | null }[]>`
      SELECT format_type(atttypid, atttypmod) AS typ
      FROM pg_attribute
      WHERE attrelid = 'document_embeddings'::regclass AND attname = 'embedding'
    `;
    if (embType?.typ?.startsWith("vector")) {
      await execSavepoint(
        q,
        "sp_halfvec",
        "SET LOCAL max_parallel_maintenance_workers = 0; ALTER TABLE document_embeddings ALTER COLUMN embedding TYPE halfvec(1024) USING embedding::halfvec",
      );
    }

    // Idempotent performance & vector HNSW indexes
    for (let i = 0; i < IDEMPOTENT_INDEXES.length; i++) {
      await execSavepoint(q, `sp_idx_${i}`, IDEMPOTENT_INDEXES[i]!);
    }

    // LZ4 toast compression on hot-rewritten columns (best-effort; skipped if Postgres lacks lz4)
    for (let i = 0; i < LZ4_COLUMNS.length; i++) {
      const [table, col] = LZ4_COLUMNS[i]!;
      const [att] = await q<{ c: string | null }[]>`
        SELECT attcompression::text AS c FROM pg_attribute
        WHERE attrelid = ${table}::regclass AND attname = ${col}
      `;
      if (att && att.c !== "l") {
        await execSavepoint(
          q,
          `sp_lz4_${i}`,
          `SET LOCAL lock_timeout = '5s'; ALTER TABLE ${table} ALTER COLUMN ${col} SET COMPRESSION lz4; SET LOCAL lock_timeout TO DEFAULT`,
        );
      }
    }

    // Assign owner collector_token if missing and attach orphan machines to owner
    const [owner] = await q<{ id: string; collector_token: string | null }[]>`
      SELECT id::text AS id, collector_token FROM users WHERE role = 'owner' AND status = 'active' LIMIT 1
    `;
    if (owner) {
      if (!owner.collector_token) {
        const tok = randomBytes(32).toString("hex");
        await q`UPDATE users SET collector_token = ${tok} WHERE id = ${owner.id}::uuid AND collector_token IS NULL`;
      }
      await q`UPDATE machines SET user_id = ${owner.id}::uuid WHERE user_id IS NULL`;
    }

    // Record schema version
    await q.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await q`INSERT INTO schema_migrations (version) VALUES (${CURRENT_SCHEMA_VERSION}) ON CONFLICT (version) DO NOTHING`;
  });
  return CURRENT_SCHEMA_VERSION;
}

export async function checkSchemaReady(sqlClient: postgres.Sql): Promise<boolean> {
  await sqlClient`SELECT 1 FROM machines LIMIT 1`;
  await sqlClient`SELECT 1 FROM users LIMIT 1`;
  await sqlClient`SELECT 1 FROM schema_migrations LIMIT 1`;
  return true;
}
