// P3 integration tests: Device WebSocket protocol, task dispatch/cancel/input, device files Range/ETag,
// interactive terminal, preview proxy sandbox & path rewrite, git diff/PR helpers, quotas, scheduled tasks, risk policy.
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { serve } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createAccessToken } from "../src/auth/jwt";
import { machines } from "../src/db/pulled/schema";
import { parseRepoRoots, parseSuggestion, parseUnifiedDiff, stripAgentTrailers, summarizeChecks } from "../src/routes/git-review";
import { rewriteLocation, rewritePaths } from "../src/routes/preview";
import { attachDeviceWebSocket } from "../src/routes/tasks";
import { cleanSessionId, deviceOs, reportedSessionId } from "../src/services/agent-ids";
import { markUsageLimit } from "../src/services/agent-limits";
import { peekFollowups, popFollowups } from "../src/services/ask-followups";
import { parseByteRange } from "../src/services/device-files";
import { claudePlanTier } from "../src/services/device-reports";
import { classifyCatastrophic, classifyFileChange, classifyShellCommand } from "../src/services/risk-policy";
import { nextRun, validSchedule } from "../src/services/scheduled-tasks";
import { addUser, json, setupApp, TEST_DB } from "./helpers";

describe("P3 pure unit checks", () => {
  it("classifies shell & file risks and ignores ssh remote catastrophic commands", () => {
    expect(classifyShellCommand("rm -rf /tmp/foo")?.level).toBe("danger");
    expect(classifyShellCommand("git push --force origin main")?.level).toBe("critical");
    expect(classifyShellCommand("ls -la")).toBeNull();
    expect(classifyCatastrophic("rm -rf /")).not.toBeNull();
    expect(classifyCatastrophic('ssh prod "rm -rf /"')).toBeNull();
    expect(classifyFileChange("/Users/a/.ssh/id_ed25519", "/Users/a/proj")?.level).toBe("critical");
    expect(classifyFileChange("/Users/a/other/x.ts", "/Users/a/proj")?.level).toBe("danger");
    expect(classifyFileChange("/Users/a/proj/src/x.ts", "/Users/a/proj")).toBeNull();
  });

  it("validates agent ids, quota limits, ranges, schedule nextRun, preview rewrite and git diff parsing", () => {
    expect(deviceOs("haixingdeMac-mini.local (Darwin)")).toBe("macos");
    expect(cleanSessionId('""', "agy")).toBeNull();
    expect(cleanSessionId("550e8400-e29b-41d4-a716-446655440000", "agy")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(reportedSessionId("foo\nsession id: ses_123\nbar")).toBe("ses_123");

    const quotaRes = markUsageLimit({ action: "agent", status: "still_running", stderr: "You've hit your session limit · resets 5pm" });
    expect(quotaRes.status).toBe("failed");
    expect(quotaRes.error_type).toBe("usage_limit");
    expect(claudePlanTier("default_claude_max_20x")).toBe("MAX 20X");

    expect(parseByteRange("bytes=0-9", 100)).toEqual([0, 9, 206]);
    expect(parseByteRange("bytes=-10", 100)).toEqual([90, 99, 206]);
    expect(parseByteRange(null, 100)).toEqual([0, 99, 200]);

    expect(validSchedule("daily:09:30")).toBe(true);
    expect(validSchedule("daily:25:00")).toBe(false);
    const nxt = nextRun("daily:09:30", 480, new Date("2026-11-27T01:30:00Z")); // 09:30+08:00 -> strictly after -> next day
    expect(nxt.toISOString()).toBe("2026-11-28T01:30:00.000Z");

    expect(rewritePaths('<script src="/app.js"></script><img src="//cdn.x/a.png">', "text/html", "/api/preview/t/tok/")).toBe(
      '<script src="/api/preview/t/tok/app.js"></script><img src="//cdn.x/a.png">',
    );
    expect(rewriteLocation("http://localhost:3000/login", 3000, "/api/preview/t/tok/")).toBe("/api/preview/t/tok/login");

    const diff = parseUnifiedDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n");
    expect(diff).toHaveLength(1);
    expect(diff[0]!.additions).toBe(1);
    expect(diff[0]!.deletions).toBe(1);
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toEqual({
      state: "pending",
      passed: 1,
      failed: 0,
      pending: 1,
      total: 2,
    });
    expect(parseRepoRoots("./.git\n./sub/.git\n", "/repo", false)).toEqual(["/repo", "/repo/sub"]);
    expect(stripAgentTrailers("feat: ok\n\nCo-Authored-By: Bot <b@x>")).toBe("feat: ok");
    expect(parseSuggestion('{"message":"fix: x","pr_title":"fix: x","pr_body":"desc"}').pr_body).toBe("desc");
  });
});

describe.skipIf(!TEST_DB)("P3 end-to-end WebSocket + routes", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let server: HttpServer;
  let wss: ReturnType<typeof attachDeviceWebSocket>;
  let port = 0;
  let ownerAuth: Record<string, string>;
  let ownerId = "";
  let collectorToken = "";
  const execKey = "exec-secret-key-123";
  const devHash = "dev-hash-mac-001";
  let machineId = "";

  beforeAll(async () => {
    ctx = await setupApp({ MEMENTO_REMOTE_EXEC: "1" });
    const owner = await addUser(ctx.db, { role: "owner", email: "p3owner@example.com" });
    ownerId = owner.id;
    collectorToken = owner.collectorToken!;
    const tok = await createAccessToken(owner.id, owner.role, ctx.settings.secretKey, 60);
    ownerAuth = { authorization: `Bearer ${tok}` };

    const [m] = await ctx.db
      .insert(machines)
      .values({
        id: crypto.randomUUID(),
        name: "Mac-Mini (Darwin)",
        collectorTokenHash: devHash,
        collectorVersion: "1.0.170",
        userId: owner.id,
        remoteExecKey: execKey,
        lastHeartbeat: new Date().toISOString(),
      })
      .returning();
    machineId = m!.id;

    server = serve({ fetch: ctx.app.fetch, hostname: "127.0.0.1", port: 0 }) as HttpServer;
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
    wss = attachDeviceWebSocket(server, { settings: ctx.settings, db: ctx.db, redis: () => null });
  });

  afterAll(async () => {
    wss?.close();
    server?.close();
    await ctx?.sql.end();
  });

  it("fails dispatch immediately when device is offline (never left queued)", async () => {
    const res = await ctx.app.request(`/api/tasks/dispatch/${devHash}`, json({ action: "shell", payload: { command: "echo hi" } }, ownerAuth));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; error: string };
    expect(body.status).toBe("failed");
    expect(body.error).toContain("不在线");
  });

  it("connects device WS, dispatches task, streams chunks, finishes, reports quotas/caps, proxies files & preview & terminal", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/ws/${encodeURIComponent(devHash)}?token=${collectorToken}&key=${execKey}`);
    const received: Record<string, unknown>[] = [];
    const connected = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        received.push(msg);
        if (msg.type === "connected") resolve(msg);

        // Simulated daemon handlers
        if (msg.type === "task_dispatch") {
          const task = msg.task as Record<string, unknown>;
          const tid = String(task.id);
          ws.send(JSON.stringify({ type: "task_chunk", task_id: tid, stream: "stdout", text: "hello from ws\n", seq: 1 }));
          ws.send(JSON.stringify({ type: "task_finished", task_id: tid, status: "succeeded", exit_code: 0, stdout: "hello from ws\n", stderr: "" }));
        } else if (msg.type === "file_stat_req") {
          ws.send(JSON.stringify({ type: "file_stat_resp", req_id: msg.req_id, exists: true, size: 11 }));
        } else if (msg.type === "file_chunk_req") {
          const content = Buffer.from("0123456789A");
          const off = Number(msg.offset ?? 0);
          const len = Number(msg.length ?? 11);
          ws.send(JSON.stringify({ type: "file_chunk_resp", req_id: msg.req_id, data_b64: content.subarray(off, off + len).toString("base64") }));
        } else if (msg.type === "term_open") {
          ws.send(JSON.stringify({ type: "term_open_resp", req_id: msg.req_id, ok: true }));
        } else if (msg.type === "preview_ports_req") {
          ws.send(JSON.stringify({ type: "preview_resp", req_id: msg.req_id, ok: true, ports: [{ port: 3000, process: "node" }] }));
        } else if (msg.type === "preview_http_req") {
          ws.send(
            JSON.stringify({
              type: "preview_resp",
              req_id: msg.req_id,
              ok: true,
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
              body_b64: Buffer.from('<a href="/about">hi</a>').toString("base64"),
            }),
          );
        } else if (msg.type === "git_diff_req") {
          ws.send(JSON.stringify({ type: "git_resp", req_id: msg.req_id, ok: true, branch: "main", files: [], total_files: 0 }));
        }
      });
    });

    const welcome = await connected;
    expect(welcome.device_id).toBe(devHash);

    // Report capabilities + quotas
    ws.send(
      JSON.stringify({
        type: "agent_capabilities",
        capabilities: { environment: { platform: "darwin", arch: "arm64", features: ["terminal", "preview", "git_review", "agent_login"] } },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "agent_quotas",
        quotas: { tools: { claude_code: { available: true, tier: "default_claude_max_5x", remaining_percent: 82 } } },
      }),
    );
    await new Promise((r) => setTimeout(r, 80));

    // 1. Device list shows online + ETag 304
    const listRes = await ctx.app.request("/api/devices", { headers: ownerAuth });
    expect(listRes.status).toBe(200);
    const etag = listRes.headers.get("etag")!;
    const devs = (await listRes.json()) as { id: string; online: boolean; agent_login: boolean }[];
    expect(devs[0]!.online).toBe(true);
    expect(devs[0]!.agent_login).toBe(true);
    const notMod = await ctx.app.request("/api/devices", { headers: { ...ownerAuth, "if-none-match": etag } });
    expect(notMod.status).toBe(304);

    // 2. Quotas reflect normalized tier
    const qRes = await ctx.app.request(`/api/agent/quotas?device_id=${devHash}`, { headers: ownerAuth });
    expect(qRes.status).toBe(200);
    const qBody = (await qRes.json()) as { tools: { claude_code: { tier: string } } };
    expect(qBody.tools.claude_code.tier).toBe("MAX 5X");

    // 3. Dispatch task -> WS runs it -> finished saved in DB
    const dispRes = await ctx.app.request(`/api/tasks/dispatch/${devHash}`, json({ action: "shell", payload: { command: "echo hi", conversation_id: "conv-1" } }, ownerAuth));
    expect(dispRes.status).toBe(200);
    const created = (await dispRes.json()) as { id: string; status: string };
    await new Promise((r) => setTimeout(r, 120));
    const gotRes = await ctx.app.request(`/api/tasks/${created.id}`, { headers: ownerAuth });
    const got = (await gotRes.json()) as { status: string; stdout: string };
    expect(got.status).toBe("succeeded");
    expect(got.stdout).toBe("hello from ws\n");

    // 4. Input after task finished queues a follow-up
    const inpRes = await ctx.app.request(`/api/tasks/${created.id}/input`, json({ input: "next step" }, ownerAuth));
    const inp = (await inpRes.json()) as { ok: boolean; queued: boolean };
    expect(inp.ok).toBe(false);
    expect(inp.queued).toBe(true);
    expect((await peekFollowups(ownerId, "conv-1")).map((x) => x.text)).toEqual(["next step"]);
    expect((await popFollowups(ownerId, "conv-1")).length).toBe(1);

    // 5. Device file streaming with Range 206
    const streamRes = await ctx.app.request(`/api/devices/${devHash}/files/stream?path=/tmp/demo.txt`, {
      headers: { ...ownerAuth, range: "bytes=2-5" },
    });
    expect(streamRes.status).toBe(206);
    expect(streamRes.headers.get("content-range")).toBe("bytes 2-5/11");
    expect(await streamRes.text()).toBe("2345");

    // 6. Terminal open / input / resize / close
    const termOpen = await ctx.app.request("/api/terminal/open", json({ device_id: devHash, cwd: "/tmp" }, ownerAuth));
    expect(termOpen.status).toBe(200);
    const { term_id: termId } = (await termOpen.json()) as { term_id: string };
    expect(termId.startsWith("term-")).toBe(true);
    expect((await ctx.app.request(`/api/terminal/${termId}/input`, json({ data: "ls\n" }, ownerAuth))).status).toBe(200);
    expect((await ctx.app.request(`/api/terminal/${termId}/resize`, json({ cols: 100, rows: 30 }, ownerAuth))).status).toBe(200);
    expect((await ctx.app.request(`/api/terminal/${termId}/close`, { method: "POST", headers: ownerAuth })).status).toBe(200);

    // 7. Preview ports + session + sandboxed proxy path rewrite
    const portsRes = await ctx.app.request(`/api/preview/ports?device_id=${devHash}`, { headers: ownerAuth });
    expect(((await portsRes.json()) as { ports: unknown[] }).ports).toHaveLength(1);
    const sessRes = await ctx.app.request("/api/preview/session", json({ device_id: devHash, port: 3000 }, ownerAuth));
    const { token: prevTok } = (await sessRes.json()) as { token: string };
    const proxyRes = await ctx.app.request(`/api/preview/t/${prevTok}/index.html`);
    expect(proxyRes.status).toBe(200);
    expect(proxyRes.headers.get("content-security-policy")).toContain("sandbox");
    expect(await proxyRes.text()).toBe(`<a href="/api/preview/t/${prevTok}/about">hi</a>`);

    // 8. Git native diff RPC
    const diffRes = await ctx.app.request("/api/git/diff", json({ device_id: devHash, cwd: "/repo" }, ownerAuth));
    expect(diffRes.status).toBe(200);
    expect(((await diffRes.json()) as { branch: string }).branch).toBe("main");

    // 9. Scheduled tasks CRUD + run now
    const stCreate = await ctx.app.request(
      "/api/scheduled-tasks",
      json({ title: "每日巡检", device: devHash, agent: "shell", prompt: "uptime", schedule: "daily:08:00" }, ownerAuth),
    );
    expect(stCreate.status).toBe(200);
    const stObj = (await stCreate.json()) as { id: string; next_run_at: string };
    expect(stObj.next_run_at).toBeTruthy();
    const stRun = await ctx.app.request(`/api/scheduled-tasks/${stObj.id}/run`, { method: "POST", headers: ownerAuth });
    expect(((await stRun.json()) as { ok: boolean }).ok).toBe(true);
    expect((await ctx.app.request(`/api/scheduled-tasks/${stObj.id}`, { method: "DELETE", headers: ownerAuth })).status).toBe(200);

    // 10. Collector command queue + poll + ack
    const cmdQ = await ctx.app.request(`/api/devices/${machineId}/command?action=ping_test`, { method: "POST", headers: ownerAuth });
    const { command_id: cmdId } = (await cmdQ.json()) as { command_id: number };
    const pollRes = await ctx.app.request("/api/devices/commands", { headers: { "x-device-id": devHash } });
    expect(((await pollRes.json()) as { id: number }[]).some((c) => c.id === cmdId)).toBe(true);
    expect((await ctx.app.request(`/api/devices/commands/${cmdId}/ack`, { method: "POST", headers: { "x-device-id": devHash } })).status).toBe(200);

    ws.close();
  });
});
