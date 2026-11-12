// The Antigravity app counts quota per model too: its default (Gemini 4 Argon) ran out on 11-12 while Flash
// still answered. A fake runner stands in for memento's agy_cli.mjs, failing as the real one does then.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { appQuotaFallbacks } from "../src/task-runner.js";

const dir = mkdtempSync(join(tmpdir(), "agy-app-quota-"));
const runner = join(dir, "agy_cli.mjs");

vi.mock("../src/antigravity.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/antigravity.js")>();
  return {
    ...real,
    antigravityExecutable: async () => runner,
    discoverAntigravityEnv: async () => ({ ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:1", ANTIGRAVITY_CSRF_TOKEN: "t" }),
    officialAgyCli: async () => null,
  };
});

const { WsTaskClient } = await import("../src/ws-client.js");

beforeAll(() => {
  writeFileSync(
    runner,
    `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
console.error("session id: 3bc48294-df34-4cca-9099-3d58f66034e9");
const out = (m) => !m || m === "pro" || (m === "flash" && existsSync(join(${JSON.stringify(dir)}, "flash-out"))) || (m === "flash_lite" && existsSync(join(${JSON.stringify(dir)}, "lite-out")));
if (out(model)) {
  console.error("\\nAntigravity Error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 49h9m12s.");
  process.exit(1);
}
console.log("好的");
`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function runTask(taskId: string, payload: Record<string, unknown>) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let resolveDone!: (m: Record<string, unknown>) => void;
  const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
  const chunks: string[] = [];
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
    ws.send(JSON.stringify({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 120, payload: { binary: "antigravity", cwd: dir, ...payload } } }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.type === "task_chunk") chunks.push(String(msg.content ?? msg.text ?? ""));
      if (msg.type === "task_finished") resolveDone(msg);
    });
  });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const client = new WsTaskClient({ serverUrl: `http://127.0.0.1:${port}`, token: "t", deviceId: "dev", deviceName: "test", platform: "test", extraWatchDirs: [] });
  void client.start();
  const done = await finished;
  client.dispose();
  await new Promise((r) => wss.close(r));
  return { done, chunks: chunks.join("") };
}

const calls = () =>
  readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[]);

it("tiers to go on with, lightest first", () => {
  expect(appQuotaFallbacks("")).toEqual(["flash", "flash_lite"]);
  expect(appQuotaFallbacks("pro")).toEqual(["flash", "flash_lite"]);
  expect(appQuotaFallbacks("flash")).toEqual(["flash_lite", "pro"]);
  expect(appQuotaFallbacks("flash_lite")).toEqual(["flash", "pro"]);
});

it.skipIf(process.platform === "win32")(
  "the app's default model out of quota: the task goes on with Flash instead of failing",
  async () => {
    const { done } = await runTask("feedbeef-0000-4000-8000-0000000000c1", { prompt: "只回复两个字：好的" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded" });
    expect(String(done.stdout)).toContain("好的");
    const runs = calls();
    expect(runs).toHaveLength(2);
    expect(runs[0]).not.toContain("--model");
    expect(runs[1]).toEqual(expect.arrayContaining(["--model", "flash"]));
    expect(String(done.stderr)).toContain("改用 FLASH 档位继续");
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "every tier out of quota: the task ends as out of quota, after trying each once",
  async () => {
    writeFileSync(join(dir, "flash-out"), "");
    writeFileSync(join(dir, "lite-out"), "");
    const before = calls().length;
    const { done } = await runTask("feedbeef-0000-4000-8000-0000000000c2", { prompt: "x" });
    expect(done).toMatchObject({ status: "failed", error_type: "usage_limit" });
    expect(String(done.error)).toContain("Individual quota reached");
    expect(calls().slice(before)).toHaveLength(3);
  },
  45_000,
);
