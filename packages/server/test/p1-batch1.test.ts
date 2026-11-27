// Tests for P1 batch 1 routes & services: dashboard, hierarchy, documents, install, updates, skills, plugins, media, secret-box.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { loadSettings } from "../src/config";
import {
  conversationMessages,
  documentPendingDeltas,
  documents,
  knowledgeEntities,
  knowledgeObservations,
  machines,
  projects,
  skills,
  tools,
} from "../src/db/pulled/schema";
import { parseByteRange } from "../src/routes/media";
import { compareSemver, matchGithubAsset } from "../src/routes/updates";
import { maskSecret, reveal, seal } from "../src/services/secret-box";
import { mediaKey, mediaSignatureOk, signMediaUrl, signVideoUrl, storeVideoBytes, uploadBytes, videoSignatureOk } from "../src/services/storage";
import { addUser, json, setupApp, TEST_DB } from "./helpers";

describe("secret-box & storage helpers", () => {
  it("seals and reveals secrets, passes plaintext through, and returns empty on wrong key", () => {
    const s1 = loadSettings({ MEMENTO_SECRET_KEY: "key-a", MEMENTO_DATA_KEY: "" });
    const s2 = loadSettings({ MEMENTO_SECRET_KEY: "key-b", MEMENTO_DATA_KEY: "" });
    const sealed = seal("sk-test-1234567890", s1);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(seal(sealed, s1)).toBe(sealed);
    expect(reveal(sealed, s1)).toBe("sk-test-1234567890");
    expect(reveal(sealed, s2)).toBe("");
    expect(reveal("plain-key", s1)).toBe("plain-key");
    expect(maskSecret("abcdef")).toBe("••••");
    expect(maskSecret("sk-12345678")).toBe("sk-••••678");
  });

  it("signs and verifies media/video URLs and rejects path traversal", () => {
    const now = 1_750_000_000;
    const signedImg = signMediaUrl("/api/media/image/ab/cd.png", "sec", now);
    const u = new URL(`http://x${signedImg}`);
    expect(mediaSignatureOk("sec", "ab/cd.png", Number(u.searchParams.get("exp")), u.searchParams.get("sig"), now)).toBe(true);
    expect(mediaSignatureOk("sec", "ab/cd.png", Number(u.searchParams.get("exp")), "bad", now)).toBe(false);
    expect(mediaSignatureOk("sec", "ab/cd.png", now - 10, u.searchParams.get("sig"), now)).toBe(false);
    expect(() => mediaKey("../etc/passwd")).toThrow();

    const signedVid = signVideoUrl("/api/media/video/videos/u/u1/demo.mp4", "sec", now);
    const vu = new URL(`http://x${signedVid}`);
    expect(videoSignatureOk("sec", "videos/u/u1/demo.mp4", Number(vu.searchParams.get("exp")), vu.searchParams.get("sig"), now)).toBe(true);
  });

  it("parses HTTP byte ranges and compares semver / GitHub assets", () => {
    expect(parseByteRange("bytes=0-9", 100)).toEqual([0, 9]);
    expect(parseByteRange("bytes=50-", 100)).toEqual([50, 99]);
    expect(parseByteRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseByteRange("bytes=200-300", 100)).toBeNull();
    expect(parseByteRange("bytes=10-5", 100)).toBeNull();
    expect(compareSemver("1.0.168", "1.0.167")).toBe(true);
    expect(compareSemver("1.0.167", "1.0.167")).toBe(false);
    expect(matchGithubAsset([{ name: "Memento-1.0.0-win-x64.exe" }, { name: "Memento-1.0.0-win-x64.zip" }], "windows")?.name).toBe("Memento-1.0.0-win-x64.zip");
    expect(matchGithubAsset([{ name: "Memento-1.0.0-mac.dmg" }, { name: "Memento-1.0.0-mac-arm64.zip" }], "macos")?.name).toBe("Memento-1.0.0-mac-arm64.zip");
  });
});

