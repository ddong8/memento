// One postgres.js pool per process, wrapped by Drizzle with the pulled table definitions.
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./pulled/schema";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string, max = Number(process.env.MEMENTO_DB_POOL_SIZE || 20)) {
  const sql = postgres(url, {
    max,
    // Long-running answers stream for minutes; never hold a transaction open while they do (Python's _signed_in)
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: true,
    onnotice: () => {},
    // timestamptz comes back as UTC text, turned into Python's isoformat by pytime.ts
    connection: { TimeZone: "UTC" },
  });
  return { sql, db: drizzle(sql, { schema }) };
}

/** Postgres rejects NUL in text: drop it from anything written (server/server/db/session.py without_nul). */
export function withoutNul<T>(value: T): T {
  if (typeof value === "string") return (value.includes("\u0000") ? value.replaceAll("\u0000", "") : value) as T;
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  // Plain objects and arrays only: SQL expressions, dates and buffers pass through untouched
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)])) as T;
  }
  return value;
}
