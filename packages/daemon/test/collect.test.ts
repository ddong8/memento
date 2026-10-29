import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import { IngestClient, type IngestDocument, type UploadResult } from "../src/ingest.js";
import { FileWatcher } from "../src/watcher.js";

// What keeps a log's copy on the server whole and single: each slice says where it starts and ends,
// the server answers where its copy ends when they don't follow (409), offsets are written whole, a
// reconcile checks them against the server, and files that just changed go before a backlog.
// 10-27 and 10-28: slices replayed from an offline buffer went in twice.

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

type Reply = (doc: IngestDocument, n: number) => UploadResult;
type Diffs = { tool: string; relativePath: string; expectedOffset: number }[] | null;

async function setup(opts: { reply?: Reply; reconcile?: (files: { tool: string; relativePath: string; offset: number }[]) => Diffs } = {}) {
  const home = await mkdtemp(join(tmpdir(), "collect-"));
  homes.push(home);
  const sent: IngestDocument[] = [];
  const asked: { tool: string; relativePath: string; offset: number }[][] = [];
  const ingest = {
    ingestDocument: async (doc: IngestDocument) => {
      sent.push(doc);
      return opts.reply ? opts.reply(doc, sent.length) : { ok: true };
    },
    reconcile: async (files: { tool: string; relativePath: string; offset: number }[]) => {
      asked.push(files);
      return opts.reconcile ? opts.reconcile(files) : [];
    },
  } as unknown as IngestClient;
  const watcher = new FileWatcher({ extraWatchDirs: [] } as unknown as CollectorConfig, ingest, () => {}, home);
  const projects = join(home, ".claude", "projects");
  const dir = join(projects, "-w-app");
  await mkdir(dir, { recursive: true });
  const w = watcher as unknown as Internals;
  w.targets = new Map([[projects, "claude_code"]]);
  return { home, dir, sent, asked, watcher, w };
}

type Internals = {
  targets: Map<string, string>;
  offsets: Map<string, number>;
  processing: boolean;
  queue: [string, string][];
  urgent: [string, string][];
  enqueue(file: string, tool: string, urgent?: boolean): void;
  loadOffsets(): Promise<boolean>;
  saveOffsets(immediate?: boolean): Promise<void>;
  flushOffsets(): Promise<void>;
};

async function drain(w: Internals) {
  for (let i = 0; i < 500; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (!w.processing && !w.queue.length && !w.urgent.length) return;
  }
  throw new Error("queue never drained");
}

const line = (text: string) => `${JSON.stringify({ type: "user", cwd: "/w/app", message: { role: "user", content: text } })}\n`;
const bytes = (s: string) => Buffer.byteLength(s);

async function quiet(file: string) {
  const old = new Date(Date.now() - 120_000);
  await utimes(file, old, old);
}

