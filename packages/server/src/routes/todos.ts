// /api/todos: the app's list, and what MCP / the agent add and close (api/todos.py).
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import { withoutNul } from "../db/client";
import { todos } from "../db/pulled/schema";
import { HttpError } from "../http";
import { addTodo, cleanTitle, closedTodos, fingerprint, openTodos, parseDue, pySlice, todoCounts, todoOut } from "../services/todos";

const CLOSED_DAYS = 14;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export const todoRoutes = new Hono<AppEnv>();

/** A JSON object body whose listed fields are strings or null (pydantic `str | None`), 422 otherwise. */
async function optionalStrings<K extends string>(c: Parameters<typeof currentUser>[0], keys: readonly K[], required: readonly K[] = []) {
  let body: unknown;
  const text = await c.req.text();
  try {
    body = JSON.parse(text);
  } catch (e) {
    const pos = Number(/position (\d+)/.exec(String((e as Error).message))?.[1] ?? 0);
    throw new HttpError(422, [{ type: "json_invalid", loc: ["body", pos], msg: "JSON decode error", input: {}, ctx: { error: String((e as Error).message) } }]);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object to extract fields from", input: body }]);
  }
  const b = body as Record<string, unknown>;
  const errors: unknown[] = [];
  const out = {} as Record<K, string | null | undefined>;
  for (const k of keys) {
    if (!(k in b)) {
      if (required.includes(k)) errors.push({ type: "missing", loc: ["body", k], msg: "Field required", input: b });
      continue;
    }
    const v = b[k];
    if (v === null && !required.includes(k)) out[k] = null;
    else if (typeof v === "string") out[k] = v;
    else errors.push({ type: "string_type", loc: ["body", k], msg: "Input should be a valid string", input: v });
  }
  if (errors.length) throw new HttpError(422, errors);
  return out;
}

const bust = (c: Parameters<typeof currentUser>[0], userId: string) => cacheDeletePrefix(c.var.deps.redis(), `todos:${userId}:`);

todoRoutes.get("/", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const project = c.req.query("project");
  const cleanProj = project && project.trim() ? project.trim() : null;
  const key = `todos:${user.id}:${cleanProj ? cleanProj.toLowerCase() : "all"}`;
  const cached = await cacheGet(redis, key);
  if (cached != null) return c.json(cached);

  const opened = await openTodos(db, user.id, 200, cleanProj);
  const since = new Date(Date.now() - CLOSED_DAYS * 86400_000).toISOString();
  const closed = await closedTodos(db, user.id, since, cleanProj);
  const payload = { open: opened.map(todoOut), closed: closed.map(todoOut), counts: await todoCounts(db, user.id) };
  await cacheSet(redis, key, payload, 30);
  return c.json(payload);
});

todoRoutes.post("/", async (c) => {
  const user = await currentUser(c);
  const body = await optionalStrings(c, ["title", "detail", "project", "due", "source"] as const, ["title"] as const);
  if (!cleanTitle(body.title)) throw new HttpError(400, "待办内容不能为空");
  const source = body.source === "manual" || body.source === "mcp" || body.source === "agent" ? body.source : "manual";
  const [todo, created] = await addTodo(c.var.deps.db, user.id, body.title!, {
    detail: body.detail,
    project: body.project,
    dueAt: parseDue(body.due),
    source,
  });
  await bust(c, user.id);
  return c.json({ todo: todoOut(todo), created });
});

todoRoutes.put("/:id", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await optionalStrings(c, ["title", "detail", "project", "due", "status", "evidence"] as const);
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) throw new HttpError(404, "not found");
  const [todo] = await db.select().from(todos).where(eq(todos.id, id.replace(/^(.{8})-?(.{4})-?(.{4})-?(.{4})-?(.{12})$/, "$1-$2-$3-$4-$5").toLowerCase())).limit(1);
  if (!todo || todo.userId !== user.id) throw new HttpError(404, "not found");

  const set: Partial<typeof todos.$inferInsert> = {};
  if (body.title != null) {
    const title = cleanTitle(body.title);
    if (!title) throw new HttpError(400, "待办内容不能为空");
    if (title !== todo.title) set.title = title;
    if (fingerprint(title) !== todo.fingerprint) set.fingerprint = fingerprint(title);
  }
  if (body.detail != null) {
    const v = body.detail.trim() || null;
    if (v !== todo.detail) set.detail = v;
  }
  if (body.project != null) {
    const v = pySlice(body.project.trim(), 120) || null;
    if (v !== todo.project) set.project = v;
  }
  if (body.due != null) {
    const v = body.due ? parseDue(body.due) : null;
    // Compared as instants: the column comes back as UTC text, the new value as +08:00
    if ((v ? Date.parse(v) : null) !== (todo.dueAt ? Date.parse(todo.dueAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")) : null)) set.dueAt = v;
    if (todo.remindedAt !== null) set.remindedAt = null;
  }
  let closeNow = false;
  if (body.status != null && body.status !== todo.status) {
    if (!["done", "dropped", "open"].includes(body.status)) throw new HttpError(400, "status must be open, done or dropped");
    set.status = body.status;
    const evidence = body.evidence || (body.status !== "open" ? "手动标记" : null);
    if (body.status === "open") {
      set.closedAt = null;
      set.closeEvidence = null;
    } else {
      closeNow = true;
      set.closeEvidence = evidence || null;
    }
  }
  let row = todo;
  if (Object.keys(set).length || closeNow) {
    const [updated] = await db
      .update(todos)
      .set({ ...withoutNul(set), ...(closeNow ? { closedAt: sql`now()` as unknown as string } : {}), updatedAt: sql`now()` as unknown as string })
      .where(and(eq(todos.id, todo.id), eq(todos.userId, user.id)))
      .returning();
    row = updated ?? todo;
  }
  await bust(c, user.id);
  return c.json({ todo: todoOut(row) });
});
