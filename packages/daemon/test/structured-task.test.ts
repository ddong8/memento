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

    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
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
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "Claude task that runs out of quota with a background task open: reported failed as usage_limit, not still running",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "limit_"));
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", home]);
    const limit = "You've hit your session limit · resets 11:40am (Asia/Shanghai)";
    // What Claude Code wrote on 10-28: a background build left open, then the synthetic rate_limit reply
    const lines = [
      { type: "system", subtype: "init", session_id: "6f3d1184-787b-4878-a8f5-2f5ade4fb740" },
      { type: "system", subtype: "task_started", task_id: "b1", tool_use_id: "t-b1", description: "npm run build", task_type: "local_bash", is_backgrounded: true },
      {
        type: "assistant",
        error: "rate_limit",
        message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: limit }] },
        session_id: "6f3d1184-787b-4878-a8f5-2f5ade4fb740",
      },
      { type: "result", subtype: "success", is_error: true, result: limit, session_id: "6f3d1184-787b-4878-a8f5-2f5ade4fb740" },
    ];
    const stream = join(tmp, "limit_stream.jsonl");
    writeFileSync(stream, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const fake = join(sharedBin, "claude-limit-memento");
    writeFileSync(fake, `#!/bin/sh\nIFS= read -r first\ncat "${stream}"\ncat > /dev/null\nexit 1\n`);
    chmodSync(fake, 0o755);
    process.env.HOME = home;

    const taskId = "feedbeef-0000-4000-8000-000000000003";
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let resolveDone!: (m: Record<string, unknown>) => void;
    const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
      ws.send(JSON.stringify({ type: "task_dispatch", task: { id: taskId, action: "agent", timeout_seconds: 60, payload: { binary: "claude-limit-memento", prompt: "构建一下", cwd: tmp } } }));
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
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

    // The session it was in is kept, so "继续" picks up there once the quota is back
    expect(done).toMatchObject({ status: "failed", error_type: "usage_limit", error: limit, session_id: "6f3d1184-787b-4878-a8f5-2f5ade4fb740" });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "An agent that doesn't read input mid-run: a follow-up is reported unsupported, not sent",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "nosteer_"));
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", home]);
    process.env.HOME = home;
    const fake = join(sharedBin, "plainagent-memento");
    writeFileSync(fake, "#!/bin/sh\necho working\nsleep 1\necho done\n");
    chmodSync(fake, 0o755);

    const taskId = "feedbeef-0000-4000-8000-000000000009";
    const received: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let resolveDone!: (m: Record<string, unknown>) => void;
    const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
      ws.send(
        JSON.stringify({
          type: "task_dispatch",
          task: { id: taskId, action: "agent", timeout_seconds: 60, payload: { binary: "plainagent-memento", prompt: "干活", cwd: tmp } },
        }),
      );
      let steered = false;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        if (!steered && JSON.stringify(msg).includes("working")) {
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

    const steers = received
      .filter((m) => m.type === "agent_event")
      .map((m) => m.event as Record<string, unknown>)
      .filter((e) => e.kind === "steer");
    expect(steers.map(({ text, status }) => ({ text, status }))).toEqual([{ text: "顺便看看 README", status: "unsupported" }]);
    expect(done).toMatchObject({ status: "succeeded" });
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "Claude task: answered but still waiting on a background task, a follow-up still reaches the session",
  async () => {
    const tmp = mkdtempSync(join(tmpdir(), "bgsteer_"));
    const home = join(tmp, "home");
    execFileSync("mkdir", ["-p", home]);
    const stdinLog = join(tmp, "claude_stdin.txt");
    const sid = "0b9c5f2e-3c41-4d7e-9d1a-6a2f1e0c7b11";
    const line = (o: unknown) => `printf '%s\\n' '${JSON.stringify(o)}'`;
    const fake = join(sharedBin, "claude-bgsteer-memento");
    // Answers, leaves a background task running; takes a follow-up, then the task ends with one more turn
    writeFileSync(
      fake,
      `#!/bin/sh
IFS= read -r first; printf '%s\\n' "$first" > "${stdinLog}"
${line({ type: "system", subtype: "init", session_id: sid, model: "claude-test" })}
${line({ type: "system", subtype: "task_started", task_id: "bg1", description: "盯部署" })}
${line({ type: "result", subtype: "success", is_error: false, result: "先这样", session_id: sid, queued_turn_count: 0 })}
IFS= read -r second && printf '%s\\n' "$second" >> "${stdinLog}"
${line({ type: "system", subtype: "task_notification", task_id: "bg1", status: "completed" })}
${line({ type: "result", subtype: "success", is_error: false, result: "收到追问", session_id: sid, queued_turn_count: 0 })}
cat > /dev/null
`,
    );
    chmodSync(fake, 0o755);
    process.env.HOME = home;

    const taskId = "feedbeef-0000-4000-8000-0000000000b9";
    const received: Record<string, unknown>[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    let resolveDone!: (m: Record<string, unknown>) => void;
    const finished = new Promise<Record<string, unknown>>((r) => (resolveDone = r));
    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "connected", device_name: "test" }));
      ws.send(
        JSON.stringify({
          type: "task_dispatch",
          task: { id: taskId, action: "agent", timeout_seconds: 60, payload: { binary: "claude-bgsteer-memento", prompt: "部署后盯着", cwd: tmp } },
        }),
      );
      let steered = false;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(msg);
        const event = msg.event as Record<string, unknown> | undefined;
        // After the answer (usage comes with the result), while the background task still runs
        if (!steered && msg.type === "agent_event" && event?.kind === "usage") {
          steered = true;
          ws.send(JSON.stringify({ type: "task_input", task_id: taskId, input: "顺便把日志也看看" }));
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

    const steers = received
      .filter((m) => m.type === "agent_event")
      .map((m) => m.event as Record<string, unknown>)
      .filter((e) => e.kind === "steer");
    expect(steers.map((e) => e.status)).toEqual(["sent"]);
    const sent = readFileSync(stdinLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => (JSON.parse(l) as { message: { content: string } }).message.content);
    expect(sent).toEqual(["部署后盯着", "顺便把日志也看看"]);
    // stdin closed once the background task ended, so the run finished
    expect(done).toMatchObject({ status: "succeeded" });

    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  },
  45_000,
);

