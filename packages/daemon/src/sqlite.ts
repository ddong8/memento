import { execFileSync } from "node:child_process";
import type * as NodeSqlite from "node:sqlite";

/**
 * Reading and writing other apps' SQLite files (Antigravity's conversation_summaries.db)
 * without Python: node:sqlite where the runtime has it (the desktop app's Electron, Node 22.13+),
 * otherwise the sqlite3 command-line tool. Statements use `?` placeholders, and only as
 * placeholders: the command-line path inlines the values in their place.
 */
export type SqliteValue = string | number | null;

let loaded: typeof NodeSqlite | null | undefined;

/** node:sqlite, or null where this runtime has none. Its load-time ExperimentalWarning stays
 * off stderr, which task output shows the user. */
function nodeSqlite(): typeof NodeSqlite | null {
  if (loaded !== undefined) return loaded;
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/\bSQLite\b/.test(text ?? "")) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    loaded = (process.getBuiltinModule?.("node:sqlite") as typeof NodeSqlite | undefined) ?? null;
  } catch {
    loaded = null;
  } finally {
    process.emitWarning = emit;
  }
  return loaded;
}

/** For tests: take the sqlite3 command-line path even where node:sqlite is there (false: detect again). */
export function useSqliteCli(on: boolean): void {
  loaded = on ? null : undefined;
}

const sqliteCli = () => (process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3");
// Field and row separators no text column here holds, so titles with line breaks come back whole
const FIELD = "\x1f";
const ROW = "\x1e";

function inline(sql: string, params: SqliteValue[]): string {
  let i = 0;
  return sql.replace(/\?/g, () => {
    const v = params[i++] ?? null;
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    return `'${v.replace(/'/g, "''")}'`;
  });
}

function cli(path: string, sql: string, timeout: number): string {
  // -list overrides an output mode set in ~/.sqliterc
  return execFileSync(sqliteCli(), ["-batch", "-list", "-noheader", "-separator", FIELD, "-newline", ROW, path, sql], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** The rows `sql` selects, each as its column values in order; undefined when the file can't be read. */
export function sqliteRows(path: string, sql: string, params: SqliteValue[] = [], timeout = 3000): unknown[][] | undefined {
  const sqlite = nodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(path, { readOnly: true, timeout });
      try {
        return db.prepare(sql).all(...params).map((row) => Object.values(row));
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }
  try {
    const out = cli(path, inline(sql, params), timeout);
    return out
      .split(ROW)
      .filter((r) => r !== "" && r !== "\n")
      .map((r) => r.split(FIELD));
  } catch {
    return undefined;
  }
}

/** Runs a statement that changes the file; false when it couldn't. */
export function sqliteRun(path: string, sql: string, params: SqliteValue[] = [], timeout = 5000): boolean {
  const sqlite = nodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(path, { timeout });
      try {
        db.prepare(sql).run(...params);
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }
  try {
    cli(path, inline(sql, params), timeout);
    return true;
  } catch {
    return false;
  }
}
