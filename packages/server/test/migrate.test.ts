// Tests TS DDL migration runner against a brand-new empty PostgreSQL database (P7).
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { checkSchemaReady, CURRENT_SCHEMA_VERSION, runAllMigrations } from "../src/db/migrate";
import { users } from "../src/db/pulled/schema";
import { isSealed, reveal, sealExisting } from "../src/services/secret-box";
import { TEST_DB } from "./helpers";

describe.skipIf(!TEST_DB)("P7 DDL migration runner (empty DB -> full schema -> idempotent)", () => {
  const adminUrl = (TEST_DB || "").replace(/\/[^/]+$/, "/postgres");
  const freshDbName = "memento_ts_migrate_test";
  const freshUrl = (TEST_DB || "").replace(/\/[^/]+$/, `/${freshDbName}`);
  let adminSql: postgres.Sql;

  beforeAll(async () => {
    adminSql = postgres(adminUrl, { max: 1, onnotice: () => {} });
    await adminSql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${freshDbName}' AND pid <> pg_backend_pid()`);
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${freshDbName}`);
    await adminSql.unsafe(`CREATE DATABASE ${freshDbName}`);
  });

  afterAll(async () => {
    if (adminSql) {
      await adminSql.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${freshDbName}' AND pid <> pg_backend_pid()`);
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${freshDbName}`);
      await adminSql.end();
    }
  });

  it("bootstraps all 42 tables from an empty database, is idempotent, passes --check, and seals plaintext LLM keys", async () => {
    const { sql, db } = createDb(freshUrl);
    try {
      const ver1 = await runAllMigrations(sql);
      expect(ver1).toBe(CURRENT_SCHEMA_VERSION);

      const tables = await sql<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
      `;
      expect(tables.length).toBeGreaterThanOrEqual(42);
      const names = new Set(tables.map((t) => t.tablename));
      for (const required of ["users", "machines", "documents", "document_embeddings", "document_search", "user_memories", "agent_plans", "agent_missions", "schema_migrations"]) {
        expect(names.has(required), `missing table ${required}`).toBe(true);
      }

      // Second pass must be completely idempotent
      const ver2 = await runAllMigrations(sql);
      expect(ver2).toBe(CURRENT_SCHEMA_VERSION);
      expect(await checkSchemaReady(sql)).toBe(true);

      // Verify pgvector extension is loaded
      const [ext] = await sql<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
      expect(ext?.extname).toBe("vector");

      // Verify sealExisting encrypts plaintext LLM keys in users.llm_settings
      const settings = { dataKey: "test-data-key-32-chars-minimum!!", secretKey: "test-secret" };
      await db.insert(users).values({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        email: "mig@example.com",
        role: "owner",
        status: "active",
        llmSettings: { api_key: "sk-plaintext-12345", base_url: "https://api.deepseek.com" },
      });
      const sealed = await sealExisting(db, settings);
      expect(sealed).toBe(1);
      const [u] = await db.select({ llmSettings: users.llmSettings }).from(users);
      const storedKey = (u?.llmSettings as Record<string, unknown>)?.api_key;
      expect(isSealed(storedKey)).toBe(true);
      expect(reveal(String(storedKey), settings)).toBe("sk-plaintext-12345");
      // Second pass finds 0 unsealed
      expect(await sealExisting(db, settings)).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
