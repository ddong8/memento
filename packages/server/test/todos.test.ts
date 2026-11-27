import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { l1ClearForTests } from "../src/cache";
import { todos } from "../src/db/pulled/schema";
import { localDate, pgToIso, pyDateFromIso } from "../src/pytime";
import { cleanTitle, fingerprint, parseDue } from "../src/services/todos";
import { addUser, setupApp, TEST_DB } from "./helpers";

// Made by server/server/services/todo_service.py on the same inputs
const PY = JSON.parse(readFileSync(new URL("./fixtures/todo-python.json", import.meta.url), "utf8")) as {
  fingerprint: Record<string, string>;
  clean_title: Record<string, string>;
  parse_due: Record<string, string | null>;
};

describe("todo helpers match Python on the same inputs", () => {
  it("fingerprint (Unicode word characters, like Python's re)", () => {
    for (const [input, want] of Object.entries(PY.fingerprint)) expect(fingerprint(input), input).toBe(want);
  });
  it("clean_title", () => {
    for (const [input, want] of Object.entries(PY.clean_title)) expect(cleanTitle(input), input).toBe(want);
  });
  it("parse_due (including the other forms date.fromisoformat takes)", () => {
    for (const [input, want] of Object.entries(PY.parse_due)) expect(parseDue(input), input).toBe(want);
    // Checked against Python's date.fromisoformat
    expect(pyDateFromIso("2026-W53-1")).toBe("2026-12-28");
    expect(pyDateFromIso("2020-W53-5")).toBe("2021-01-01");
    expect(pyDateFromIso("2026-W00-1")).toBeNull();
    expect(pyDateFromIso("2026W521")).toBe("2026-12-21");
    expect(pyDateFromIso("2026-W52")).toBe("2026-12-21");
    expect(pyDateFromIso("2025-W53-1")).toBeNull();
  });
  it("timestamps print like Python's isoformat of the UTC value", () => {
    expect(pgToIso("2026-11-27 05:00:00.12+00")).toBe("2026-11-27T05:00:00.120000+00:00");
    expect(pgToIso("2026-11-27 05:00:00+00")).toBe("2026-11-27T05:00:00+00:00");
    expect(pgToIso("2026-11-27 05:00:00.000001+00")).toBe("2026-11-27T05:00:00.000001+00:00");
    expect(pgToIso(null)).toBeNull();
    expect(localDate("2026-11-26 16:00:00+00")).toBe("2026-11-27");
    expect(localDate("2026-11-26 15:59:59+00")).toBe("2026-11-26");
  });
});

