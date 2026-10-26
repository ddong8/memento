import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import type { IngestClient } from "../src/ingest.js";
import { cleanLines, FileWatcher } from "../src/watcher.js";

// The server parses each uploaded line as one JSON message. A line sent in two pieces parses as
// neither, and the message is gone for good: on prod a 296 MB Claude Code log lacked 154 messages,
// 9 of them the user's own (a last line read while still being written, a line longer than a batch,
// a screenshot line cut into head and tail).

const homes: string[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await rm(h, { recursive: true, force: true });
});

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "whole-lines-"));
  homes.push(home);
  const sent: { content: string; offset: number; mode: string }[] = [];
  const ingest = {
    ingestDocument: async (doc: (typeof sent)[number]) => {
      sent.push(doc);
      return true;
    },
  } as unknown as IngestClient;
  const watcher = new FileWatcher({ extraWatchDirs: [] } as unknown as CollectorConfig, ingest, () => {}, home);
  const dir = join(home, ".claude", "projects", "-w-app");
  await mkdir(dir, { recursive: true });
  return { file: join(dir, "s.jsonl"), sent, watcher };
}

const msg = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", cwd: "/w/app", message: { role: "user", content: text }, ...extra });

const uploadedLines = (sent: { content: string }[]) => sent.flatMap((d) => d.content.split("\n")).filter(Boolean);

async function makeQuiet(file: string) {
  const old = new Date(Date.now() - 120_000);
  await utimes(file, old, old);
}

describe("session logs go up in whole lines", () => {
  it("holds back a last line that is still being written", async () => {
    const { file, sent, watcher } = await setup();
    const second = msg("第二条消息，写到一半");
    await writeFile(file, `${msg("第一条")}\n${second.slice(0, 20)}`);
    await watcher.syncFile(file, "claude_code");
    expect(uploadedLines(sent)).toEqual([msg("第一条")]);

    await appendFile(file, `${second.slice(20)}\n`);
    await watcher.syncFile(file, "claude_code");
    const lines = uploadedLines(sent);
    expect(lines).toEqual([msg("第一条"), second]);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("sends a last line without its newline once the file is quiet", async () => {
    const { file, sent, watcher } = await setup();
    await writeFile(file, `${msg("一")}\n${msg("最后一行没有换行")}`);
    await makeQuiet(file);
    await watcher.syncFile(file, "claude_code");
    expect(uploadedLines(sent)).toEqual([msg("一"), msg("最后一行没有换行")]);
  });

  it("reads a line longer than a batch to its end and keeps the words around a screenshot", async () => {
    const { file, sent, watcher } = await setup();
    const image = "iVBORw0KGgo".repeat(80_000); // ~880 KB of base64, past one 512 KB batch
    const shot = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "这个对话的title还是不对" }, { type: "image", source: { data: image } }] },
    });
    await writeFile(file, `${msg("前一条")}\n${shot}\n${msg("后一条")}\n`);
    await watcher.syncFile(file, "claude_code");

    const lines = uploadedLines(sent);
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[1].message.content[0].text).toBe("这个对话的title还是不对");
    expect(lines[1]!.length).toBeLessThanOrEqual(128 * 1024);
    expect(parsed[2].message.content).toBe("后一条");
  });

  it("waits for the end of a long line that is still being written", async () => {
    const { file, sent, watcher } = await setup();
    const big = msg("x".repeat(700_000));
    await writeFile(file, `${msg("前")}\n${big.slice(0, 600_000)}`);
    await watcher.syncFile(file, "claude_code");
    expect(uploadedLines(sent)).toEqual([msg("前")]);

    await appendFile(file, `${big.slice(600_000)}\n`);
    await watcher.syncFile(file, "claude_code");
    const lines = uploadedLines(sent);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).type).toBe("user");
  });
});

describe("a giant line shrinks and stays JSON", () => {
  it("cuts long strings, keeps short ones", () => {
    const line = msg("用户原话", { toolUseResult: { stdout: "y".repeat(300_000) } });
    const [out] = cleanLines(line);
    expect(out!.length).toBeLessThanOrEqual(128 * 1024);
    const v = JSON.parse(out!);
    expect(v.message.content).toBe("用户原话");
    expect(v.toolUseResult.stdout).toContain("已截断");
  });

  it("leaves a line that isn't JSON to head and tail", () => {
    const [out] = cleanLines("not json ".repeat(20_000));
    expect(out!.split("\n")[0]!.length).toBe(64 * 1024);
    expect(out).toContain("[TRUNCATED");
  });
});
