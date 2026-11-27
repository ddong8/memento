import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { accessLogs, users } from "../src/db/pulled/schema";
import { resetLocalForTests } from "../src/rate-limit";
import { addUser, json, setupApp, TEST_DB } from "./helpers";

describe.skipIf(!TEST_DB)("/api/auth (against Postgres)", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  beforeAll(async () => {
    ctx = await setupApp();
  });
  afterAll(async () => {
    await ctx?.sql.end();
  });
  beforeEach(async () => {
    resetLocalForTests();
    await ctx.sql`DELETE FROM access_logs`;
    await ctx.sql`DELETE FROM users`;
  });

  it("registration-mode reports a fresh server (the 单机模式 first-run redirect relies on it)", async () => {
    const r = await ctx.app.request("/api/auth/registration-mode");
    expect((await r.json()) as any).toEqual({ mode: "open", has_any_user: false, github_enabled: false, wechat_enabled: false, sso_enabled: false, sso_name: "企业账号", password_login: true });
    await addUser(ctx.db);
    expect(((await (await ctx.app.request("/api/auth/registration-mode")).json()) as any).has_any_user).toBe(true);
  });

  it("login: right password gets a token that works on /me; the attempt is audited", async () => {
    const u = await addUser(ctx.db, { email: "a@example.com", role: "owner" });
    const r = await ctx.app.request("/api/auth/login", json({ email: "a@example.com", password: "pass-123456" }, { "x-real-ip": "1.2.3.4", "user-agent": "vitest" }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(Object.keys(body)).toEqual(["access_token", "token_type", "user_id", "role"]);
    expect(body).toMatchObject({ token_type: "bearer", user_id: u.id, role: "owner" });
    const me = await ctx.app.request("/api/auth/me", { headers: { authorization: `Bearer ${body.access_token}` } });
    expect(await me.json() as Promise<any>).toEqual({ id: u.id, email: "a@example.com", name: null, role: "owner", status: "active", collector_token: u.collectorToken, avatar_url: null });
    const [log] = await ctx.db.select().from(accessLogs);
    expect(log).toMatchObject({ action: "auth.login", userId: u.id, ipAddress: "1.2.3.4", userAgent: "vitest" });
    expect(log!.metadata).toEqual({ audit: true, actor_email: "a@example.com", actor_role: "owner", path: "/api/auth/login", method: "POST" });
  });

  it("login: wrong password 401 + failure audited; 10 failures lock the account for 15 minutes (429)", async () => {
    await addUser(ctx.db, { email: "b@example.com" });
    const bad = () => ctx.app.request("/api/auth/login", json({ email: "B@example.com ", password: "nope" }));
    const first = await bad();
    expect(first.status).toBe(401);
    expect(await first.json() as Promise<any>).toEqual({ detail: "Invalid credentials" });
    for (let i = 0; i < 9; i++) await bad();
    const locked = await bad();
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(((await locked.json()) as any).detail).toMatch(/^Too many attempts, try again in \d+ seconds$/);
    const logs = await ctx.db.select().from(accessLogs).where(eq(accessLogs.action, "auth.login_failed"));
    expect(logs).toHaveLength(10);
    expect(logs[0]!.metadata).toMatchObject({ email: "b@example.com" });
  });

  it("login: pending accounts 403; with password sign-in off only the owner gets in", async () => {
    await addUser(ctx.db, { email: "p@example.com", status: "pending" });
    expect((await ctx.app.request("/api/auth/login", json({ email: "p@example.com", password: "pass-123456" }))).status).toBe(403);
    const off = await setupApp({ MEMENTO_PASSWORD_LOGIN: "false" });
    try {
      await addUser(off.db, { email: "v@example.com" });
      await addUser(off.db, { email: "o@example.com", role: "owner" });
      const v = await off.app.request("/api/auth/login", json({ email: "v@example.com", password: "pass-123456" }));
      expect(v.status).toBe(403);
      expect(await v.json() as Promise<any>).toEqual({ detail: "请使用企业账号登录" });
      expect((await off.app.request("/api/auth/login", json({ email: "o@example.com", password: "pass-123456" }))).status).toBe(200);
    } finally {
      await off.sql.end();
    }
  });

  it("login: a body missing a field is a 422 in pydantic's shape", async () => {
    const r = await ctx.app.request("/api/auth/login", json({ email: "x@example.com" }));
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).detail[0]).toMatchObject({ type: "missing", loc: ["body", "password"], msg: "Field required" });
  });

  it("token-exchange: the device's collector token, or the legacy global one for the owner", async () => {
    const owner = await addUser(ctx.db, { role: "owner" });
    const viewer = await addUser(ctx.db);
    const mine = await (await ctx.app.request("/api/auth/token-exchange", { method: "POST", headers: { "x-collector-token": viewer.collectorToken! } })).json();
    expect(mine).toMatchObject({ user_id: viewer.id, role: "viewer" });
    const legacy = await (await ctx.app.request("/api/auth/token-exchange", { method: "POST", headers: { "x-collector-token": "legacy-global-token" } })).json();
    expect(legacy).toMatchObject({ user_id: owner.id, role: "owner" });
    const none = await ctx.app.request("/api/auth/token-exchange", { method: "POST" });
    expect(none.status).toBe(401);
    expect(await none.json() as Promise<any>).toEqual({ detail: "X-Collector-Token header required" });
    expect((await ctx.app.request("/api/auth/token-exchange", { method: "POST", headers: { "x-collector-token": "wrong" } })).status).toBe(401);
  });

  it("me / refresh: missing, bad, or a disabled account's token is 401 with the same messages", async () => {
    const u = await addUser(ctx.db);
    expect(await (await ctx.app.request("/api/auth/me")).json() as Promise<any>).toEqual({ detail: "Missing authorization" });
    expect(await (await ctx.app.request("/api/auth/me", { headers: { authorization: "Bearer junk" } })).json() as Promise<any>).toEqual({ detail: "Invalid token" });
    const t = await createAccessToken(u.id, u.role, ctx.settings.secretKey, 60);
    const fresh = await (await ctx.app.request("/api/auth/refresh", { method: "POST", headers: { authorization: `Bearer ${t}` } })).json();
    expect(fresh).toMatchObject({ user_id: u.id, token_type: "bearer" });
    await ctx.db.update(users).set({ status: "disabled" }).where(eq(users.id, u.id));
    const r = await ctx.app.request("/api/auth/me", { headers: { authorization: `Bearer ${t}` } });
    expect(r.status).toBe(401);
    expect((await r.json()) as any).toEqual({ detail: "User not found or inactive" });
  });

  it("PATCH /me: name trimmed (empty clears it), avatar validated, updated_at moves", async () => {
    const u = await addUser(ctx.db, { name: "旧名字" });
    const auth = { authorization: `Bearer ${await createAccessToken(u.id, u.role, ctx.settings.secretKey, 60)}`, "content-type": "application/json" };
    const patch = (body: unknown) => ctx.app.request("/api/auth/me", { method: "PATCH", headers: auth, body: JSON.stringify(body) });
    expect(await (await patch({ name: "  新名字  ", avatar_url: "https://x.example/a.png" })).json() as Promise<any>).toMatchObject({ name: "新名字", avatar_url: "https://x.example/a.png" });
    expect(await (await patch({ name: "", avatar_url: "" })).json() as Promise<any>).toMatchObject({ name: null, avatar_url: null });
    const bad = await patch({ avatar_url: "ftp://nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json() as Promise<any>).toEqual({ detail: "Invalid avatar URL or data URI format" });
    const [row] = await ctx.db.select().from(users).where(eq(users.id, u.id));
    expect(new Date(row!.updatedAt).getTime()).toBeGreaterThan(new Date(u.updatedAt).getTime());
  });

  it("CORS answers the allowed origin with credentials; /health reports the build", async () => {
    const pre = await ctx.app.request("/api/auth/login", { method: "OPTIONS", headers: { origin: "https://mem.example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://mem.example.com");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(await (await ctx.app.request("/health")).json() as Promise<any>).toEqual({ status: "ok", version: "dev" });
  });
});
