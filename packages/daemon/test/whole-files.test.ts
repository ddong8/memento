import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import { IngestClient, type IngestDocument } from "../src/ingest.js";
import { FileWatcher } from "../src/watcher.js";

// Files that go up whole (a subagent's .meta.json, a memory note). On 2026-10-28 each restart of a
// Windows collector sent all 1,600 of them again, one request each, 440 a minute: the times they were
// sent at were only kept in memory.

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

interface Sent {
  singles: string[];
  batches: string[][];
  failBatch?: (doc: IngestDocument) => boolean;
}

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "whole-files-"));
  homes.push(home);
  const sent: Sent = { singles: [], batches: [] };
  const ingest = {
    ingestDocument: async (doc: IngestDocument) => {
      sent.singles.push(doc.relativePath);
      return { ok: true };
    },
    ingestBatch: async (docs: IngestDocument[]) => {
      sent.batches.push(docs.map((d) => d.relativePath));
      return docs.map((d) => ({ ok: !sent.failBatch?.(d), retryable: false }));
    },
  } as unknown as IngestClient;
  const make = () => new FileWatcher({ extraWatchDirs: [] } as unknown as CollectorConfig, ingest, () => {}, home);
  const dir = join(home, ".claude", "projects", "-w-app");
  await mkdir(dir, { recursive: true });
  return { home, dir, sent, make };
}

type Internals = { enqueue(file: string, tool: string): void; processing: boolean; queue: unknown[]; loadOffsets(): Promise<void> };
const internals = (w: FileWatcher) => w as unknown as Internals;

async function drain(w: FileWatcher) {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!internals(w).processing && !internals(w).queue.length) return;
  }
  throw new Error("queue never drained");
}

describe("files sent whole", () => {
  it("aren't sent again after a restart unless they change", async () => {
    const { dir, sent, make } = await setup();
    const a = join(dir, "agent-1.meta.json");
    const b = join(dir, "memory", "note.md");
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(a, '{"agentType":"Explore"}');
    await writeFile(b, "# 记忆\n");

    const first = make();
    expect(await first.syncFile(a, "claude_code")).toBe(true);
    expect(await first.syncFile(b, "claude_code")).toBe(true);
    await first.dispose();
    expect(sent.singles).toHaveLength(2);

    const second = make(); // the collector restarted
    await internals(second).loadOffsets();
    expect(await second.syncFile(a, "claude_code")).toBe(false);
    expect(await second.syncFile(b, "claude_code")).toBe(false);
    expect(sent.singles).toHaveLength(2);

    await writeFile(a, '{"agentType":"Plan"}');
    const later = new Date(Date.now() + 5_000);
    await utimes(a, later, later);
    expect(await second.syncFile(a, "claude_code")).toBe(true);
    expect(sent.singles).toEqual(["projects/-w-app/agent-1.meta.json", "projects/-w-app/memory/note.md", "projects/-w-app/agent-1.meta.json"]);
    await second.dispose();
  });

  it("go up together, a batch to a request, and a session log keeps its own way", async () => {
    const { dir, sent, make } = await setup();
    const files: string[] = [];
    for (let i = 0; i < 120; i++) {
      const f = join(dir, `agent-${i}.meta.json`);
      await writeFile(f, `{"i":${i}}`);
      files.push(f);
    }
    const log = join(dir, "s.jsonl");
    await writeFile(log, `${JSON.stringify({ type: "user", cwd: "/w/app", message: { role: "user", content: "hi" } })}\n`);
    files.splice(60, 0, log);

    const w = make();
    for (const f of files) internals(w).enqueue(f, "claude_code");
    await drain(w);
    expect(sent.batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(sent.singles).toEqual(["projects/-w-app/s.jsonl"]);
    await w.dispose();
  });

  it("send again only the ones that didn't go in", async () => {
    const { dir, sent, make } = await setup();
    const files = [0, 1, 2].map((i) => join(dir, `agent-${i}.meta.json`));
    for (const f of files) await writeFile(f, "{}");
    sent.failBatch = (d) => d.relativePath.endsWith("agent-1.meta.json");

    const w = make();
    for (const f of files) internals(w).enqueue(f, "claude_code");
    await drain(w);
    sent.failBatch = undefined;
    for (const f of files) internals(w).enqueue(f, "claude_code"); // the next scan
    await drain(w);
    expect(sent.batches).toEqual([files.map((f) => `projects/-w-app/${f.split("/").pop()}`)]);
    expect(sent.singles).toEqual(["projects/-w-app/agent-1.meta.json"]);
    await w.dispose();
  });

  it("split by size: a big file goes on its own", async () => {
    const { dir, sent, make } = await setup();
    const big = "x".repeat(700 * 1024);
    const files = [0, 1, 2].map((i) => join(dir, `n${i}.md`));
    await writeFile(files[0]!, big);
    await writeFile(files[1]!, big);
    await writeFile(files[2]!, "small");

    const w = make();
    for (const f of files) internals(w).enqueue(f, "claude_code");
    await drain(w);
    expect(sent.singles).toEqual(["projects/-w-app/n0.md"]);
    expect(sent.batches).toEqual([["projects/-w-app/n1.md", "projects/-w-app/n2.md"]]);
    await w.dispose();
  });
});

describe("IngestClient.ingestBatch", () => {
  const config = { token: "t", deviceId: "d", deviceName: "n", platform: "win32", serverUrl: "https://mem.example" } as unknown as CollectorConfig;
  const doc = (p: string): IngestDocument => ({ toolId: "claude_code", category: "conversation", contentType: "json", relativePath: p, content: "{}", contentHash: "h" });

  it("reads each file's result, in order", async () => {
    const urls: string[] = [];
    const client = new IngestClient(config, () => {}, (async (url: string, init: RequestInit) => {
      urls.push(url);
      const body = JSON.parse(String(init.body)) as { files: unknown[] };
      expect(body.files).toHaveLength(2);
      return new Response(JSON.stringify({ results: [{ ok: true }, { ok: false, error: "x" }] }), { status: 200 });
    }) as typeof fetch);
    expect((await client.ingestBatch([doc("a"), doc("b")])).map((r) => r.ok)).toEqual([true, false]);
    expect(urls).toEqual(["https://mem.example/api/ingest/files"]);
  });

  it("falls back to one by one on a server without it, and stays there for a while", async () => {
    const urls: string[] = [];
    const client = new IngestClient(config, () => {}, (async (url: string) => {
      urls.push(url.replace("https://mem.example", ""));
      return url.endsWith("/files") ? new Response("Not Found", { status: 404 }) : new Response('{"document_id":"x"}', { status: 200 });
    }) as typeof fetch);
    expect((await client.ingestBatch([doc("a"), doc("b")])).map((r) => r.ok)).toEqual([true, true]);
    expect((await client.ingestBatch([doc("c"), doc("d")])).map((r) => r.ok)).toEqual([true, true]);
    expect(urls).toEqual(["/api/ingest/files", "/api/ingest/file", "/api/ingest/file", "/api/ingest/file", "/api/ingest/file"]);
  });

  it("a request that fails leaves them all unsent", async () => {
    const client = new IngestClient(config, () => {}, (async () => new Response("busy", { status: 503 })) as typeof fetch);
    expect((await client.ingestBatch([doc("a"), doc("b")])).map((r) => r.ok)).toEqual([false, false]);
  });
});