describe.skipIf(!TEST_DB)("P1 batch 1 routes (against Postgres)", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("dashboard & hierarchy: owner sees all, viewer only sees own devices, merged machines resolve", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const owner = await addUser(db, { role: "owner", email: "o@example.com" });
    const viewer = await addUser(db, { role: "viewer", email: "v@example.com" });
    const ownerTok = await createAccessToken(owner.id, owner.role, settings.secretKey, 60, settings.algorithm);
    const viewerTok = await createAccessToken(viewer.id, viewer.role, settings.secretKey, 60, settings.algorithm);

    await db.insert(tools).values([
      { id: "claude_code", displayName: "Claude Code", icon: "claude", totalFiles: 2, totalSizeBytes: 2048, lastSyncAt: "2026-11-27 05:00:00+00" },
      { id: "codex", displayName: "Codex", icon: null, totalFiles: 1, totalSizeBytes: 512, lastSyncAt: null },
    ]);
    const projId = crypto.randomUUID();
    await db.insert(projects).values({ id: projId, slug: "memento", title: "Memento", toolId: "claude_code", visibility: "private" });
    const mOwner = crypto.randomUUID();
    const mMerged = crypto.randomUUID();
    const mViewer = crypto.randomUUID();
    await db.insert(machines).values([
      { id: mOwner, name: "owner-mac", collectorTokenHash: "h-owner", userId: owner.id },
      { id: mMerged, name: "owner-mac-old", collectorTokenHash: "h-old", userId: owner.id, mergedInto: mOwner },
      { id: mViewer, name: "viewer-pc", collectorTokenHash: "h-viewer", userId: viewer.id },
    ]);
    const d1 = crypto.randomUUID();
    const d2 = crypto.randomUUID();
    await db.insert(documents).values([
      {
        id: d1, toolId: "claude_code", projectId: projId, machineId: mOwner, relativePath: "a.jsonl",
        category: "conversation", contentType: "jsonl", title: "Owner Conv", content: "line1",
        contentHash: "c1", fileSizeBytes: 100, metadata: {}, visibility: "private", needsReview: false,
        embeddingStatus: "done", embeddingAttempts: 0, knowledgeStatus: "done", knowledgeAttempts: 0,
      },
      {
        id: d2, toolId: "codex", projectId: null, machineId: mViewer, relativePath: "b.jsonl",
        category: "conversation", contentType: "jsonl", title: "Viewer Conv", content: "line2",
        contentHash: "c2", fileSizeBytes: 200, metadata: {}, visibility: "private", needsReview: false,
        embeddingStatus: "done", embeddingAttempts: 0, knowledgeStatus: "done", knowledgeAttempts: 0,
      },
    ]);
    await db.insert(conversationMessages).values({ documentId: d1, lineNumber: 1, role: "user", content: "hi", metadata: {} });

    const dashOwner = await (await app.request("/api/dashboard?tz_offset=-480", { headers: { authorization: `Bearer ${ownerTok}` } })).json() as {
      stats: { total_documents: number; total_projects: number }; recent_conversations: { id: string; message_count: number }[];
    };
    expect(dashOwner.stats.total_documents).toBe(2);
    expect(dashOwner.stats.total_projects).toBe(1);
    expect(dashOwner.recent_conversations.find((x) => x.id === d1)?.message_count).toBe(1);

    const dashViewer = await (await app.request("/api/dashboard", { headers: { authorization: `Bearer ${viewerTok}` } })).json() as {
      stats: { total_documents: number }; devices: { device_id: string }[];
    };
    expect(dashViewer.stats.total_documents).toBe(1);
    expect(dashViewer.devices.map((d) => d.device_id)).toEqual(["h-viewer"]);

    // Merged machine resolves to mOwner
    const hTools = await (await app.request("/api/hierarchy/devices/h-old/tools", { headers: { authorization: `Bearer ${ownerTok}` } })).json() as { id: string; total_files: number }[];
    expect(hTools).toEqual([{ id: "claude_code", display_name: "Claude Code", categories: { conversation: 1 }, total_files: 1 }]);

    // Viewer cannot inspect owner's device
    const hDenied = await (await app.request("/api/hierarchy/devices/h-owner/tools", { headers: { authorization: `Bearer ${viewerTok}` } })).json();
    expect(hDenied).toEqual([]);

    const hFiles = await (await app.request(`/api/hierarchy/devices/h-owner/tools/claude_code/files?project_id=${projId}`, { headers: { authorization: `Bearer ${ownerTok}` } })).json() as { total: number; files: { id: string }[] };
    expect(hFiles.total).toBe(1);
    expect(hFiles.files[0]?.id).toBe(d1);
  });

  it("documents: appends pending deltas, returns backlinks, blocks SSRF in proxy-fetch", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const owner = await addUser(db, { role: "owner" });
    const tok = await createAccessToken(owner.id, owner.role, settings.secretKey, 60, settings.algorithm);
    await db.insert(tools).values({ id: "claude_code", displayName: "Claude Code", totalFiles: 2, totalSizeBytes: 100 });
    const m1 = crypto.randomUUID();
    await db.insert(machines).values({ id: m1, name: "mac", collectorTokenHash: "h1", userId: owner.id });
    const d1 = crypto.randomUUID();
    const d2 = crypto.randomUUID();
    await db.insert(documents).values([
      {
        id: d1, toolId: "claude_code", machineId: m1, relativePath: "a.md", category: "memory", contentType: "md",
        title: "Doc A", content: "part1", contentHash: "h1", fileSizeBytes: 5, metadata: { k: 1 }, visibility: "private",
        needsReview: false, embeddingStatus: "done", embeddingAttempts: 0, knowledgeStatus: "done", knowledgeAttempts: 0,
      },
      {
        id: d2, toolId: "claude_code", machineId: m1, relativePath: "b.md", category: "memory", contentType: "md",
        title: "Doc B", content: "other", contentHash: "h2", fileSizeBytes: 5, metadata: {}, visibility: "private",
        needsReview: false, embeddingStatus: "done", embeddingAttempts: 0, knowledgeStatus: "done", knowledgeAttempts: 0,
      },
    ]);
    await db.insert(documentPendingDeltas).values([
      { documentId: d1, content: "part2" },
      { documentId: d1, content: "part3" },
    ]);
    const entId = crypto.randomUUID();
    await db.insert(knowledgeEntities).values({ id: entId, userId: owner.id, name: "Memento", entityType: "project" });
    await db.insert(knowledgeObservations).values([
      { id: crypto.randomUUID(), entityId: entId, content: "obs1", sourceDocumentId: d1 },
      { id: crypto.randomUUID(), entityId: entId, content: "obs2", sourceDocumentId: d2 },
    ]);

    const docRes = await app.request(`/api/documents/${d1}`, { headers: { authorization: `Bearer ${tok}` } });
    expect(docRes.status).toBe(200);
    const docBody = (await docRes.json()) as { content: string };
    expect(docBody.content).toBe("part1\npart2\npart3");

    const blRes = await app.request(`/api/documents/${d1}/backlinks`, { headers: { authorization: `Bearer ${tok}` } });
    const bl = (await blRes.json()) as { entities: { name: string }[]; related_documents: { id: string; shared_entities: number }[] };
    expect(bl.entities.map((e) => e.name)).toEqual(["Memento"]);
    expect(bl.related_documents).toMatchObject([{ id: d2, shared_entities: 1 }]);

    // SSRF guard blocks loopback & private IPs & non-http schemes
    const ssrf1 = await app.request("/api/documents/proxy-fetch?url=http://127.0.0.1:8000/health", { headers: { authorization: `Bearer ${tok}` } });
    expect(ssrf1.status).toBe(403);
    const ssrf2 = await app.request("/api/documents/proxy-fetch?url=file:///etc/passwd", { headers: { authorization: `Bearer ${tok}` } });
    expect(ssrf2.status).toBe(400);
  });

  it("skills: full lifecycle (list, edit, publish, pending update, retire, restore, collector injection)", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const u = await addUser(db, { role: "viewer" });
    const tok = await createAccessToken(u.id, u.role, settings.secretKey, 60, settings.algorithm);
    const auth = { authorization: `Bearer ${tok}` };
    const mId = crypto.randomUUID();
    await db.insert(machines).values({ id: mId, name: "dev-mac", collectorTokenHash: "dev-hash", userId: u.id, profileTargetsOff: ["workbuddy"] });
    const sId = crypto.randomUUID();
    await db.insert(skills).values({
      id: sId, userId: u.id, slug: "deploy-flow", title: "Deploy Flow", description: "How to deploy",
      body: "1. Build\n2. Push", status: "draft", version: 0, timesSeen: 2, editedByUser: false,
      pendingUpdate: { description: "Better deploy", body: "1. Test\n2. Deploy" },
    });

    const list1 = (await (await app.request("/api/skills", { headers: auth })).json()) as { drafts: { slug: string }[]; counts: { draft: number } };
    expect(list1.drafts.map((s) => s.slug)).toEqual(["deploy-flow"]);
    expect(list1.counts.draft).toBe(1);

    const pub = await app.request(`/api/skills/${sId}/publish`, { method: "POST", headers: auth });
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { skill: { version: number; status: string } }).skill).toMatchObject({ version: 1, status: "published" });

    const applied = await app.request(`/api/skills/${sId}/update/apply`, { method: "POST", headers: auth });
    expect(((await applied.json()) as { skill: { version: number; description: string; has_update: boolean } }).skill).toMatchObject({
      version: 2, description: "Better deploy", has_update: false,
    });

    const inj = await app.request("/api/skills/injection", {
      headers: { "x-collector-token": u.collectorToken!, "x-device-id": "dev-hash" },
    });
    expect(inj.status).toBe(200);
    const injBody = (await inj.json()) as { targets: string[]; skills: { slug: string; version: number }[] };
    expect(injBody.targets).toEqual(["agents", "claude"]);
    expect(injBody.skills).toMatchObject([{ slug: "deploy-flow", version: 2 }]);

    const rep = await app.request("/api/skills/injection/status", {
      ...json({ results: { claude: "ok" } }, { "x-collector-token": u.collectorToken!, "x-device-id": "dev-hash" }),
    });
    expect(rep.status).toBe(200);

    const retired = await app.request(`/api/skills/${sId}/retire`, { method: "POST", headers: auth });
    expect(((await retired.json()) as { skill: { status: string } }).skill.status).toBe("retired");
    const restored = await app.request(`/api/skills/${sId}/restore`, { method: "POST", headers: auth });
    expect(((await restored.json()) as { skill: { status: string } }).skill.status).toBe("draft");
  });

  it("plugins: list, install with sealed secret, update config, uninstall", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const u = await addUser(db, { role: "viewer" });
    const tok = await createAccessToken(u.id, u.role, settings.secretKey, 60, settings.algorithm);
    const auth = { authorization: `Bearer ${tok}` };

    const init = (await (await app.request("/api/plugins", { headers: auth })).json()) as { plugins: { id: string; installed: boolean }[] };
    expect(init.plugins.map((p) => p.id)).toEqual(["studio", "wechat_publish"]);
    expect(init.plugins[0]!.installed).toBe(false);

    const installed = await app.request("/api/plugins/studio/install", {
      ...json({ config: { filmkit_url: "https://studio.example.com/", filmkit_token: "my-secret-token-999" } }, auth),
    });
    expect(installed.status).toBe(200);
    const studio = ((await installed.json()) as { plugins: { id: string; ready: boolean; config: Record<string, unknown> }[] }).plugins[0]!;
    expect(studio.ready).toBe(true);
    expect(studio.config.filmkit_url).toBe("https://studio.example.com");
    expect(studio.config.has_filmkit_token).toBe(true);
    expect(studio.config.filmkit_token_masked).toBe("my-••••999");

    const uninstalled = await app.request("/api/plugins/studio", { method: "DELETE", headers: auth });
    expect(((await uninstalled.json()) as { plugins: { installed: boolean }[] }).plugins[0]!.installed).toBe(false);
  });

  it("media (local storage mode), install scripts, and updates check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memento-media-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { app, sql, db, settings } = await setupApp({ MEMENTO_STORAGE_DIR: dir, MEMENTO_UPDATES_DIR: dir });
    cleanups.push(() => sql.end());

    const u = await addUser(db, { role: "viewer" });
    const tok = await createAccessToken(u.id, u.role, settings.secretKey, 60, settings.algorithm);

    // Image upload + signed & owner access + non-raster sandbox
    await uploadBytes(settings, `images/u/${u.id}/pic.png`, Buffer.from("PNGDATA"), "image/png");
    const unauth = await app.request(`/api/media/image/u/${u.id}/pic.png`);
    expect(unauth.status).toBe(403);
    const authed = await app.request(`/api/media/image/u/${u.id}/pic.png`, { headers: { authorization: `Bearer ${tok}` } });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toBe("PNGDATA");

    const signed = signMediaUrl(`/api/media/image/u/${u.id}/pic.png`, settings.secretKey);
    const viaSig = await app.request(signed);
    expect(viaSig.status).toBe(200);

    // Video 206 Range streaming
    const vidUrl = await storeVideoBytes(settings, u.id, "clip.mp4", Buffer.from("0123456789ABCDEF"), "video/mp4");
    const vidRes = await app.request(signVideoUrl(vidUrl, settings.secretKey), { headers: { range: "bytes=4-9" } });
    expect(vidRes.status).toBe(206);
    expect(vidRes.headers.get("content-range")).toBe("bytes 4-9/16");
    expect(await vidRes.text()).toBe("456789");

    // Install scripts
    const sh = await app.request("/install.sh");
    expect(sh.status).toBe(200);
    const tar = await app.request("/install/latest.tar.gz");
    expect(tar.status).toBe(302);

    // Updates check (mobile short-circuit + local version.json)
    const mob = await (await app.request("/api/system/update/check?platform=ios&version=1.0.0")).json() as { has_update: boolean };
    expect(mob.has_update).toBe(false);
    writeFileSync(join(dir, "version.json"), JSON.stringify({ version: "9.9.9", title: "v9.9.9", platforms: { macos: { asset_name: "Memento-9.9.9-mac.zip", size: 123 } } }));
    const up = await (await app.request("/api/system/update/check?platform=macos&version=1.0.0")).json() as { has_update: boolean; latest_version: string };
    expect(up.has_update).toBe(true);
    expect(up.latest_version).toBe("9.9.9");
  });
});