describe("each slice of a log goes in once and in order", () => {
  it("says where it ends, and the offset moves there once it went in", async () => {
    const { dir, sent, watcher, w } = await setup();
    const file = join(dir, "s.jsonl");
    const text = line("一") + line("二");
    await writeFile(file, text);
    await watcher.syncFile(file, "claude_code");
    expect(sent.map((d) => [d.mode, d.offset, d.endOffset])).toEqual([["full", 0, bytes(text)]]);
    expect(w.offsets.get(file)).toBe(bytes(text));

    await appendFile(file, line("三"));
    await watcher.syncFile(file, "claude_code");
    expect(sent.map((d) => [d.mode, d.offset, d.endOffset])[1]).toEqual(["delta", bytes(text), bytes(text + line("三"))]);
  });

  it("goes on from where the server's copy ends when the slice doesn't follow it", async () => {
    // A retry whose first try went in: the server already has the first line
    const first = line("服务端已经有的");
    const { dir, sent, watcher, w } = await setup({
      reply: (_d, n) => (n === 1 ? { ok: false, expectedOffset: bytes(first) } : { ok: true }),
    });
    const file = join(dir, "s.jsonl");
    const text = first + line("还没有的");
    await writeFile(file, text);
    await watcher.syncFile(file, "claude_code");
    expect(sent).toHaveLength(2);
    expect([sent[1]!.mode, sent[1]!.offset, sent[1]!.endOffset]).toEqual(["delta", bytes(first), bytes(text)]);
    expect(sent[1]!.content).toBe(line("还没有的").trimEnd());
    expect(w.offsets.get(file)).toBe(bytes(text));
    expect(watcher.stats().conflicts).toBe(1);
  });

  it("starts over when the server's copy ends past the file (the file was replaced)", async () => {
    const { dir, sent, watcher, w } = await setup({
      reply: (_d, n) => (n === 1 ? { ok: false, expectedOffset: 10_000 } : { ok: true }),
    });
    const file = join(dir, "s.jsonl");
    const text = line("新文件");
    await writeFile(file, text);
    w.offsets.set(file, 0);
    await watcher.syncFile(file, "claude_code");
    expect(sent.map((d) => [d.mode, d.offset])).toEqual([["full", 0], ["full", 0]]);
    expect(w.offsets.get(file)).toBe(bytes(text));
  });

  it("gives up after three conflicts in a row, for the next scan", async () => {
    const { dir, sent, watcher, w } = await setup({ reply: () => ({ ok: false, expectedOffset: 0 }) });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一"));
    await watcher.syncFile(file, "claude_code");
    expect(sent).toHaveLength(3);
    expect(w.offsets.get(file)).toBe(0);
  });

  it("skips what the server says it got beyond the slice", async () => {
    // 8 lines of 100 KB: the first slice (512 KB) holds 5, the server already has all 8
    const lines = Array.from({ length: 8 }, (_, i) => line(`${i}`.repeat(100 * 1024)));
    const text = lines.join("");
    const { dir, sent, watcher, w } = await setup({ reply: () => ({ ok: true, nextOffset: bytes(text) }) });
    const file = join(dir, "s.jsonl");
    await writeFile(file, text);
    await watcher.syncFile(file, "claude_code");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.endOffset).toBeLessThan(bytes(text));
    expect(w.offsets.get(file)).toBe(bytes(text));
  });

  it("a slice of blank lines moves only where reading goes on, not the offset", async () => {
    const { dir, sent, watcher, w } = await setup();
    const file = join(dir, "s.jsonl");
    const blank = "\n\n\n";
    await writeFile(file, line("一") + blank);
    await watcher.syncFile(file, "claude_code");
    const after = w.offsets.get(file)!;
    await appendFile(file, line("二"));
    await quiet(file);
    await watcher.syncFile(file, "claude_code");
    // The second slice starts where the server's copy ends, covering the blank lines too
    expect(sent[1]!.offset).toBe(after);
    expect(sent[1]!.endOffset).toBe(bytes(line("一") + blank + line("二")));
  });
});

describe("an upload that fails", () => {
  it("keeps the offset and, the server being down, holds everything back a while", async () => {
    const { dir, watcher, w } = await setup({ reply: () => ({ ok: false, retryable: true, error: "HTTP 503: busy" }) });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一"));
    await watcher.syncFile(file, "claude_code");
    expect(w.offsets.get(file) ?? 0).toBe(0);
    const s = watcher.stats();
    expect(s.failing).toBe(1);
    expect(s.backoff_until).not.toBeNull();
    expect(s.last_error).toBe("HTTP 503: busy");
  });

  it("turned down, holds back that file alone", async () => {
    const { dir, sent, watcher, w } = await setup({
      reply: (d) => (d.relativePath.endsWith("bad.jsonl") ? { ok: false, retryable: false, error: "HTTP 413" } : { ok: true }),
    });
    const bad = join(dir, "bad.jsonl");
    const good = join(dir, "good.jsonl");
    await writeFile(bad, line("太大"));
    await writeFile(good, line("正常"));
    await watcher.syncFile(bad, "claude_code");
    expect(watcher.stats().backoff_until).toBeNull();
    w.enqueue(bad, "claude_code");
    w.enqueue(good, "claude_code");
    await drain(w);
    expect(sent.map((d) => d.relativePath)).toEqual(["projects/-w-app/bad.jsonl", "projects/-w-app/good.jsonl"]);
  });

  it("goes again once it passes, and clears what was failing", async () => {
    let down = true;
    const { dir, watcher, w } = await setup({ reply: () => (down ? { ok: false, retryable: false } : { ok: true }) });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一"));
    await watcher.syncFile(file, "claude_code");
    down = false;
    await watcher.syncFile(file, "claude_code");
    expect(w.offsets.get(file)).toBe(bytes(line("一")));
    expect(watcher.stats().failing).toBe(0);
    expect(watcher.stats().uploads).toBe(1);
  });
});