describe.skipIf(!TEST_DB)("/api/todos (against Postgres)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let auth: Record<string, string>;
  let userId: string;
  beforeAll(async () => {
    ctx = await setupApp();
  });
  afterAll(async () => {
    await ctx?.sql.end();
  });
  beforeEach(async () => {
    l1ClearForTests();
    await ctx.sql`DELETE FROM todos`;
    await ctx.sql`DELETE FROM access_logs`;
    await ctx.sql`DELETE FROM users`;
    const u = await addUser(ctx.db);
    userId = u.id;
    auth = { authorization: `Bearer ${await createAccessToken(u.id, u.role, ctx.settings.secretKey, 60)}`, "content-type": "application/json" };
  });
  const req = (method: string, path: string, body?: unknown) =>
    ctx.app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = async (r: Response) => (await r.json()) as any;

  it("adding the same title twice keeps one open todo and fills its empty fields", async () => {
    const a = await j(await req("POST", "/api/todos", { title: "  给 memento  加分页 ", source: "mcp" }));
    expect(a.created).toBe(true);
    expect(a.todo).toMatchObject({ title: "给 memento 加分页", source: "mcp", status: "open", due: null, closed_at: null });
    expect(Object.keys(a.todo)).toEqual(["id", "title", "detail", "project", "status", "due", "source", "evidence", "close_evidence", "source_doc_id", "created_at", "closed_at"]);
    expect(a.todo.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{6})?\+00:00$/);
    const b = await j(await req("POST", "/api/todos", { title: "给memento加分页！", due: "2026-12-01", project: "memento" }));
    expect(b.created).toBe(false);
    expect(b.todo).toMatchObject({ id: a.todo.id, due: "2026-12-01", project: "memento" });
  });

  it("empty titles and unknown sources", async () => {
    const r = await req("POST", "/api/todos", { title: "   " });
    expect(r.status).toBe(400);
    expect(await j(r)).toEqual({ detail: "待办内容不能为空" });
    expect((await j(await req("POST", "/api/todos", { title: "x", source: "hacker" }))).todo.source).toBe("manual");
    expect((await req("POST", "/api/todos", {})).status).toBe(422);
  });

  it("list: open first by due date, closed in the last 14 days, counts; the cache is dropped on change", async () => {
    const t1 = (await j(await req("POST", "/api/todos", { title: "later", due: "2030-01-01" }))).todo;
    await req("POST", "/api/todos", { title: "no due" });
    await req("POST", "/api/todos", { title: "soon", due: "2029-01-01", project: "Memento" });
    let list = await j(await req("GET", "/api/todos"));
    expect(list.open.map((t: any) => t.title)).toEqual(["soon", "later", "no due"]);
    expect(list.counts).toEqual({ open: 3, overdue: 0, done_recent: 0, added_recent: 3 });
    const done = await j(await req("PUT", `/api/todos/${t1.id}`, { status: "done" }));
    expect(done.todo).toMatchObject({ status: "done", close_evidence: "手动标记" });
    expect(done.todo.closed_at).toBeTruthy();
    list = await j(await req("GET", "/api/todos"));
    expect(list.closed.map((t: any) => t.title)).toEqual(["later"]);
    expect(list.counts).toMatchObject({ open: 2, done_recent: 1 });
    expect((await j(await req("GET", "/api/todos?project=mem"))).open.map((t: any) => t.title)).toEqual(["soon"]);
  });

  it("edit: fields, reopening clears the close, bad status 400, someone else's todo 404", async () => {
    const t = (await j(await req("POST", "/api/todos", { title: "edit me" }))).todo;
    await ctx.db.update(todos).set({ remindedAt: "2026-01-01T00:00:00Z" }).where(eq(todos.id, t.id));
    const e = await j(await req("PUT", `/api/todos/${t.id}`, { title: "edited", detail: "  d  ", project: "", due: "2026-12-24" }));
    expect(e.todo).toMatchObject({ title: "edited", detail: "d", project: null, due: "2026-12-24" });
    const [row] = await ctx.db.select().from(todos).where(eq(todos.id, t.id));
    expect(row!.remindedAt).toBeNull();
    expect(row!.fingerprint).toBe(fingerprint("edited"));
    await req("PUT", `/api/todos/${t.id}`, { status: "dropped", evidence: "不做了" });
    const reopened = await j(await req("PUT", `/api/todos/${t.id}`, { status: "open" }));
    expect(reopened.todo).toMatchObject({ status: "open", closed_at: null, close_evidence: null });
    const bad = await req("PUT", `/api/todos/${t.id}`, { status: "later" });
    expect(bad.status).toBe(400);
    expect(await j(bad)).toEqual({ detail: "status must be open, done or dropped" });
    expect((await req("PUT", `/api/todos/not-a-uuid`, { title: "x" })).status).toBe(404);
    const other = await addUser(ctx.db);
    const otherAuth = { authorization: `Bearer ${await createAccessToken(other.id, other.role, ctx.settings.secretKey, 60)}`, "content-type": "application/json" };
    const r = await ctx.app.request(`/api/todos/${t.id}`, { method: "PUT", headers: otherAuth, body: JSON.stringify({ title: "mine" }) });
    expect(r.status).toBe(404);
    expect(await j(r)).toEqual({ detail: "not found" });
    void userId;
  });
});
