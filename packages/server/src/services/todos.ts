// Todos (services/todo_service.py): the helpers the API needs, matching Python's output byte for byte.
import { createHash } from "node:crypto";

import { and, asc, desc, eq, gte, ilike, ne, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { withoutNul } from "../db/client";
import { todos } from "../db/pulled/schema";
import { localDate, localMidnight, pgToIso, pyDateFromIso } from "../pytime";

export const TITLE_MAX = 200;
export const OPEN_LIMIT = 60;
export type TodoRow = typeof todos.$inferSelect;

/** Python's str[:n] counts code points, not UTF-16 units. */
export const pySlice = (s: string, n: number) => {
  const cps = [...s];
  return cps.length <= n ? s : cps.slice(0, n).join("");
};

/** sha1 of the title without whitespace, punctuation and underscores (Python re [\s\W_]+, Unicode-aware). */
export function fingerprint(title: string | null | undefined): string {
  const norm = (title || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return createHash("sha1").update(norm, "utf8").digest("hex");
}

/** Python's \s: Unicode whitespace plus the ASCII separators \x1c-\x1f. */
const PY_WS = /[\s\x1c-\x1f\x85]+/gu;

export function cleanTitle(title: string | null | undefined): string {
  return pySlice((title || "").replace(PY_WS, " ").trim(), TITLE_MAX);
}

/** "YYYY-MM-DD" (or another form date.fromisoformat takes) -> that day's local midnight; else null. */
export function parseDue(value: unknown): string | null {
  if (!value) return null;
  const d = pyDateFromIso(String(value));
  return d ? localMidnight(d) : null;
}

export function todoOut(t: TodoRow) {
  return {
    id: t.id,
    title: t.title,
    detail: t.detail,
    project: t.project,
    status: t.status,
    due: localDate(t.dueAt),
    source: t.source,
    evidence: t.evidence,
    close_evidence: t.closeEvidence,
    source_doc_id: t.sourceDocId,
    created_at: pgToIso(t.createdAt),
    closed_at: pgToIso(t.closedAt),
  };
}

export async function openTodos(db: Db, userId: string, limit = OPEN_LIMIT, project?: string | null): Promise<TodoRow[]> {
  const conds = [eq(todos.userId, userId), eq(todos.status, "open")];
  if (project) conds.push(ilike(todos.project, `%${project.trim()}%`));
  return db
    .select()
    .from(todos)
    .where(and(...conds))
    .orderBy(sql`${todos.dueAt} ASC NULLS LAST`, desc(todos.createdAt))
    .limit(limit);
}

export async function closedTodos(db: Db, userId: string, sinceIso: string, project?: string | null): Promise<TodoRow[]> {
  const conds = [eq(todos.userId, userId), ne(todos.status, "open"), gte(todos.closedAt, sinceIso)];
  if (project) conds.push(ilike(todos.project, `%${project}%`));
  return db.select().from(todos).where(and(...conds)).orderBy(desc(todos.closedAt)).limit(50);
}

/** Counts for the badge: open, overdue (due before today's local midnight), done and added in the last week. */
export async function todoCounts(db: Db, userId: string, days = 7) {
  const nowMs = Date.now();
  const today = localMidnight(new Date(nowMs + 8 * 3600_000).toISOString().slice(0, 10));
  const since = new Date(nowMs - days * 86400_000).toISOString();
  const [row] = await db
    .select({
      open: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'open')`.mapWith(Number),
      overdue: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'open' AND ${todos.dueAt} IS NOT NULL AND ${todos.dueAt} < ${today})`.mapWith(Number),
      done: sql<number>`count(*) FILTER (WHERE ${todos.status} = 'done' AND ${todos.closedAt} >= ${since})`.mapWith(Number),
      added: sql<number>`count(*) FILTER (WHERE ${todos.createdAt} >= ${since})`.mapWith(Number),
    })
    .from(todos)
    .where(eq(todos.userId, userId));
  return { open: row?.open || 0, overdue: row?.overdue || 0, done_recent: row?.done || 0, added_recent: row?.added || 0 };
}

/** Add a todo, or return the open one with the same title (filling its empty fields). [todo, created] */
export async function addTodo(
  db: Db,
  userId: string,
  title: string,
  opts: { detail?: string | null; project?: string | null; dueAt?: string | null; source?: string } = {},
): Promise<[TodoRow, boolean]> {
  const clean = cleanTitle(title);
  if (!clean) throw new Error("title is empty");
  const fp = fingerprint(clean);
  const [existing] = await db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.status, "open"), eq(todos.fingerprint, fp)))
    .limit(1);
  if (existing) {
    const fill: Partial<typeof todos.$inferInsert> = {};
    if (!existing.detail && opts.detail) fill.detail = opts.detail;
    if (!existing.dueAt && opts.dueAt) fill.dueAt = opts.dueAt;
    if (!existing.project && opts.project) fill.project = pySlice(opts.project, 120);
    if (!Object.keys(fill).length) return [existing, false];
    const [row] = await db
      .update(todos)
      .set({ ...withoutNul(fill), updatedAt: sql`now()` as unknown as string })
      .where(eq(todos.id, existing.id))
      .returning();
    return [row ?? existing, false];
  }
  const [row] = await db
    .insert(todos)
    .values(
      withoutNul({
        id: crypto.randomUUID(),
        userId,
        title: clean,
        detail: opts.detail || null,
        project: opts.project ? pySlice(opts.project, 120) : null,
        dueAt: opts.dueAt ?? null,
        source: opts.source ?? "manual",
        evidence: null,
        sourceDocId: null,
        fingerprint: fp,
        status: "open",
      }),
    )
    .returning();
  return [row!, true];
}

export { asc };
