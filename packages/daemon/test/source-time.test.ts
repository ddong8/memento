import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import { IngestClient, type IngestDocument } from "../src/ingest.js";
import { FileWatcher } from "../src/watcher.js";

// Uploads say when the file last changed (#7): the server filed everything a first sync sent as
// today's, and "what did I do today" answered with weeks-old conversations.

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

const config = { serverUrl: "https://mem.example.com", token: "tok", deviceId: "dev-1", deviceName: "pc", platform: "linux" } as unknown as CollectorConfig;

function client() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const raw = init.body as Uint8Array | string;
    const text = typeof raw === "string" ? raw : (() => {
      try {
        return gunzipSync(raw).toString("utf8");
      } catch {
        return Buffer.from(raw).toString("utf8");
      }
    })();
    bodies.push(JSON.parse(text));
    return Response.json({ status: "ok" });
  }) as typeof fetch;
  return { ingest: new IngestClient(config, () => {}, fetchImpl), bodies };
}

const doc = (extra: Partial<IngestDocument> = {}): IngestDocument => ({
  toolId: "claude_code",
  category: "conversation",
  contentType: "jsonl",
  relativePath: "projects/-w-app/s.jsonl",
  content: '{"type":"user"}',
  contentHash: "h",
  mode: "full",
  ...extra,
});

describe("the file's time goes up with it", () => {
  it("as timestamp in seconds, left out when unknown", async () => {
    const { ingest, bodies } = client();
    await ingest.ingestDocument(doc({ mtimeMs: 1_754_611_200_500 }));
    await ingest.ingestDocument(doc());
    expect(bodies[0]?.timestamp).toBe(1_754_611_200.5);
    expect("timestamp" in (bodies[1] ?? {})).toBe(false);
  });

  it("from the log's mtime and a whole file's", async () => {
    const home = await mkdtemp(join(tmpdir(), "source-time-"));
    homes.push(home);
    const seen: IngestDocument[] = [];
    const ingest = {
      ingestDocument: async (d: IngestDocument) => (seen.push(d), { ok: true }),
      ingestBatch: async (ds: IngestDocument[]) => (seen.push(...ds), ds.map(() => ({ ok: true }))),
    } as unknown as IngestClient;
    const dir = join(home, ".claude", "projects", "-w-app");
    await mkdir(dir, { recursive: true });
    const log = join(dir, "s.jsonl");
    const note = join(dir, "agent-1.meta.json");
    await writeFile(log, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    await writeFile(note, '{"agentType":"Explore"}');
    const old = new Date("2026-08-08T10:00:00Z");
    await utimes(log, old, old);
    await utimes(note, old, old);

    const w = new FileWatcher({ extraWatchDirs: [] } as unknown as CollectorConfig, ingest, () => {}, home);
    await w.syncFile(log, "claude_code");
    await w.syncFile(note, "claude_code");
    await w.dispose();
    expect(seen.map((d) => d.mtimeMs)).toEqual([old.getTime(), old.getTime()]);
  });
});