describe("files that just changed go first", () => {
  it("before what a scan found, and a queued file that changes moves up", async () => {
    const { dir, sent, w } = await setup();
    const [a, b, c] = ["a", "b", "c"].map((n) => join(dir, `${n}.jsonl`));
    for (const f of [a!, b!, c!]) await writeFile(f, line(f));
    w.enqueue(a!, "claude_code");
    w.enqueue(b!, "claude_code");
    w.enqueue(c!, "claude_code");
    w.enqueue(c!, "claude_code", true);
    expect(w.queue.map(([f]) => f)).toEqual([a, b]);
    expect(w.urgent.map(([f]) => f)).toEqual([c]);
    await drain(w);
    expect(sent.map((d) => d.relativePath.split("/").pop())).toEqual(["c.jsonl", "a.jsonl", "b.jsonl"]);
  });

  it("a big log from the backlog stops between slices for them, and goes on before the rest", async () => {
    // 10-30: a 150 MB log sent again from the start held a Windows collector's live sessions for hours
    let changed = "";
    let internals: Internals | undefined;
    const { dir, sent, w } = await setup({
      reply: (_d, n) => {
        if (n === 1) internals!.enqueue(changed, "claude_code", true);
        return { ok: true };
      },
    });
    internals = w;
    const [big, other] = ["big", "other"].map((n) => join(dir, `${n}.jsonl`));
    changed = join(dir, "live.jsonl");
    const text = Array.from({ length: 12 }, (_, i) => line(`${i} ${"x".repeat(100_000)}`)).join(""); // three slices
    await writeFile(big!, text);
    await writeFile(other!, line("other"));
    await writeFile(changed, line("live"));
    w.enqueue(big!, "claude_code");
    w.enqueue(other!, "claude_code");
    await drain(w);
    expect(sent.map((d) => d.relativePath.split("/").pop())).toEqual(["big.jsonl", "live.jsonl", "big.jsonl", "big.jsonl", "other.jsonl"]);
    const slices = sent.filter((d) => d.relativePath.endsWith("big.jsonl"));
    expect(slices.map((d) => d.mode)).toEqual(["full", "delta", "delta"]);
    expect(slices.slice(1).map((d) => d.offset)).toEqual(slices.slice(0, 2).map((d) => d.endOffset));
    expect(w.offsets.get(big!)).toBe(bytes(text));
  });
});

describe("reconcile", () => {
  it("goes on from where the server's copy ends", async () => {
    const { dir, sent, asked, watcher, w } = await setup({
      reconcile: (files) => files.map((f) => ({ tool: f.tool, relativePath: f.relativePath, expectedOffset: bytes(line("一")) })),
    });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一") + line("二"));
    w.offsets.set(file, bytes(line("一") + line("二"))); // saved before a commit that failed
    expect(await watcher.reconcile()).toBe(1);
    expect(asked[0]).toEqual([{ tool: "claude_code", relativePath: "projects/-w-app/s.jsonl", offset: bytes(line("一") + line("二")) }]);
    await drain(w);
    expect(sent.map((d) => [d.offset, d.content])).toEqual([[bytes(line("一")), line("二").trimEnd()]]);
    expect(watcher.stats().reconciled).toBe(1);
    expect(watcher.stats().last_reconcile_at).not.toBeNull();
  });

  it("starts over when the server's copy is longer than the file", async () => {
    const { dir, sent, watcher, w } = await setup({
      reconcile: (files) => files.map((f) => ({ tool: f.tool, relativePath: f.relativePath, expectedOffset: 1 << 30 })),
    });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一"));
    w.offsets.set(file, 5);
    expect(await watcher.reconcile()).toBe(1);
    await drain(w);
    expect(sent.map((d) => [d.mode, d.offset])).toEqual([["full", 0]]);
  });

  it("leaves a log whose offset moved while it asked, and everything when the server can't tell", async () => {
    let w2: Internals | undefined;
    let file = "";
    const { dir, watcher, w } = await setup({
      reconcile: (files) => {
        w2!.offsets.set(file, 99); // an upload went in meanwhile
        return files.map((f) => ({ tool: f.tool, relativePath: f.relativePath, expectedOffset: 0 }));
      },
    });
    w2 = w;
    file = join(dir, "s.jsonl");
    await writeFile(file, line("一"));
    w.offsets.set(file, 7);
    expect(await watcher.reconcile()).toBe(0);
    expect(w.offsets.get(file)).toBe(99);

    const other = await setup({ reconcile: () => null });
    const f2 = join(other.dir, "s.jsonl");
    await writeFile(f2, line("一"));
    other.w.offsets.set(f2, 7);
    expect(await other.watcher.reconcile()).toBe(0);
    expect(other.w.offsets.get(f2)).toBe(7);
  });
});

