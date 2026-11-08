// End to end through the daemon's task socket for Antigravity: a fake server dispatches the task, the
// daemon runs memento's TypeScript runner on its own runtime (as Electron-as-Node does in the app), and
// the runner talks to a fake agentapi and language server. Only finding the app is stubbed out, so the
// real Antigravity on the machine running the tests is never touched.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const dir = mkdtempSync(join(tmpdir(), "agy-task-"));
const bundle = join(dir, "agy_cli.mjs");
const home = join(dir, "home");
// Antigravity's conversation ids are UUIDs, which is what the daemon reads back as the session
const CIDS = { simple: "6a1f0c2e-0000-4000-8000-00000000a001", ask: "6a1f0c2e-0000-4000-8000-00000000a002" };
const logDir = (cid: string) => join(home, ".gemini", "antigravity", "brain", cid, ".system_generated", "logs");
const env = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock("../src/antigravity.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/antigravity.js")>();
  return { ...real, antigravityExecutable: async () => bundle, discoverAntigravityEnv: async () => env.value };
});

const { WsTaskClient } = await import("../src/ws-client.js");

let server: Server;
let answered = false;
const rpcCalls: { method: string; body: any }[] = [];

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  await build({
    entryPoints: [fileURLToPath(new URL("../src/agy-runner/main.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    outfile: bundle,
    logLevel: "silent",
  });
  // Not executable: the task only runs if the daemon starts it on its own runtime rather than as a program
  chmodSync(bundle, 0o644);
  const fakeJs = join(dir, "fake_agentapi.mjs");
  writeFileSync(
    fakeJs,
    `
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(join(process.env.HOME, "agentapi-calls.jsonl"), JSON.stringify(args) + "\\n");
const cid = ${JSON.stringify(CIDS)}[process.env.FAKE_AGY];
const log = join(process.env.HOME, ".gemini", "antigravity", "brain", cid, ".system_generated", "logs");
const write = (...steps) => { mkdirSync(log, { recursive: true }); appendFileSync(join(log, "transcript_full.jsonl"), steps.map((s) => JSON.stringify(s) + "\\n").join("")); };
write({ source: "USER", type: "USER_INPUT", content: args[args.length - 1] });
if (process.env.FAKE_AGY === "ask") write({ source: "MODEL", type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "ask_question", id: "tc1", args: { questions: [{ question: "选哪个？", options: ["A", "B"] }] } }] });
else write({ source: "MODEL", type: "PLANNER_RESPONSE", content: "最终答案：完成" });
console.log(JSON.stringify({ response: { newConversation: { conversationId: cid } } }));
`,
  );
  const fake = join(dir, "agentapi");
  writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${fakeJs}' "$@"\n`);
  chmodSync(fake, 0o755);

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const method = req.url!.split("/").pop()!;
      rpcCalls.push({ method, body: raw ? JSON.parse(raw) : {} });
      res.setHeader("Content-Type", "application/json");
      if (method === "GetUserStatus") {
        res.end(JSON.stringify({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ modelId: "gemini-3.8-flash", modelOrAlias: { model: "M1" } }] } } }));
      } else if (method === "GetCascadeTrajectory") {
        const step = {
          status: answered ? "CORTEX_STEP_STATUS_DONE" : "CORTEX_STEP_STATUS_WAITING",
          requestedInteraction: { askQuestion: {} },
          askQuestion: { questions: [{ question: "选哪个？", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] }] },
        };
        res.end(JSON.stringify({ trajectory: { trajectoryId: "traj-1", steps: [step] } }));
      } else if (method === "HandleCascadeUserInteraction") {
        res.end("{}");
        answered = true;
        appendFileSync(
          join(logDir(CIDS.ask), "transcript_full.jsonl"),
          [{ source: "USER", type: "USER_INPUT", content: "B" }, { source: "MODEL", type: "PLANNER_RESPONSE", content: "你选了 B" }]
            .map((s) => `${JSON.stringify(s)}\n`)
            .join(""),
        );
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  env.value = { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`, ANTIGRAVITY_CSRF_TOKEN: "csrf-test", ANTIGRAVITY_LS_BINARY: fake };
});

afterAll(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Dispatches one Antigravity task and collects what the daemon reports until it finishes. */
async function runTask(taskId: string, prompt: string, answer?: string) {
  const received: Record<string, unknown>[] = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  let resolveDone!: (m: Record<string, unknown>) => void;
  const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
    ws.send(JSON.stringify({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 60, payload: { binary: "agy", prompt, cwd: dir } } }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      received.push(msg);
      const event = msg.event as Record<string, unknown> | undefined;
      if (answer && msg.type === "agent_event" && event?.kind === "question" && event.status === "waiting") {
        ws.send(JSON.stringify({ type: "task_input", task_id: taskId, input: answer, question_id: event.id }));
      }
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
  return { done, received };
}

it.skipIf(process.platform === "win32")(
  "Antigravity task: the daemon runs the TypeScript runner on its own runtime and reports the reply and session",
  async () => {
    env.value.FAKE_AGY = "simple";
    const { done } = await runTask("feedbeef-0000-4000-8000-0000000000a1", "看看 README");
    expect(done).toMatchObject({ status: "succeeded", session_id: CIDS.simple });
    expect(String(done.stdout)).toContain("最终答案：完成");
    const calls = readFileSync(join(home, "agentapi-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls[0].slice(0, 2)).toEqual(["agentapi", "new-conversation"]);
    expect(calls[0].at(-1)).toContain("看看 README");
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "Antigravity task: a question it holds reaches the page, and the answer goes back through the runner to the app",
  async () => {
    env.value.FAKE_AGY = "ask";
    const taskId = "feedbeef-0000-4000-8000-0000000000a2";
    const { done, received } = await runTask(taskId, "帮我选", "B");
    const questions = received
      .filter((m) => m.type === "agent_event" && (m.event as Record<string, unknown>).kind === "question")
      .map((m) => m.event as Record<string, unknown>);
    expect(questions[0]).toMatchObject({ question: "选哪个？", status: "waiting" });
    expect(questions.at(-1)).toMatchObject({ status: "answered", answer: "B" });
    const submitted = rpcCalls.find((c) => c.method === "HandleCascadeUserInteraction")!.body;
    expect(submitted.interaction.askQuestion.responses[0].selectedOptionIds).toEqual(["o2"]);
    expect(done).toMatchObject({ status: "succeeded" });
    expect(String(done.stdout)).toContain("你选了 B");
  },
  45_000,
);
