// P6 integration & unit tests: projects, memory, profile, share, studio, auth extensions, sso, scim, admin, plans & missions.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { documents, machines, projects, tools } from "../src/db/pulled/schema";
import { makeState, readState, sanitizeNext } from "../src/routes/sso";
import { lookupGeoIp } from "../src/services/geoip";
import { parsePlanJson, planProgress } from "../src/services/plan-service";
import { pickProjectPath } from "../src/services/project-placement";
import { addUser, setupApp, TEST_DB } from "./helpers";

describe("P6 pure unit checks", () => {
  it("verifies SSO state signing, next sanitization, geoip, project placement & plan helpers", () => {
    const state = makeState("test-secret", "/projects/123");
    const decoded = readState("test-secret", state);
    expect(decoded).not.toBeNull();
    expect(decoded?.next).toBe("/projects/123");
    expect(readState("wrong-secret", state)).toBeNull();

    expect(sanitizeNext("/daily?tab=1")).toBe("/daily?tab=1");
    expect(sanitizeNext("https://evil.com")).toBe("");
    expect(sanitizeNext("//evil.com")).toBe("");

    expect(lookupGeoIp("127.0.0.1")).toEqual({});
    expect(lookupGeoIp(null)).toEqual({});

    const picked = pickProjectPath(
      [
        { machineId: "d1", path: "/Users/me/dev/memento", documents: 5, lastActive: Date.parse("2026-11-27T00:00:00Z"), lastActiveRaw: "2026-11-27T00:00:00Z" },
        { machineId: "d1", path: "/tmp/random", documents: 1, lastActive: Date.parse("2026-11-26T00:00:00Z"), lastActiveRaw: "2026-11-26T00:00:00Z" },
      ],
      "memento",
      "Memento",
    );
    expect(picked).toBe("/Users/me/dev/memento");

    const parsed = parsePlanJson('```json\n{"steps":[{"id":"s1","title":"Step 1","prompt":"do it"}]}\n```');
    expect(Array.isArray(parsed?.steps)).toBe(true);

    const prog = planProgress([
      { id: "s1", title: "A", prompt: "a", status: "succeeded", depends_on: [] } as never,
      { id: "s2", title: "B", prompt: "b", status: "pending", depends_on: ["s1"] } as never,
    ]);
    expect(prog.ready).toEqual(["s2"]);
    expect(prog.over).toBe(false);
  });
});

