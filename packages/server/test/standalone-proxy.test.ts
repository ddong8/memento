// Unit tests for single-port standalone web upstream reverse proxy & no-Redis /health/deep.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { loadSettings } from "../src/config";
import type { Deps } from "../src/context";

describe("standalone webUpstream proxy", () => {
  let upstream: http.Server;
  let upstreamUrl = "";

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-web": "standalone" });
        res.end("<!doctype html><html><body>Memento Web Home</body></html>");
        return;
      }
      if (req.url === "/auth/login?next=%2Fask") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": ["m_test=1; Path=/", "m_lang=zh; Path=/"],
        });
        res.end("<html><body>Login Page</body></html>");
        return;
      }
      if (req.url === "/old-redirect") {
        res.writeHead(302, { location: "/ask" });
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("web 404");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const addr = upstream.address() as AddressInfo;
    upstreamUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  function makeApp(webUpstream: string) {
    const settings = loadSettings({
      MEMENTO_DEBUG: "1",
      MEMENTO_REDIS_URL: "",
      MEMENTO_WEB_UPSTREAM: webUpstream,
      MEMENTO_BUILD_SHA: "standalone-test",
    });
    const fakeDb = {
      execute: async () => [{ "?column?": 1 }],
    } as unknown as Deps["db"];
    const deps: Deps = {
      settings,
      db: fakeDb,
      redis: () => null,
    };
    return createApp(deps);
  }

  it("keeps GET / as JSON when webUpstream is empty", async () => {
    const app = makeApp("");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name?: string };
    expect(body.name).toBe("Memento");
  });

  it("proxies /, HTML pages, Set-Cookie, and 302 redirects while keeping /health & /api/* on the TS server", async () => {
    const app = makeApp(upstreamUrl);

    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("x-web")).toBe("standalone");
    expect(await home.text()).toContain("Memento Web Home");

    const login = await app.request("/auth/login?next=%2Fask");
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("Login Page");
    expect(login.headers.get("set-cookie")).toContain("m_test=1");

    const redir = await app.request("/old-redirect");
    expect(redir.status).toBe(302);
    expect(redir.headers.get("location")).toBe("/ask");

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", version: "standalone-test" });

    const deep = await app.request("/health/deep");
    expect(deep.status).toBe(200);
    expect(await deep.json()).toEqual({
      status: "ok",
      version: "standalone-test",
      db: "ok",
      redis: "local",
      web: "ok",
    });

    const api404 = await app.request("/api/non-existent-route");
    expect(api404.status).toBe(404);
    expect(await api404.json()).toEqual({ detail: "Not Found" });
  });
});
