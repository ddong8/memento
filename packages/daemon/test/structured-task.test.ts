// End to end through the daemon's task socket: a fake server dispatches a Claude
// task in a worktree, a fake `claude` replays a recorded stream-json run and
// pauses for a follow-up, and the daemon's reports are checked.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { WsTaskClient } from "../src/ws-client.js";

const fixture = fileURLToPath(new URL("./fixtures/claude_stream.jsonl", import.meta.url));
// A bin directory on PATH from the start: the daemon caches PATH the first time it looks up an agent
const sharedBin = mkdtempSync(join(tmpdir(), "fake_agents_"));
process.env.PATH = `${sharedBin}:${process.env.PATH}`;

it.skipIf(process.platform === "win32")(
  "Claude task: steps, follow-up, worktree, final answer",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "structured_"));
    const bin = join(tmp, "bin");
    const repo = join(tmp, "repo");
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", bin, repo, home]);
    const stdinLog = join(tmp, "claude_stdin.txt");
    const fake = join(bin, "claude-fake-memento");
    writeFileSync(
      fake,
      `#!/bin/sh
IFS= read -r first; printf '%s\\n' "$first" > "${stdinLog}"
head -n 5 "${fixture}"
IFS= read -r second && printf '%s\\n' "$second" >> "${stdinLog}"
tail -n +6 "${fixture}"
cat > /dev/null
`,
    );
    chmodSync(fake, 0o755);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "init");

    // The fake agent is found on PATH; worktrees go under this HOME.
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.HOME = home;

    const taskId = "feedbeef-0000-4000-8000-000000000001";
    const received: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let resolveDone!: (m: Record<string, unknown>) => void;
    const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
      ws.send(
        JSON.stringify({
          type: "task_dispatch",
          task: {
            id: taskId,
            action: "agent",
            timeout_seconds: 60,
            payload: { binary: "claude-fake-memento", prompt: "列一下文件", cwd: repo, worktree: true },
          },
        }),
      );
      let steered = false;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        const event = msg.event as Record<string, unknown> | undefined;
        if (!steered && msg.type === "agent_event" && event?.kind === "tool") {
          steered = true;
          ws.send(JSON.stringify({ type: "task_input", task_id: taskId, input: "顺便看看 README" }));
        }
        if (msg.type === "task_finished") resolveDone(msg);
      });
    });
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;

    const client = new WsTaskClient({
      serverUrl: `http://127.0.0.1:${port}`,
      token: "t",
      deviceId: "dev",
      deviceName: "test",
      platform: "test",
      extraWatchDirs: [],
    });
    void client.start();
    const done = await finished;
    client.dispose();
    await new Promise((r) => wss.close(r));

    const events = received.filter((m) => m.type === "agent_event").map((m) => m.event as Record<string, unknown>);
    const tools = new Map<string, Record<string, unknown>>();
    for (const e of events.filter((e) => e.kind === "tool")) tools.set(String(e.id), { ...tools.get(String(e.id)), ...e });
    expect([...tools.values()].map((t) => `${t.name}:${t.status}`)).toEqual(["Bash:done", "Write:done"]);
    expect(events.filter((e) => e.kind === "steer").map((e) => e.status)).toEqual(["sent"]);
    expect(events.filter((e) => e.kind === "worktree").map((e) => e.status)).toEqual(["created", "removed"]);
    expect(events.some((e) => e.kind === "usage")).toBe(true);
    expect(received.some((m) => m.type === "agent_capabilities")).toBe(true);

    expect(done).toMatchObject({ status: "succeeded", stdout: "DONE", session_id: "6f3d1184-787b-4878-a8f5-2f5ade4fb738" });
    expect((done.events as unknown[]).length).toBeGreaterThanOrEqual(4);

    // The prompt and the follow-up both went in as stream-json user messages.
    const sent = readFileSync(stdinLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { message: { content: string } }).message.content);
    expect(sent).toEqual(["列一下文件", "顺便看看 README"]);

    rmSync(tmp, { recursive: true, force: true });
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "Claude task: AskUserQuestion is shown, and the answer from the page goes back over the control channel",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "ask_"));
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", home]);
    const stdinLog = join(tmp, "claude_stdin.txt");
    const ask = {
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "喜欢哪个颜色？", header: "颜色", options: [{ label: "红" }, { label: "蓝" }], multiSelect: false }] } },
    };
    const fake = join(sharedBin, "claude-ask-memento");
    writeFileSync(
      fake,
      `#!/bin/sh
IFS= read -r first
printf '%s\\n' '${JSON.stringify(ask)}'
IFS= read -r reply && printf '%s\\n' "$reply" > "${stdinLog}"
printf '%s\\n' '{"type":"result","subtype":"success","result":"你选了蓝","session_id":"6f3d1184-787b-4878-a8f5-2f5ade4fb739"}'
cat > /dev/null
`,
    );
    chmodSync(fake, 0o755);
    process.env.HOME = home;

    const taskId = "feedbeef-0000-4000-8000-000000000002";
    const received: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let resolveDone!: (m: Record<string, unknown>) => void;
    const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
      ws.send(JSON.stringify({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 60, payload: { binary: "claude-ask-memento", prompt: "问我个问题", cwd: tmp } } }));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        const event = msg.event as Record<string, unknown> | undefined;
        if (msg.type === "agent_event" && event?.kind === "question" && event.status === "waiting") {
          // What the page's question card sends: the chosen option and the question's id
          ws.send(JSON.stringify({ type: "task_input", task_id: taskId, input: "蓝", question_id: event.id }));
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

    const questions = received
      .filter((m) => m.type === "agent_event" && (m.event as Record<string, unknown>).kind === "question")
      .map((m) => m.event as Record<string, unknown>);
    expect(questions[0]).toMatchObject({ id: "req-1:0", header: "颜色", question: "喜欢哪个颜色？", status: "waiting" });
    expect(questions.at(-1)).toMatchObject({ id: "req-1:0", status: "answered", answer: "蓝" });
    expect(JSON.parse(readFileSync(stdinLog, "utf8"))).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: "req-1", response: { behavior: "allow", updatedInput: { ...ask.request.input, answers: { "喜欢哪个颜色？": "蓝" } } } },
    });
    expect(done).toMatchObject({ status: "succeeded", stdout: "你选了蓝" });
    rmSync(tmp, { recursive: true, force: true });
  },
  45_000,
);
