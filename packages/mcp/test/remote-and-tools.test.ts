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

describe("RemoteClient authentication & fallback behavior", () => {
  it("re-reads rotated token via tokenLoader when initial token is rejected", async () => {
    let exchangeAttempts = 0;
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (url.pathname === "/api/auth/me") return new Response("{}", { status: 401 });
      if (url.pathname === "/api/auth/token-exchange") {
        exchangeAttempts++;
        if (headers.get("x-collector-token") === "new-token") {
          return Response.json({ access_token: "fresh-jwt" });
        }
        return new Response("{}", { status: 401 });
      }
      if (headers.get("authorization") === "Bearer fresh-jwt" && url.pathname === "/api/todos") {
        return Response.json({ todos: [] });
      }
      return new Response("{}", { status: 401 });
    }) as typeof fetch;

    const remote = new RemoteClient("https://mem.example/", "old-token", async () => "new-token", fakeFetch);
    const data = await remote.get<{ todos: unknown[] }>("/api/todos");
    expect(data).toEqual({ todos: [] });
    expect(exchangeAttempts).toBe(2);
  });

  it("retries once with a fresh JWT when an API call returns 401", async () => {
    let jwtVersion = 0;
    let apiCalls = 0;
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      if (url.pathname === "/api/auth/me") return new Response("{}", { status: 401 });
      if (url.pathname === "/api/auth/token-exchange") {
        jwtVersion++;
        return Response.json({ access_token: `jwt-${jwtVersion}` });
      }
      apiCalls++;
      if (apiCalls === 1) return new Response("expired", { status: 401 });
      if (headers.get("authorization") === "Bearer jwt-2") {
        return Response.json({ ok: true });
      }
      return new Response("bad", { status: 401 });
    }) as typeof fetch;

    const remote = new RemoteClient("https://mem.example", "ct-valid", undefined, fakeFetch);
    expect(await remote.get("/api/ping")).toEqual({ ok: true });
    expect(jwtVersion).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it("falls back from semantic search to keyword search when embedder errors", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      if (url.pathname === "/api/auth/me") return Response.json({ id: "u1" });
      if (url.pathname === "/api/memory/semantic") return new Response("down", { status: 503 });
      if (url.pathname === "/api/search") {
        return Response.json({ results: [{ title: "Fallback Doc", snippet: "hit" }] });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const remote = new RemoteClient("https://mem.example", "valid-jwt", undefined, fakeFetch);
    const results = await remote.search("deploy pipeline", 3);
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Fallback Doc");
    expect(seen).toContain("/api/memory/semantic");
    expect(seen).toContain("/api/search");
  });

  it("returns actionable message on 502/503 sign-in outage", async () => {
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/auth/me") return new Response("bad gateway", { status: 502 });
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;

    const remote = new RemoteClient("https://mem.example", "ct-1", undefined, fakeFetch);
    await expect(remote.get("/api/todos")).rejects.toThrow(/returned 502/);
  });

  it("executes todo_add and todo_list tools end-to-end", async () => {
    const stored: { id: string; title: string; status: string }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      if (url.pathname === "/api/auth/me") return Response.json({ id: "u1" });
      if (method === "POST" && url.pathname === "/api/todos") {
        const body = JSON.parse(String(init.body)) as { title: string };
        const item = { id: "t1", title: body.title, status: "open" };
        stored.push(item);
        return Response.json({ created: true, todo: item });
      }
      if (method === "GET" && url.pathname === "/api/todos") {
        return Response.json({ open: stored });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = await connect(new RemoteClient("https://mem.example", "jwt-ok", undefined, fakeFetch));
    const added = await client.callTool({ name: "todo_add", arguments: { title: "修复分享链接权限" } });
    expect(JSON.stringify(added)).toContain("修复分享链接权限");
    const listed = await client.callTool({ name: "todo_list", arguments: {} });
    expect(JSON.stringify(listed)).toContain("修复分享链接权限");
  });
});