it.skipIf(process.platform === "win32")(
  "Pasted images are written under the names the server gives them (each question its own)",
  async () => {
    const { existsSync, readFileSync: read } = await import("node:fs");
    const tmp = mkdtempSync(join(tmpdir(), "imgnames_"));
    const conv = `test-${Date.now().toString(36)}`;
    const dir = join("/tmp/memento_images", conv);
    const fake = join(sharedBin, "claude-imgnames-memento");
    writeFileSync(
      fake,
      `#!/bin/sh\nIFS= read -r first\nprintf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}'\ncat > /dev/null\n`,
    );
    chmodSync(fake, 0o755);
    const png = `data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`;
    const webp = `data:image/webp;base64,${Buffer.from("WEBPDATA").toString("base64")}`;
    const taskId = "feedbeef-0000-4000-8000-0000000000c1";
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
            payload: {
              binary: "claude-imgnames-memento",
              prompt: "看图",
              cwd: tmp,
              conversation_id: conv,
              images: [png, webp],
              // the second name isn't one the server would give: the old image_<n> then
              image_names: ["image_q1a2_1.png", "../evil.webp"],
            },
          },
        }),
      );
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (msg.type === "task_finished") resolveDone(msg);
      });
    });
    await new Promise((r) => wss.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    const client = new WsTaskClient({ serverUrl: `http://127.0.0.1:${port}`, token: "t", deviceId: "dev", deviceName: "test", platform: "test", extraWatchDirs: [] });
    void client.start();
    await finished;
    client.dispose();
    await new Promise((r) => wss.close(r));

    try {
      expect(read(join(dir, "image_q1a2_1.png"), "utf8")).toBe("PNGDATA");
      expect(read(join(dir, "image_2.webp"), "utf8")).toBe("WEBPDATA");
      expect(existsSync(join("/tmp/memento_images", "evil.webp"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  },
  45_000,
);
