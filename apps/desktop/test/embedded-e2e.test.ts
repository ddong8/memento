// Real zero-Docker end-to-end test of the 3-in-1 embedded Memento stack:
//   Embedded PostgreSQL 16 (UTF8 + pgvector) + Next.js standalone Web UI + @memento/server
// Runs automatically whenever dist-embedded/ (or MEMENTO_E2E_BUNDLE_DIR) has the full bundled runtime.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { EmbeddedServer } from "../src/embedded-server";

const PG_CTL = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
const BUNDLE_DIR = process.env.MEMENTO_E2E_BUNDLE_DIR
  ? resolve(process.env.MEMENTO_E2E_BUNDLE_DIR)
  : resolve(__dirname, "..", "dist-embedded");

const HAS_FULL_EMBEDDED =
  existsSync(join(BUNDLE_DIR, "server", "main.mjs")) &&
  existsSync(join(BUNDLE_DIR, "web", "apps", "web", "server.js")) &&
  existsSync(join(BUNDLE_DIR, "embedded-pg", "native", "bin", PG_CTL));

describe.skipIf(!HAS_FULL_EMBEDDED)("zero-Docker 3-in-1 embedded stack E2E", () => {
  it(
    "boots PG16 + pgvector + Next.js standalone + TS server on one port, serves web UI, registers owner, searches Chinese FTS, and round-trips full export/import",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "memento-e2e-"));
      const srv = new EmbeddedServer({ bundleDir: BUNDLE_DIR, dataDir, port: 18770 });
      expect(srv.isAvailable()).toBe(true);

      try {
        const logs: string[] = [];
        const res = await srv.start((line) => logs.push(line));
        expect(res.ok, `start failed: ${res.error}\nlogs:\n${logs.join("\n")}`).toBe(true);
        const base = res.url!;

        // 1) /health & /health/deep
        const health = (await (await fetch(`${base}/health`)).json()) as { status?: string };
        expect(health.status).toBe("ok");
        const deep = (await (await fetch(`${base}/health/deep`)).json()) as Record<string, string>;
        expect(deep.status).toBe("ok");
        expect(deep.db).toBe("ok");
        expect(deep.redis).toBe("local");
        expect(deep.web).toBe("ok");

        // 2) Same-origin Next.js Web UI & static asset serving
        const homeRes = await fetch(`${base}/`);
        expect(homeRes.status).toBe(200);
        const homeHtml = await homeRes.text();
        expect(homeHtml.includes("__next") || homeHtml.includes("Memento")).toBe(true);

        const loginRes = await fetch(`${base}/auth/login`);
        expect(loginRes.status).toBe(200);
        const loginHtml = await loginRes.text();
        const staticMatch = loginHtml.match(/\/_next\/static\/[^"'\s]+\.(?:js|css)/);
        expect(staticMatch, "expected /_next/static asset in /auth/login HTML").toBeTruthy();
        const staticRes = await fetch(`${base}${staticMatch![0]}`);
        expect(staticRes.status).toBe(200);

        // 3) First-run owner registration & login
        const regMode = (await (await fetch(`${base}/api/auth/registration-mode`)).json()) as { has_any_user?: boolean };
        expect(regMode.has_any_user).toBe(false);
        const reg = await fetch(`${base}/api/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@local.test", password: "StrongPassword123!", name: "LocalOwner" }),
        });
        expect(reg.status).toBe(200);
        const loginApi = await fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "owner@local.test", password: "StrongPassword123!" }),
        });
        expect(loginApi.status).toBe(200);
        const loginBody = (await loginApi.json()) as { access_token?: string };
        const jwt = loginBody.access_token!;
        expect(jwt).toBeTruthy();

        const me = (await (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${jwt}` } })).json()) as {
          role?: string;
          collector_token?: string;
        };
        expect(me.role).toBe("owner");
        expect(me.collector_token).toBeTruthy();

        // 4) Chinese Todo CRUD
        const todoCreate = await fetch(`${base}/api/todos`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
          body: JSON.stringify({ title: "单机免Docker闭环测试待办" }),
        });
        expect(todoCreate.status).toBe(200);
        const todos = await (await fetch(`${base}/api/todos`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
        expect(JSON.stringify(todos)).toContain("单机免Docker闭环测试待办");

        // 5) Ingest Chinese conversation & Chinese full-text search (UTF8 + @node-rs/jieba + PG16)
        const content =
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "请帮我检查单机内嵌数据库的中文全文检索是否正常" },
            timestamp: new Date().toISOString(),
          }) +
          "\n" +
          JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: "单机内嵌 PostgreSQL 16 中文检索正常" },
            timestamp: new Date().toISOString(),
          }) +
          "\n";
        const ing = await fetch(`${base}/api/ingest/file`, {
          method: "POST",
          headers: {
            "X-Collector-Token": me.collector_token!,
            "X-Device-Name": "TestMac (Darwin)",
            "X-Device-Platform": "Darwin",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            tool: "claude_code",
            category: "conversation",
            content_type: "jsonl",
            relative_path: "memento-standalone/sessions/test-session.jsonl",
            hash: "e2e-hash-1",
            mode: "full",
            file_size: Buffer.byteLength(content),
            content,
            metadata: { project_name: "memento-standalone" },
          }),
        });
        expect(ing.status, await ing.clone().text()).toBe(200);

        const search = (await (
          await fetch(`${base}/api/search?q=${encodeURIComponent("中文全文检索")}`, {
            headers: { Authorization: `Bearer ${jwt}` },
          })
        ).json()) as { results?: unknown[]; items?: unknown[] } | unknown[];
        const hits = Array.isArray(search) ? search : (search.results ?? search.items ?? []);
        expect(hits.length).toBeGreaterThan(0);

        // 6) Full export & import round-trip (standalone <-> server migration path)
        const expRes = await fetch(`${base}/api/data/export?include_full=1`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        expect(expRes.status).toBe(200);
        const zipBuf = Buffer.from(await expRes.arrayBuffer());
        expect(zipBuf.byteLength).toBeGreaterThan(200);

        const form = new FormData();
        form.append("file", new Blob([zipBuf], { type: "application/zip" }), "backup.zip");
        const impRes = await fetch(`${base}/api/data/import`, {
          method: "POST",
          headers: { Authorization: `Bearer ${jwt}` },
          body: form,
        });
        expect(impRes.status).toBe(200);
        const impBody = (await impRes.json()) as { ok?: boolean; counts?: Record<string, number> };
        expect(impBody.ok).toBe(true);
      } finally {
        await srv.stop();
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
