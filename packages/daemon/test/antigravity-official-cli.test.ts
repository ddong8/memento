// A machine without the Antigravity app (a server with no desktop): the daemon runs Google's own agy CLI
// in print mode instead and reads its stream-json. A fake agy stands in for the CLI, printing the events
// https://antigravity.google/docs/cli/headless documents; finding the app and the CLI is stubbed out, and so is
// memento's runner (a build output, missing on a fresh checkout), which the CLI takes over from anyway.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const dir = mkdtempSync(join(tmpdir(), "agy-official-"));
const fakeAgy = join(dir, "agy");
const CID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";

vi.mock("../src/antigravity.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/antigravity.js")>();
  return {
    ...real,
    antigravityExecutable: async () => join(dir, "agy_cli.mjs"),
    discoverAntigravityEnv: async () => null,
    officialAgyCli: async () => fakeAgy,
  };
});

const { WsTaskClient } = await import("../src/ws-client.js");

beforeAll(() => {
  const js = join(dir, "fake_agy.mjs");
  writeFileSync(
    js,
    `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify({ args, electron: process.env.ELECTRON_RUN_AS_NODE ?? null }) + "\\n");
const model = args[args.indexOf("--model") + 1];
const emit = (e) => console.log(JSON.stringify(e));
if (args.includes("--model") && model === "pro") {
  emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "invalid model selection (--model \\"pro\\" --effort \\"\\"): model pro is not recognized as a known model or custom model in settings" } });
  process.exit(1);
}
emit({ event: "init", conversation_id: "${CID}", init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 0, state: "DONE", step_type: "user_input" } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/srv/app/README.md" } } } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 1, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/srv/app/README.md" }, output: "# app" } } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" }, output: "", error: { type: "EXIT", message: "exit 1" } } } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "改好了，" } });
emit({ event: "step_update", step_update: { conversation_id: "${CID}", step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "测试已过。\\n" } });
emit({ event: "result", result: { conversation_id: "${CID}", status: "SUCCESS", response: "改好了，测试已过。\\n", duration_seconds: 6.88, num_turns: 1, usage: { input_tokens: 10418, output_tokens: 589, cache_read_tokens: 8113 } } });
`,
  );
  writeFileSync(fakeAgy, `#!/bin/sh\nexec '${process.execPath}' '${js}' "$@"\n`);
  chmodSync(fakeAgy, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

async function runTask(taskId: string, payload: Record<string, unknown>) {
  const received: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let resolveDone!: (m: Record<string, unknown>) => void;
  const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
    ws.send(JSON.stringify({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 120, payload: { binary: "agy", cwd: dir, ...payload } } }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
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
  const events = received.filter((m) => m.type === "agent_event").map((m) => m.event as Record<string, unknown>);
  return { done, events };
}

const calls = () =>
  readFileSync(join(dir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { args: string[]; electron: string | null });

it.skipIf(process.platform === "win32")(
  "no Antigravity app: the task runs Google's agy CLI in print mode, with its steps, reply and conversation",
  async () => {
    const { done, events } = await runTask("feedbeef-0000-4000-8000-0000000000b1", { prompt: "修好测试", effort: "high" });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    expect(String(done.stdout)).toContain("改好了，测试已过。");
    const { args, electron } = calls()[0]!;
    expect(args).toEqual(["--effort", "high", "--print-timeout", "105s", "--dangerously-skip-permissions", "--output-format", "stream-json", "-p", "修好测试"]);
    // The CLI is a program of its own, not a script for this runtime
    expect(electron).toBeNull();
    const tools = events.filter((e) => e.kind === "tool");
    expect(tools).toContainEqual(expect.objectContaining({ id: "agy_step_1", name: "view_file", detail: "/srv/app/README.md", status: "done", output: "# app" }));
    expect(tools).toContainEqual(expect.objectContaining({ id: "agy_step_2", name: "run_command", detail: "npm test", status: "failed", output: "exit 1" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "usage", input_tokens: 10418, cache_read_tokens: 8113, output_tokens: 589, duration_ms: 6880 }));
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "a model the CLI doesn't know (memento's tier names) is dropped for its default, in the same conversation",
  async () => {
    const before = calls().length;
    const { done } = await runTask("feedbeef-0000-4000-8000-0000000000b2", { prompt: "继续", model: "pro", session_id: CID });
    expect(done, `${done.error}\n${done.stderr}`).toMatchObject({ status: "succeeded", session_id: CID });
    const [first, retry] = calls().slice(before);
    expect(first!.args).toEqual(expect.arrayContaining(["--conversation", CID, "--model", "pro"]));
    expect(retry!.args).toEqual(expect.arrayContaining(["--conversation", CID]));
    expect(retry!.args).not.toContain("--model");
  },
  45_000,
);
