import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { RemoteClient } from "../src/remote.js";
import { bestSkill, createServer } from "../src/server.js";

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;

/** A fake Memento API: collector token "ct-1" exchanges for JWT "jwt-1". */
function fakeFetch(routes: Record<string, Handler>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const headers = new Headers(init.headers);
    if (url.pathname === "/api/auth/me") return new Response("{}", { status: headers.get("authorization") === "Bearer jwt-1" ? 200 : 401 });
    if (url.pathname === "/api/auth/token-exchange") {
      return headers.get("x-collector-token") === "ct-1"
        ? Response.json({ access_token: "jwt-1" })
        : new Response("{}", { status: 401 });
    }
    if (headers.get("authorization") !== "Bearer jwt-1") return new Response("{}", { status: 401 });
    const handler = routes[`${method} ${url.pathname}`];
    const out = handler?.(url, init);
    if (!out) return new Response("not found", { status: 404 });
    return Response.json(out.body, { status: out.status ?? 200 });
  }) as typeof fetch;
}

async function connect(remote: RemoteClient) {
  const server = createServer(remote);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (res: unknown) => ((res as { content: { text: string }[] }).content[0]?.text ?? "");

describe("memento MCP", () => {
  it("lists the same tools as the Python server", async () => {
    const client = await connect(new RemoteClient("http://m", "ct-1", undefined, fakeFetch({})));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "daily_summary",
        "memory_blueprint",
        "memory_check_rule",
        "memory_context",
        "memory_conversation",
        "memory_core",
        "memory_graph",
        "memory_open",
        "memory_pitfall",
        "memory_project_map",
        "memory_recall",
        "memory_search",
        "memory_skill",
        "memory_store",
        "mind_resonance",
        "todo_add",
        "todo_list",
        "todo_update",
      ].sort(),
    );
    const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
    expect(resources).toEqual(["memory://core", "memory://projects", "memory://resonance"]);
  });

  it("activates mind resonance with markdown output", async () => {
    const calls: string[] = [];
    const client = await connect(
      new RemoteClient(
        "http://m",
        "ct-1",
        undefined,
        fakeFetch(
          {
            "GET /api/memory/resonance": (url) => ({
              body: { markdown: `【心领神会】query=${url.searchParams.get("query")}` },
            }),
          },
          calls,
        ),
      ),
    );
    const out = textOf(await client.callTool({ name: "mind_resonance", arguments: { query: "继续，发布", project: "memento" } }));
    expect(out).toContain("【心领神会】query=继续，发布");
    expect(calls).toContain("GET /api/memory/resonance?format=markdown&project=memento&query=%E7%BB%A7%E7%BB%AD%EF%BC%8C%E5%8F%91%E5%B8%83");
  });

  it("reads memory://resonance resource cleanly", async () => {
    const client = await connect(
      new RemoteClient(
        "http://m",
        "ct-1",
        undefined,
        fakeFetch({
          "GET /api/memory/resonance": () => ({
            body: { markdown: "# Mind Resonance Snapshot\n- Rule: no bold" },
          }),
        }),
      ),
    );
    const res = await client.readResource({ uri: "memory://resonance" });
    expect((res.contents[0] as { text: string })?.text).toContain("# Mind Resonance Snapshot");
  });

  it("searches semantically and falls back to keyword search", async () => {
    const calls: string[] = [];
    const client = await connect(
      new RemoteClient(
        "http://m",
        "ct-1",
        undefined,
        fakeFetch(
          {
            "GET /api/memory/semantic": () => ({ body: { results: [] } }),
            "GET /api/search": (url) => ({
              body: { results: [{ id: "d1", title: `hit for ${url.searchParams.get("q")}`, tool_id: "codex", relative_path: "a.jsonl", synced_at: "2026-09-20T01:02:03Z", snippet: "…" }] },
            }),
          },
          calls,
        ),
      ),
    );
    const out = textOf(await client.callTool({ name: "memory_search", arguments: { query: "gitops", limit: 3 } }));
    expect(out).toContain("## Result 1: hit for gitops (codex)");
    expect(out).toContain("**Date**: 2026-09-20");
    expect(calls).toContain("GET /api/memory/semantic?q=gitops&limit=3");
    expect(calls).toContain("GET /api/search?q=gitops&limit=3");
  });

  it("closes a todo by its id prefix", async () => {
    let put: unknown;
    const client = await connect(
      new RemoteClient(
        "http://m",
        "ct-1",
        undefined,
        fakeFetch({
          "GET /api/todos": () => ({ body: { open: [{ id: "abcd1234-0000-0000-0000-000000000000", title: "ship it" }], closed: [] } }),
          "PUT /api/todos/abcd1234-0000-0000-0000-000000000000": (_u, init) => {
            put = JSON.parse(String(init.body));
            return { body: { todo: { id: "abcd1234-0000-0000-0000-000000000000", title: "ship it", status: "done" } } };
          },
        }),
      ),
    );
    const out = textOf(await client.callTool({ name: "todo_update", arguments: { todo_id: "abcd1234", status: "done" } }));
    expect(put).toEqual({ status: "done" });
    expect(out).toBe("Updated: - [abcd1234] ship it [done]");
  });

  it("re-reads a rotated collector token when the old one is rejected", async () => {
    let loads = 0;
    const remote = new RemoteClient("http://m", "ct-old", async () => (loads++, "ct-1"), fakeFetch({ "GET /api/skills": () => ({ body: { published: [] } }) }));
    const client = await connect(remote);
    expect(textOf(await client.callTool({ name: "memory_skill", arguments: {} }))).toBe("No published skills yet.");
    expect(loads).toBe(1);
  });

  it("reports API errors as tool text instead of failing the call", async () => {
    const client = await connect(new RemoteClient("http://m", "ct-1", undefined, fakeFetch({})));
    const out = textOf(await client.callTool({ name: "memory_open", arguments: { doc_id: "missing" } }));
    expect(out).toMatch(/^Failed to fetch document: HTTP 404/);
  });
});

it("picks the skill that matches the most words", () => {
  const skills = [
    { slug: "memento-deploy", title: "Deploy memento", description: "push main, watch fleet" },
    { slug: "switch-model", title: "Switch the AI model", description: "change provider" },
  ];
  expect(bestSkill(skills, "deploy memento")?.slug).toBe("memento-deploy");
  expect(bestSkill(skills, "switch-model")?.slug).toBe("switch-model");
  expect(bestSkill(skills, "unrelated")).toBeUndefined();
});