describe("resyncFiles", () => {
  it("sends the logs the server asks for again from the start, and only those", async () => {
    const { dir, sent, watcher, w } = await setup();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    await writeFile(a, line("被旧采集端截断过"));
    await writeFile(b, line("没事"));
    w.offsets.set(a, bytes(line("被旧采集端截断过")));
    w.offsets.set(b, bytes(line("没事")));
    const found = await watcher.resyncFiles([
      { tool: "claude_code", relative_path: "projects/-w-app/a.jsonl" },
      { tool: "claude_code", relative_path: "projects/-w-app/gone.jsonl" },
    ]);
    expect(found).toBe(1);
    await drain(w);
    expect(sent.map((d) => [d.relativePath, d.mode, d.offset])).toEqual([["projects/-w-app/a.jsonl", "full", 0]]);
    expect(watcher.stats().resent).toBe(1);
  });
});

describe("offsets.json", () => {
  it("is written whole: nothing left half-written, and a .tmp a crash left is read", async () => {
    const { home, dir, w } = await setup();
    const file = join(dir, "s.jsonl");
    const path = join(home, ".memento", "offsets.json");
    w.offsets.set(file, 42);
    await Promise.all([w.flushOffsets(), w.saveOffsets(true), w.flushOffsets()]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ [file]: 42 });
    expect(existsSync(`${path}.tmp`)).toBe(false);

    // Cut short by a crash while written in place (before v1.0.95), the whole copy still in .tmp
    await writeFile(path, '{"/x": 1');
    await writeFile(`${path}.tmp`, JSON.stringify({ [file]: 77 }));
    w.offsets.clear();
    expect(await w.loadOffsets()).toBe(true);
    expect(w.offsets.get(file)).toBe(77);
  });

  it("missing, says so (the logs then get reconciled before going up again)", async () => {
    const { w } = await setup();
    expect(await w.loadOffsets()).toBe(false);
  });

  it("lost: start asks the server where each log's copy ends before sending anything", async () => {
    const { dir, home, sent, asked, watcher } = await setup({
      reconcile: (files) => files.map((f) => ({ tool: f.tool, relativePath: f.relativePath, expectedOffset: bytes(line("一")) })),
    });
    const file = join(dir, "s.jsonl");
    await writeFile(file, line("一") + line("二"));
    await watcher.start({ claude_code: { id: "claude_code", root: join(home, ".claude") } } as never);
    try {
      expect(asked[0]?.map((f) => [f.relativePath, f.offset])).toEqual([["projects/-w-app/s.jsonl", 0]]);
      await drain(watcher as unknown as Internals);
      expect(sent.map((d) => d.offset)).toEqual([bytes(line("一"))]);
    } finally {
      await watcher.dispose();
    }
  });
});

describe("IngestClient", () => {
  const config = { token: "t", deviceId: "d", deviceName: "n", platform: "darwin", serverUrl: "https://mem.example" } as unknown as CollectorConfig;
  const doc: IngestDocument = {
    toolId: "claude_code",
    category: "conversation",
    contentType: "jsonl",
    relativePath: "projects/-w-app/s.jsonl",
    content: line("一").trimEnd(),
    contentHash: "h",
    offset: 10,
    endOffset: 30,
    mode: "delta",
  };
  const client = (status: number, body: unknown, seen?: Record<string, unknown>[]) =>
    new IngestClient(config, () => {}, (async (_url: string, init: RequestInit) => {
      seen?.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch);

  it("sends where the slice ends and reads where the server's copy goes on", async () => {
    const seen: Record<string, unknown>[] = [];
    expect(await client(200, { document_id: "x", next_offset: 50 }, seen).ingestDocument(doc)).toEqual({ ok: true, nextOffset: 50 });
    expect([seen[0]!.offset, seen[0]!.end_offset, seen[0]!.mode]).toEqual([10, 30, "delta"]);
  });

  it("reads the expected offset of a 409", async () => {
    expect(await client(409, { detail: { expected_offset: 123 } }).ingestDocument(doc)).toEqual({ ok: false, expectedOffset: 123 });
  });

  it("tells a failure that may pass from one that won't", async () => {
    expect((await client(503, "busy").ingestDocument(doc)).retryable).toBe(true);
    expect((await client(429, "slow down").ingestDocument(doc)).retryable).toBe(true);
    expect((await client(413, "too large").ingestDocument(doc)).retryable).toBe(false);
    const offline = new IngestClient(config, () => {}, (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(await offline.ingestDocument(doc)).toMatchObject({ ok: false, retryable: true });
  });

  it("reconcile: null when the server can't tell", async () => {
    expect(await client(404, "Not Found").reconcile([{ tool: "claude_code", relativePath: "a", offset: 1 }])).toBeNull();
    expect(
      await client(200, { files: [{ tool: "claude_code", relative_path: "a", expected_offset: 5 }] }).reconcile([
        { tool: "claude_code", relativePath: "a", offset: 1 },
      ]),
    ).toEqual([{ tool: "claude_code", relativePath: "a", expectedOffset: 5 }]);
  });
});
