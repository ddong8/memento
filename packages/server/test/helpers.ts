// A real Postgres for route tests (MEMENTO_TEST_DATABASE_URL, e.g. the CI service), rebuilt from db/schema.sql:
// the schema the Python migrations make, dumped with pg_dump. Without the variable these tests are skipped.
import { readFileSync } from "node:fs";

import { createApp } from "../src/app";
import { loadSettings } from "../src/config";
import { createDb } from "../src/db/client";
import { users } from "../src/db/pulled/schema";
import { hashPassword } from "../src/auth/password";

export const TEST_DB = process.env.MEMENTO_TEST_DATABASE_URL?.replace(/^postgresql\+asyncpg:/, "postgres:");

export async function setupApp(env: Record<string, string> = {}) {
  const settings = loadSettings({ MEMENTO_SECRET_KEY: "route-test-secret", MEMENTO_COLLECTOR_TOKEN: "legacy-global-token", MEMENTO_DEBUG: "1", ...env });
  const { sql, db } = createDb(TEST_DB!, 4);
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  // pg_dump 16.10+ wraps the dump in psql-only \\restrict / \\unrestrict lines: not SQL
  await sql.unsafe(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8").replace(/^\\.*$/gm, ""));
  await sql.unsafe("SET search_path TO public");
  const app = createApp({ settings, db, redis: () => null });
  return { app, sql, db, settings };
}

export async function addUser(db: ReturnType<typeof createDb>["db"], over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      email: `u${Math.random().toString(36).slice(2, 8)}@example.com`,
      hashedPassword: hashPassword("pass-123456"),
      role: "viewer",
      status: "active",
      collectorToken: crypto.randomUUID().replaceAll("-", ""),
      ...over,
    })
    .returning();
  return u!;
}

export const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
