// Table definitions are pulled from a database the Python migrations built (they own the schema until P7 of
// docs/ts-server-migration.md): MEMENTO_PULL_DATABASE_URL=postgres://... npm run db:pull -w @memento/server
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./src/db/pulled",
  dbCredentials: { url: process.env.MEMENTO_PULL_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/memento" },
  introspect: { casing: "camel" },
});
