// Standalone migration CLI (replaces `python -m server.db.migrations` in k8s initContainer & enterprise setups).
// Usage:
//   node dist/migrate.mjs          # run idempotent migrations under advisory lock
//   node dist/migrate.mjs --check  # verify core tables & schema_migrations exist
import { loadSettings } from "../config";
import { createDb } from "./client";
import { checkSchemaReady, CURRENT_SCHEMA_VERSION, runAllMigrations } from "./migrate";
import { sealExisting } from "../services/secret-box";

const checkOnly = process.argv.includes("--check");
const settings = loadSettings();
const { sql, db } = createDb(settings.databaseUrl);

try {
  if (checkOnly) {
    await checkSchemaReady(sql);
    console.log(`Schema check passed (expected version ${CURRENT_SCHEMA_VERSION})`);
  } else {
    const ver = await runAllMigrations(sql);
    const sealed = await sealExisting(db, settings).catch(() => 0);
    console.log(`Database migrations completed at version ${ver}${sealed ? ` (sealed ${sealed} LLM key records)` : ""}`);
  }
} finally {
  await sql.end({ timeout: 5 });
}
