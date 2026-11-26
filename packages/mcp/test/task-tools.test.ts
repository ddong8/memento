import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { RemoteClient } from "../src/remote.js";
import { createServer } from "../src/server.js";

async function connect(remote: RemoteClient) {
  const server = createServer(remote);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

describe("outside agents running tasks on the user's devices", () => {
  it("starts an agent on a device, sees it ask for approval, answers it and stops it", async () => {
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    let polls = 0;
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/auth/me") return Response.json({ id: "u1" });
      if (url.pathname === "/api/devices") {
        return Response.json([
          { id: "1", name: "haixingdeMac-mini.local (Darwin)", device_id: "hash-mini", online: true, collector_version: "1.0.162", acp_agents: ["gemini"] },
          { id: "2", name: "vps3 (Linux)", device_id: "hash-vps3", online: true, collector_version: "1.0.162", acp_agents: [] },
        ]);
      }
      if (method === "POST" && url.pathname === "/api/tasks/dispatch/hash-vps3") {
        return Response.json({ id: "task-1", status: "running", action: "agent", payload: body?.payload, events: [] });
      }
      if (method === "GET" && url.pathname === "/api/tasks/task-1") {
        polls += 1;
        const events = polls >= 2 ? [{ kind: "question", id: "r1:approval", question: "运行命令：npm publish", options: [{ label: "允许" }, { label: "拒绝" }], status: "waiting" }] : [];
        return Response.json({ id: "task-1", status: "running", action: "agent", payload: { binary: "claude" }, events, stdout: "正在发布" });
      }
      if (method === "POST" && (url.pathname === "/api/tasks/task-1/input" || url.pathname === "/api/tasks/task-1/cancel")) return Response.json({ ok: true });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = await connect(new RemoteClient("https://mem.example", "jwt-ok", undefined, fakeFetch));

    expect(textOf(await client.callTool({ name: "device_list", arguments: {} }))).toContain("ACP: gemini");

    const started = textOf(await client.callTool({ name: "task_start", arguments: { device: "vps3", agent: "claude", prompt: "发布新版本", cwd: "/srv/app", permission_mode: "supervised" } }));
    expect(started).toContain("Started on vps3 (Linux)");
    const dispatch = calls.find((c) => c.path === "/api/tasks/dispatch/hash-vps3")!;
    expect(dispatch.body).toMatchObject({ action: "agent", payload: { binary: "claude", prompt: "发布新版本", cwd: "/srv/app", permission_mode: "supervised" } });

    const status = textOf(await client.callTool({ name: "task_status", arguments: { task_id: "task-1", wait_seconds: 10 } }));
    expect(status).toContain("WAITING FOR AN ANSWER (question_id r1:approval): 运行命令：npm publish");

    await client.callTool({ name: "task_reply", arguments: { task_id: "task-1", text: "允许", question_id: "r1:approval" } });
    expect(calls.find((c) => c.path === "/api/tasks/task-1/input")!.body).toEqual({ input: "允许", question_id: "r1:approval" });
    await client.callTool({ name: "task_stop", arguments: { task_id: "task-1" } });
    expect(calls.some((c) => c.path === "/api/tasks/task-1/cancel")).toBe(true);
  }, 20_000);

  it("maps Antigravity to its binary and refuses an ambiguous device", async () => {
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/me") return Response.json({ id: "u1" });
      if (url.pathname === "/api/devices") return Response.json([{ name: "mac-a", device_id: "a" }, { name: "mac-b", device_id: "b" }]);
      if (url.pathname === "/api/tasks/dispatch/a") return Response.json({ id: "t", status: "running", payload: JSON.parse(String(init.body)).payload, events: [] });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const client = await connect(new RemoteClient("https://mem.example", "jwt-ok", undefined, fakeFetch));
    expect(textOf(await client.callTool({ name: "task_start", arguments: { device: "mac", agent: "claude", prompt: "x" } }))).toContain("be more specific");
    expect(textOf(await client.callTool({ name: "task_start", arguments: { device: "mac-a", agent: "antigravity", prompt: "x" } }))).toContain("on agy");
  });
});