describe.skipIf(!TEST_DB)("P6 end-to-end routes", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let ownerId: string;
  let ownerAuth: Record<string, string>;
  let viewerAuth: Record<string, string>;
  let projectId: string;

  beforeAll(async () => {
    ctx = await setupApp();
    const owner = await addUser(ctx.db, { email: "p6-owner@example.com", role: "owner", name: "Owner" });
    const viewer = await addUser(ctx.db, { email: "p6-viewer@example.com", role: "viewer", name: "Viewer" });
    ownerId = owner.id;
    const ownerTok = await createAccessToken(owner.id, owner.role, ctx.settings.secretKey, ctx.settings.accessTokenExpireMinutes);
    const viewerTok = await createAccessToken(viewer.id, viewer.role, ctx.settings.secretKey, ctx.settings.accessTokenExpireMinutes);
    ownerAuth = { authorization: `Bearer ${ownerTok}` };
    viewerAuth = { authorization: `Bearer ${viewerTok}` };

    await ctx.db
      .insert(tools)
      .values({ id: "claude_code", displayName: "Claude Code", totalFiles: 1, totalSizeBytes: 120 })
      .onConflictDoNothing();
    const mId = "11111111-1111-1111-1111-111111111116";
    await ctx.db.insert(machines).values({
      id: mId,
      name: "p6-mac",
      collectorTokenHash: "p6-hash",
      userId: owner.id,
    });
    projectId = "22222222-2222-2222-2222-222222222226";
    await ctx.db.insert(projects).values({
      id: projectId,
      slug: "memento-p6",
      title: "Memento P6",
      toolId: "claude_code",
      sourcePath: "/Users/test/dev/memento-p6",
      visibility: "private",
    });
    await ctx.db.insert(documents).values({
      id: "33333333-3333-3333-3333-333333333336",
      toolId: "claude_code",
      relativePath: "p6/conv.jsonl",
      category: "conversation",
      contentType: "jsonl",
      contentHash: "p6-doc-hash",
      fileSizeBytes: 120,
      metadata: { project: "memento-p6" },
      visibility: "private",
      needsReview: false,
      embeddingStatus: "done",
      embeddingAttempts: 0,
      knowledgeStatus: "done",
      knowledgeAttempts: 0,
      machineId: mId,
      projectId,
      title: "P6 测试会话",
      content: "测试正文内容",
    });
  });

  afterAll(async () => {
    await ctx?.sql.end();
  });

  it("handles root, projects, memory core CRUD, profile & blueprint", async () => {
    const root = await ctx.app.request("/");
    expect(root.status).toBe(200);
    expect(((await root.json()) as { name: string }).name).toBe("Memento");

    const projList = await ctx.app.request("/api/projects", { headers: ownerAuth });
    expect(projList.status).toBe(200);
    const projListBody = (await projList.json()) as { items?: { id: string }[] } | { id: string }[];
    expect(Array.isArray(projListBody) || Array.isArray(projListBody.items)).toBe(true);

    const projDetail = await ctx.app.request(`/api/projects/${projectId}`, { headers: ownerAuth });
    expect(projDetail.status).toBe(200);

    const projExport = await ctx.app.request(`/api/projects/${projectId}/export.md`, { headers: ownerAuth });
    expect(projExport.status).toBe(200);

    const memStats = await ctx.app.request("/api/memory/stats", { headers: ownerAuth });
    expect(memStats.status).toBe(200);

    const memCreate = await ctx.app.request("/api/memory/core", {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ category: "rule", key: "p6_iron_rule", content: "P6 核心铁律测试" }),
    });
    expect(memCreate.status).toBe(200);
    const createdMem = (await memCreate.json()) as { id: string; content: string };
    expect(createdMem.id).toBeTruthy();

    const memList = await ctx.app.request("/api/memory/core", { headers: ownerAuth });
    expect(memList.status).toBe(200);

    const memUpdate = await ctx.app.request(`/api/memory/core/${createdMem.id}`, {
      method: "PUT",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ content: "P6 核心铁律已更新" }),
    });
    expect(memUpdate.status).toBe(200);

    const memDel = await ctx.app.request(`/api/memory/core/${createdMem.id}`, {
      method: "DELETE",
      headers: ownerAuth,
    });
    expect(memDel.status).toBe(200);

    const profileRes = await ctx.app.request("/api/profile", { headers: ownerAuth });
    expect(profileRes.status).toBe(200);

    const bpRes = await ctx.app.request("/api/profile/blueprint", { headers: ownerAuth });
    expect(bpRes.status).toBe(200);

    const avatarRes = await ctx.app.request("/api/profile/avatar", { headers: ownerAuth });
    expect(avatarRes.status).toBe(200);
  });

  it("handles share lifecycle, admin RBAC/invites/audit, plans, missions & studio health", async () => {
    const shareCreate = await ctx.app.request("/api/share", {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ kind: "timeline", target_id: projectId, title: "P6 Share" }),
    });
    expect(shareCreate.status).toBe(200);
    const shareData = (await shareCreate.json()) as { token: string };
    expect(shareData.token).toBeTruthy();

    const pubInfo = await ctx.app.request(`/api/share/public/${shareData.token}`);
    expect(pubInfo.status).toBe(200);

    const shareDel = await ctx.app.request(`/api/share/${shareData.token}`, { method: "DELETE", headers: ownerAuth });
    expect(shareDel.status).toBe(200);

    // Admin RBAC: viewer gets 403, owner gets 200
    const viewerAdmin = await ctx.app.request("/api/admin/users", { headers: viewerAuth });
    expect(viewerAdmin.status).toBe(403);

    const ownerUsers = await ctx.app.request("/api/admin/users", { headers: ownerAuth });
    expect(ownerUsers.status).toBe(200);
    expect(Array.isArray(await ownerUsers.json())).toBe(true);

    const inviteRes = await ctx.app.request("/api/admin/invites", {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ role: "member", max_uses: 3, expires_in_days: 7 }),
    });
    expect(inviteRes.status).toBe(200);
    const invite = (await inviteRes.json()) as { id: string; code: string };
    expect(invite.code).toBeTruthy();

    const auditRes = await ctx.app.request("/api/admin/audit-log", { headers: ownerAuth });
    expect(auditRes.status).toBe(200);

    // Auth rotate token
    const rotRes = await ctx.app.request("/api/auth/me/rotate-collector-token", { method: "POST", headers: ownerAuth });
    expect(rotRes.status).toBe(200);
    expect(((await rotRes.json()) as { collector_token: string }).collector_token).toBeTruthy();

    // Plans & Missions & Studio health
    const plansRes = await ctx.app.request("/api/plans", { headers: ownerAuth });
    expect(plansRes.status).toBe(200);

    const missionsRes = await ctx.app.request("/api/missions", { headers: ownerAuth });
    expect(missionsRes.status).toBe(200);

    const studioHealth = await ctx.app.request("/api/studio/health", { headers: ownerAuth });
    expect([200, 412, 503]).toContain(studioHealth.status);

    // SCIM disabled without MEMENTO_SCIM_TOKEN returns 404
    const scimCfg = await ctx.app.request("/api/scim/v2/ServiceProviderConfig");
    expect(scimCfg.status).toBe(404);

    expect(ownerId).toBeTruthy();
  });
});
