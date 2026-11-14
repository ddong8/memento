import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { antigravityExecutable, ensureAgyCliInstalled } from "../src/antigravity.js";
import { agentapiCommand, agyToolDetail, agyToolOutput, latestConversationId, parseArgs, runAgentapi } from "../src/agy-runner/runner.js";
import { findExecutable, prepareCommand } from "../src/exec-env.js";
import { sqliteRows, sqliteRun, useSqliteCli } from "../src/sqlite.js";

const posix = process.platform !== "win32";
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Sets these environment variables (undefined: unset) until the returned function puts them back. */
function withEnv(vars: Record<string, string | undefined>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  };
  apply(vars);
  return () => apply(saved);
}

describe("Antigravity runner", () => {
  let home: string;
  let restoreEnv: () => void;
  let fixture: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agy-home-"));
    // What the app ships, here a script that shows how it was started
    fixture = join(home, "shipped_agy_cli.mjs");
    writeFileSync(fixture, "console.log(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n");
    restoreEnv = withEnv({ MEMENTO_AGY_RUNNER: fixture });
  });
  afterEach(() => {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
  });

  it("runs memento's runner, not whichever agy comes first on PATH", async () => {
    const script = join(home, ".gemini", "antigravity", "bin", "agy_cli.mjs");
    expect(await antigravityExecutable(home)).toBe(script);
    expect(readFileSync(script, "utf8")).toBe(readFileSync(fixture, "utf8"));
  });

  it("replaces an installed runner that differs from the shipped one, and the Python runner it replaces", async () => {
    const dir = join(home, ".gemini", "antigravity", "bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agy_cli.mjs"), "// older runner\n");
    writeFileSync(join(dir, "agy_cli.py"), "# the Python runner\n");
    expect(await ensureAgyCliInstalled(home)).toBe(join(dir, "agy_cli.mjs"));
    expect(readFileSync(join(dir, "agy_cli.mjs"), "utf8")).toBe(readFileSync(fixture, "utf8"));
    expect(existsSync(join(dir, "agy_cli.mjs.tmp"))).toBe(false);
    expect(existsSync(join(dir, "agy_cli.py"))).toBe(false);
  });

  it("points an `agy` it wrote at the new runner, and leaves Google's alone", async () => {
    const wrapper = posix ? join(home, ".local", "bin", "agy") : join(home, "AppData", "Local", "agy", "bin", "agy.cmd");
    const script = join(home, ".gemini", "antigravity", "bin", "agy_cli.mjs");
    mkdirSync(join(wrapper, ".."), { recursive: true });
    // The one the Python runner's memento wrote
    writeFileSync(wrapper, posix ? `#!/bin/sh\nexec python3 "${script.replace(/\.mjs$/, ".py")}" "$@"\n` : `@echo off\r\npython "${script}" %*\r\n`);
    await ensureAgyCliInstalled(home);
    const text = readFileSync(wrapper, "utf8");
    expect(text).toContain(script);
    expect(text).toContain(process.execPath);
    expect(text).not.toContain("python");

    if (posix) {
      // It runs the runner on this runtime, as Node, with every argument whole
      const prompt = "第一行\n第二行 'quoted' \"double\" $HOME `x`";
      const res = spawnSync(wrapper, ["-p", prompt], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ args: ["-p", prompt], electron: "1" });
    }

    const google = posix ? "#!/bin/sh\nexec /opt/google/agy \"$@\"\n" : "@echo off\r\n\"C:\\Google\\agy.exe\" %*\r\n";
    writeFileSync(wrapper, google);
    await ensureAgyCliInstalled(home);
    expect(readFileSync(wrapper, "utf8")).toBe(google);
  });

  it("rewrites every other `agy` memento wrote, so the links to them work again, and clears Python's leftovers", async () => {
    const dir = join(home, ".gemini", "antigravity", "bin");
    const name = posix ? "agy" : "agy.cmd";
    const py = join(dir, "agy_cli.py");
    const pyWrapper = posix ? `#!/bin/sh\nexec python3 "${py}" "$@"\n` : `@echo off\r\npython "${py}" %*\r\n`;
    // Older apps' wrapper beside the runner, a copy elsewhere on PATH, and Google's CLI on PATH
    const legacy = join(dir, name);
    const elsewhere = join(home, "elsewhere", name);
    const google = join(home, "google", name);
    const googleText = posix ? "#!/bin/sh\nexec /opt/google/agy \"$@\"\n" : "@echo off\r\n\"C:\\Google\\agy.exe\" %*\r\n";
    for (const [f, text] of [[legacy, pyWrapper], [elsewhere, pyWrapper], [google, googleText]] as const) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, text);
      if (posix) chmodSync(f, 0o755);
    }
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "agy_cli.cpython-314.pyc"), "");
    const links = join(home, "links");
    mkdirSync(links);
    if (posix) symlinkSync(legacy, join(links, "agy"));

    await ensureAgyCliInstalled(home, [join(home, "elsewhere"), join(home, "google"), links]);
    const wrapper = readFileSync(posix ? join(home, ".local", "bin", "agy") : join(home, "AppData", "Local", "agy", "bin", "agy.cmd"), "utf8");
    expect(readFileSync(legacy, "utf8")).toBe(wrapper);
    expect(readFileSync(elsewhere, "utf8")).toBe(wrapper);
    expect(readFileSync(google, "utf8")).toBe(googleText);
    expect(existsSync(join(dir, "__pycache__"))).toBe(false);
    if (posix) {
      expect(lstatSync(join(links, "agy")).isSymbolicLink()).toBe(true);
      const res = spawnSync(join(links, "agy"), ["-p", "hi"], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ args: ["-p", "hi"], electron: "1" });
    }
  });

  it("runs a .py runner with Python on every OS", async () => {
    expect(await prepareCommand("/home/u/.gemini/antigravity/bin/agy_cli.py", ["-p", "hi"], { isWindows: false, python: "/usr/bin/python3" })).toEqual({
      executable: "/usr/bin/python3",
      args: ["/home/u/.gemini/antigravity/bin/agy_cli.py", "-p", "hi"],
    });
  });

  it("lets a lookup pass over placeholders such as the Microsoft Store's python.exe", async () => {
    writeFileSync(join(home, "tool"), "");
    const env = { PATH: home };
    expect(await findExecutable(["tool"], env)).toBe(join(home, "tool"));
    expect(await findExecutable(["tool"], env, (f) => f.startsWith(home))).toBeUndefined();
  });

  it("calls the language server's agentapi directly, preferring the running app's binary", () => {
    const restore = withEnv({ HOME: home, USERPROFILE: home, LOCALAPPDATA: undefined, ANTIGRAVITY_LS_BINARY: undefined });
    try {
      // Only what's in this test's home counts (this machine may have Antigravity installed)
      const exists = (p: string) => p.startsWith(home) && isFile(p);
      expect(agentapiCommand(exists)).toBeUndefined();

      const ls = join(home, "Antigravity", "language_server.exe");
      mkdirSync(join(ls, ".."));
      writeFileSync(ls, "");
      process.env.ANTIGRAVITY_LS_BINARY = ls;
      expect(agentapiCommand(exists)).toEqual([ls, "agentapi"]);
      // Ahead of a default install
      expect(agentapiCommand((p) => p === ls || p.includes("Programs"))).toEqual([ls, "agentapi"]);
      delete process.env.ANTIGRAVITY_LS_BINARY;

      const binDir = join(home, ".gemini", "antigravity", "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "agentapi.cmd"), `@echo off\r\n"${ls}" agentapi %*\r\n`);
      expect(agentapiCommand(exists)).toEqual([ls, "agentapi"]);
      rmSync(join(binDir, "agentapi.cmd"));

      if (posix) {
        const wrapper = join(binDir, "agentapi");
        writeFileSync(wrapper, "#!/bin/sh\n");
        expect(agentapiCommand(exists)).toBeUndefined(); // not executable
        chmodSync(wrapper, 0o755);
        expect(agentapiCommand(exists)).toEqual([wrapper]);
      }
    } finally {
      restore();
    }
  });

  it("passes prompts to agentapi whole, without the runner's ELECTRON_RUN_AS_NODE", async () => {
    const fake = join(home, "fake_ls.mjs");
    writeFileSync(fake, "console.log(JSON.stringify({ args: process.argv.slice(2), electron: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n");
    const prompt = '第一行\n第二行 & | < > ^ %PATH% "quoted"';
    const restore = withEnv({ ELECTRON_RUN_AS_NODE: "1" });
    try {
      const res = await runAgentapi([process.execPath, fake, "agentapi"], "send-message", "cid", prompt);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ args: ["agentapi", "send-message", "cid", prompt], electron: null });
    } finally {
      restore();
    }
  });

  it("reads the command line as the Python runner did", () => {
    expect(parseArgs(["--dangerously-skip-permissions", "--model", "pro", "--print-timeout", "300s", "-p", "-n 是参数还是问题？"])).toEqual({
      prompt: "-n 是参数还是问题？",
      conversation: "",
      continueRecent: false,
      model: "pro",
      effort: "",
      title: "",
      timeout: 300,
    });
    const resumed = parseArgs(["--conversation", "abc", "--print-timeout", "2m", "--unknown", "继续", "做完"]);
    expect(resumed).toMatchObject({ conversation: "abc", timeout: 120, prompt: "继续 做完" });
    expect(parseArgs(["--resume=xyz", "-c", "--timeout", "90", "-phello"])).toMatchObject({ conversation: "xyz", continueRecent: true, timeout: 90, prompt: "hello" });
    expect(parseArgs(["--timeout", "soon"])).toBe("argument --timeout: invalid int value: 'soon'");
    expect(parseArgs(["-p"])).toBe("argument -p: expected one argument");
  });

  const hasSqliteCli = spawnSync(process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3", ["-version"]).status === 0;
  for (const via of ["node:sqlite", "the sqlite3 command line"] as const) {
    it.skipIf(via !== "node:sqlite" && !hasSqliteCli)(`continues (-c) the app's latest top-level conversation, through ${via}`, () => {
      useSqliteCli(via !== "node:sqlite");
      try {
        const db = join(home, "conversation_summaries.db");
        expect(latestConversationId(db)).toBe("");
        expect(
          sqliteRun(
            db,
            "CREATE TABLE conversation_summaries (conversation_id text, title text, last_modified_time datetime NOT NULL, " +
              "parent_conversation_id text NOT NULL DEFAULT '', killed numeric NOT NULL DEFAULT false)",
          ),
        ).toBe(true);
        const rows: [string, string, string, string, number][] = [
          ["older", "旧的", "2026-10-25 14:06:18+00:00", "", 0],
          ["latest", "多行\n标题 'quoted'", "2026-10-28 05:44:36+00:00", "", 0],
          ["subagent", "", "2026-10-28 06:00:00+00:00", "latest", 0],
          ["killed", "", "2026-10-28 07:00:00+00:00", "", 1],
        ];
        for (const row of rows) expect(sqliteRun(db, "INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)", row)).toBe(true);
        expect(latestConversationId(db)).toBe("latest");
        expect(sqliteRows(db, "SELECT title FROM conversation_summaries WHERE conversation_id = ?", ["latest"])?.map((r) => String(r[0]))).toEqual([
          "多行\n标题 'quoted'",
        ]);
        expect(sqliteRows(join(home, "missing", "x.db"), "SELECT 1")).toBeUndefined();
      } finally {
        useSqliteCli(false);
      }
    });
  }
});

/**
 * The runner as the app ships it, run end to end against a fake language server (Connect RPC over
 * HTTP) and a fake agentapi that writes the transcript Antigravity would.
 */
describe.skipIf(!posix)("Antigravity runner, end to end", () => {
  const CID = "conv-e2e-0001";
  let dir: string;
  let bundle: string;
  let home: string;
  let server: Server;
  let port: number;
  let rpcCalls: { method: string; body: any }[];
  let trajectory: () => unknown;
  let onAnswer: (() => void) | undefined;
  // The app's projects, as the language server's ListProjects/ReadProjects/CreateProject keep them
  let projects: { id: string; name: string; projectResources: unknown }[];

  const transcript = () => join(home, ".gemini", "antigravity", "brain", CID, ".system_generated", "logs", "transcript_full.jsonl");
  const writeSteps = (...steps: unknown[]) => {
    mkdirSync(join(transcript(), ".."), { recursive: true });
    appendFileSync(transcript(), steps.map((s) => `${JSON.stringify(s)}\n`).join(""));
  };
  const agentapiCalls = (): string[][] =>
    existsSync(join(home, "agentapi-calls.jsonl"))
      ? readFileSync(join(home, "agentapi-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "agy-e2e-"));
    bundle = join(dir, "agy_cli.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../src/agy-runner/main.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outfile: bundle,
      logLevel: "silent",
    });
    // agentapi: records its arguments, then plays Antigravity for the scenario in FAKE_AGY
    const fakeJs = join(dir, "fake_agentapi.mjs");
    writeFileSync(
      fakeJs,
      `
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
const args = process.argv.slice(2);
appendFileSync(join(home, "agentapi-calls.jsonl"), JSON.stringify(args) + "\\n");
appendFileSync(join(home, "agentapi-env.jsonl"), JSON.stringify({ conversation: process.env.ANTIGRAVITY_CONVERSATION_ID ?? null, electron: process.env.ELECTRON_RUN_AS_NODE ?? null, project: process.env.ANTIGRAVITY_PROJECT_ID ?? null }) + "\\n");
const [, sub, ...rest] = args;
const cid = ${JSON.stringify(CID)};
const log = join(home, ".gemini", "antigravity", "brain", cid, ".system_generated", "logs");
const write = (...steps) => { mkdirSync(log, { recursive: true }); appendFileSync(join(log, "transcript_full.jsonl"), steps.map((s) => JSON.stringify(s) + "\\n").join("")); };
const scenario = process.env.FAKE_AGY;
if (sub === "new-conversation") {
  const model = rest.find((a) => a.startsWith("--model=")).slice(8);
  const prompt = rest[rest.length - 1];
  if (process.env.FAKE_FAIL_MODEL === model) { process.stderr.write("UNAVAILABLE (code 503): No capacity available for model " + model); process.exit(1); }
  write({ source: "USER", type: "USER_INPUT", content: prompt });
  if (scenario === "simple") write(
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "", tool_calls: [
      { name: "view_file", args: { AbsolutePath: "/repo/README.md", toolAction: '"读取 README.md"' } },
      { name: "edit_file", args: { Path: "/repo/a.ts", Target: "x", Replacement: "y" } },
    ] },
    { step_index: 2, source: "SYSTEM", type: "GENERIC", status: "DONE", content: "Created At: 2026-11-09T10:00:00+08:00\\nCompleted At: 2026-11-09T10:00:01+08:00\\nFile Path: \`README.md\`\\n# 机密内容" },
    { step_index: 3, source: "SYSTEM", type: "GENERIC", status: "ERROR", content: "Created At: 2026-11-09T10:00:01+08:00\\nCompleted At: 2026-11-09T10:00:01+08:00\\nEncountered error in step execution: target content not found in the file" },
    { source: "MODEL", type: "PLANNER_RESPONSE", content: "  最终答案：完成  " },
  );
  if (scenario === "ask") write({ source: "MODEL", type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "ask_question", id: "tc1", args: { questions: [{ question: "选哪个？", options: ["A", "B"] }] } }] });
  if (scenario === "timer") {
    // Antigravity's schedule tool: a timer task, a reply meanwhile, then (once it fires) a system message
    // from the task and the work it woke up for, in a process of its own as the app does it later
    write(
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "schedule", args: { DurationSeconds: 3, Prompt: "复查流水线" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: new Date().toISOString(), content: "Created At: 2026-11-14T14:29:51+08:00\\nTool is running as a background task with task id: acb4c02e-913a-4f95-bac8-4f7d586f4584/task-2\\nTask Description: Timer: 3s, Prompt: 复查流水线" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "已设置 3 秒后的后台复查。" },
    );
    const later = [
      { step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\\n[Message] timestamp=x sender=acb4c02e-913a-4f95-bac8-4f7d586f4584/task-2 priority=normal\\nTimer fired.\\n</SYSTEM_MESSAGE>" },
      { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", content: "部署已完成，服务正常。" },
    ];
    const { spawn } = await import("node:child_process");
    const code = "setTimeout(() => require('node:fs').appendFileSync(" + JSON.stringify(join(log, "transcript_full.jsonl")) + ", " + JSON.stringify(later.map((s) => JSON.stringify(s) + "\\n").join("")) + "), 3000)";
    spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }).unref();
  }
  if (scenario === "hang") write({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "", tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }] });
  console.log(JSON.stringify({ response: { newConversation: { conversationId: cid } } }));
} else if (sub === "send-message") {
  const prompt = rest[rest.length - 1];
  write({ source: "USER", type: "USER_INPUT", content: prompt }, { source: "MODEL", type: "PLANNER_RESPONSE", content: "回复：" + prompt });
}
`,
    );
    const fake = join(dir, "agentapi");
    writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${fakeJs}' "$@"\n`);
    chmodSync(fake, 0o755);
    process.env.FAKE_AGENTAPI = fake;

    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const method = req.url!.split("/").pop()!;
        if (req.method === "GET") {
          res.writeHead(200).end("<html>antigravity</html>");
          return;
        }
        const body = raw ? JSON.parse(raw) : {};
        rpcCalls.push({ method, body });
        res.setHeader("Content-Type", "application/json");
        if (method === "GetUserStatus") {
          res.end(
            JSON.stringify({
              userStatus: {
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { modelId: "gemini-3.8-flash", modelOrAlias: { model: "M1" } },
                    { modelId: "gemini-4-argon-high", modelOrAlias: { model: "M2" } },
                  ],
                  defaultOverrideModelConfig: { modelOrAlias: { model: "M2" } },
                },
              },
            }),
          );
        } else if (method === "GetCascadeTrajectory") {
          res.end(JSON.stringify(trajectory()));
        } else if (method === "HandleCascadeUserInteraction") {
          res.end("{}");
          onAnswer?.();
        } else if (method === "ListProjects") {
          res.end(JSON.stringify({ projectIds: [...projects.map((p) => p.id), "outside-of-project"] }));
        } else if (method === "ReadProjects") {
          res.end(JSON.stringify({ projects: projects.filter((p) => body.ids.includes(p.id)) }));
        } else if (method === "ReadProject") {
          const project = projects.find((p) => p.id === body.id);
          res.end(JSON.stringify(project ? { project } : { notFoundOnDisk: true }));
        } else if (method === "CreateProject") {
          projects.push(body.project);
          res.end("{}");
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    home = mkdtempSync(join(dir, "home-"));
    rpcCalls = [];
    projects = [];
    trajectory = () => ({ trajectory: { trajectoryId: "traj-1", steps: [] } });
    onAnswer = undefined;
  });

  const events = (stdout: string) => stdout.split("\n").filter((l) => l.includes('"memento_event"')).map((l) => JSON.parse(l).event);
  const reply = (stdout: string) => stdout.split("\n").filter((l) => !l.includes('"memento_event"')).join("\n");

  /** Starts the runner; `done` resolves once it exits. */
  function start(args: string[], env: Record<string, string> = {}, cwd?: string) {
    // MEMENTO_E2E_RUNTIME: the desktop app's executable, to run it on Electron as Node as tasks do
    const child = spawn(process.env.MEMENTO_E2E_RUNTIME || process.execPath, [bundle, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${port}`,
        ANTIGRAVITY_CSRF_TOKEN: "csrf-test",
        ANTIGRAVITY_LS_BINARY: process.env.FAKE_AGENTAPI,
        // As the daemon starts it, and as a parent Antigravity session may leave it
        ELECTRON_RUN_AS_NODE: "1",
        ANTIGRAVITY_CONVERSATION_ID: "inherited-parent",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (c) => (out.stdout += c));
    child.stderr.on("data", (c) => (out.stderr += c));
    const done = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
    const waitFor = async (pred: () => boolean, ms = 8000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out; stdout=${out.stdout} stderr=${out.stderr}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    return { child, out, done, waitFor };
  }

  it("starts a conversation on the app's default model, steps down a tier when it can't, and ends on the reply", async () => {
    // The task's folder has a project of its own; the app made another one last (2026-11-14: tasks for
    // easywork-copilot ran in chem-vision)
    const work = join(home, "easywork-copilot");
    mkdirSync(work);
    projects = [
      { id: "proj-easy", name: "easywork-copilot", projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(work).href } }] } },
      { id: "proj-chem", name: "chem-vision", projectResources: { resources: [{ gitFolder: { folderUri: "file:///d%3A/dev/chem-vision" } }] } },
    ];
    const run = start(
      ["--dangerously-skip-permissions", "-p", "看看 README"],
      { FAKE_AGY: "simple", FAKE_FAIL_MODEL: "gemini-4-argon-high", ANTIGRAVITY_PROJECT_ID: "proj-chem" },
      work,
    );
    expect(await run.done).toBe(0);
    expect(agentapiCalls().map((a) => a[2])).toEqual(["--model=gemini-4-argon-high", "--model=pro"]);
    expect(agentapiCalls()[1]).toEqual(["agentapi", "new-conversation", "--model=pro", "--title=看看 README", "看看 README"]);
    expect(run.out.stderr).toContain("模型 gemini-4-argon-high 启动遇到异常 (UNAVAILABLE (code 503)");
    expect(run.out.stderr).toContain("⚡ [提示: 模型 gemini-4-argon-high 暂不可用，已自动智能降级至 pro 成功建立会话]");
    expect(run.out.stderr).toMatch(/^session id: conv-e2e-0001$/m);
    // Each call a row with what it works on; its result closes it, with the output minus the timestamps
    expect(events(run.out.stdout).filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", id: "agy_1_0", name: "view_file", detail: "/repo/README.md", status: "running" },
      { kind: "tool", id: "agy_1_1", name: "edit_file", detail: "/repo/a.ts", status: "running" },
      { kind: "tool", id: "agy_1_0", status: "done", output: "File Path: `README.md`\n# 机密内容" },
      { kind: "tool", id: "agy_1_1", status: "failed", output: "Encountered error in step execution: target content not found in the file" },
    ]);
    expect(run.out.stdout).toContain("最终答案：完成\n\n");
    // A tool's output is never part of the reply
    expect(reply(run.out.stdout)).not.toContain("机密内容");
    expect(rpcCalls.map((c) => c.method)).toEqual(["GetUserStatus", "ListProjects", "ReadProjects"]);
    // Neither the runner's runtime switch nor a parent session's id reaches agentapi; the conversation
    // goes in the folder's project, not the inherited one
    const envs = readFileSync(join(home, "agentapi-env.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const sent = { conversation: null, electron: null, project: "proj-easy" };
    expect(envs).toEqual([sent, sent]);
  });

  it("waits for a timer Antigravity set and ends on the work it wakes up for, not at the quiet limit", async () => {
    // Background commands may be quiet for 1 s here; the timer is due in 3 s (2026-11-14: a 240 s timer
    // outlasted the 180 s limit and the deployment report that followed never reached memento)
    const run = start(["-p", "发布并跟踪"], { FAKE_AGY: "timer", MEMENTO_AGY_BACKGROUND_QUIET_MS: "1000" });
    expect(await run.done).toBe(0);
    expect(run.out.stderr).not.toContain("STATUS_STILL_RUNNING");
    expect(run.out.stderr).toContain("Antigravity 设了 3 秒后的定时复查");
    expect(reply(run.out.stdout)).toContain("已设置 3 秒后的后台复查。");
    expect(reply(run.out.stdout)).toContain("部署已完成，服务正常。");
    expect(events(run.out.stdout).filter((e) => e.kind === "tool" && e.status !== "running").map((e) => e.status)).toContain("done");
  }, 20_000);

  it("shows a question Antigravity holds and sends the answer back the way the app does", async () => {
    let answered = false;
    trajectory = () => ({
      trajectory: {
        trajectoryId: "traj-1",
        steps: [
          { status: "CORTEX_STEP_STATUS_DONE" },
          {
            status: answered ? "CORTEX_STEP_STATUS_DONE" : "CORTEX_STEP_STATUS_WAITING",
            requestedInteraction: { askQuestion: {} },
            askQuestion: { questions: [{ question: "选哪个？", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }] }] },
          },
        ],
      },
    });
    onAnswer = () => {
      answered = true;
      writeSteps({ source: "USER", type: "USER_INPUT", content: "B" }, { source: "MODEL", type: "PLANNER_RESPONSE", content: "你选了 B" });
    };
    const run = start(["-p", "帮我选"], { FAKE_AGY: "ask" });
    await run.waitFor(() => run.out.stdout.includes('"type":"memento_event"'));
    const event = JSON.parse(run.out.stdout.split("\n").find((l) => l.includes("memento_event"))!).event;
    expect(event).toEqual({
      kind: "question",
      id: "agy_conv-e2e_1_0",
      tool: "ask_question",
      question: "选哪个？",
      options: ["A", "B"],
      is_multi_select: false,
      status: "waiting",
    });
    run.child.stdin.write(`${JSON.stringify({ type: "memento_answer", question_id: event.id, answer: "B" })}\n`);
    expect(await run.done).toBe(0);
    const submitted = rpcCalls.find((c) => c.method === "HandleCascadeUserInteraction")!.body;
    expect(submitted).toEqual({
      cascadeId: CID,
      interaction: {
        trajectoryId: "traj-1",
        stepIndex: 1,
        askQuestion: { responses: [{ question: "选哪个？", options: [{ id: "o1", text: "A" }, { id: "o2", text: "B" }], selectedOptionIds: ["o2"] }] },
      },
    });
    // The question is its own row, not a tool step as well
    expect(events(run.out.stdout).filter((e) => e.kind === "tool")).toEqual([]);
    expect(run.out.stdout).toContain("你选了 B");
    // The answer went to the open question, not to agentapi as a follow-up message
    expect(agentapiCalls().map((a) => a[1])).toEqual(["new-conversation"]);
  });

  it("resumes a conversation and shows only what comes after the follow-up", async () => {
    writeSteps({ source: "USER", type: "USER_INPUT", content: "以前" }, { source: "MODEL", type: "PLANNER_RESPONSE", content: "旧回复" });
    const run = start(["--resume", CID, "-p", "继续"], { FAKE_AGY: "simple" });
    expect(await run.done).toBe(0);
    expect(agentapiCalls()).toEqual([["agentapi", "send-message", "--title=继续", CID, "继续"]]);
    expect(run.out.stdout).toContain("回复：继续");
    expect(run.out.stdout).not.toContain("旧回复");
  });

  it("gives up at the task timeout and stops on a signal", async () => {
    // The model still thinking: only the task timeout ends it
    const timed = start(["--print-timeout", "1s", "-p", "想一想"], { FAKE_AGY: "think" });
    expect(await timed.done).toBe(124);
    expect(timed.out.stderr).toContain("[Agent timeout: 任务执行已达到安全上限（1s）]");

    const stopped = start(["-p", "跑命令"], { FAKE_AGY: "hang" });
    await stopped.waitFor(() => events(stopped.out.stdout).some((e) => e.name === "run_command" && e.detail === "npm test"));
    stopped.child.kill("SIGTERM");
    expect(await stopped.done).toBe(130);
    expect(stopped.out.stderr).toContain("⏹️ [收到系统终止信号 (SIGTERM)，已主动停止 Antigravity 任务]");
  });

  it("explains what's missing instead of starting", async () => {
    const empty = start([], {});
    empty.child.stdin.end();
    expect(await empty.done).toBe(1);
    expect(empty.out.stderr).toContain("Error: empty prompt");

    const badTimeout = start(["--timeout", "soon", "-p", "hi"]);
    expect(await badTimeout.done).toBe(2);
    expect(badTimeout.out.stderr).toContain("argument --timeout: invalid int value: 'soon'");
    expect(agentapiCalls()).toEqual([]);
  });
});

describe("Antigravity tool steps", () => {
  it("say which file, command or query each call works on", () => {
    expect(agyToolDetail("read_file", { Path: "/a/b.ts", StartLine: 10, EndLine: 40 })).toBe("/a/b.ts:10-40");
    expect(agyToolDetail("view_file", { AbsolutePath: "/a/README.md", toolAction: "读取 README.md" })).toBe("/a/README.md");
    expect(agyToolDetail("edit_file", { Path: "/a/b.ts", Target: "x", Replacement: "y" })).toBe("/a/b.ts");
    expect(agyToolDetail("replace_file_content", { TargetFile: "/a/c.py", Description: "d" })).toBe("/a/c.py");
    expect(agyToolDetail("write_to_file", { TargetFile: "/a/new.md", CodeContent: "..." })).toBe("/a/new.md");
    expect(agyToolDetail("run_command", { CommandLine: "npm test\nnpm run build", WaitMsBeforeAsync: 500 })).toBe("npm test");
    expect(agyToolDetail("grep_search", { Query: "TODO", SearchPath: "/a" })).toBe("TODO  /a");
    expect(agyToolDetail("find_by_name", { Pattern: "*.ts", SearchDirectory: "/a" })).toBe("*.ts  /a");
    expect(agyToolDetail("list_dir", { DirectoryPath: "/a" })).toBe("/a");
    expect(agyToolDetail("manage_task", { Action: "kill", TaskId: "x/task-3" })).toBe("kill x/task-3");
    expect(agyToolDetail("invoke_subagent", { Role: "审查", Prompt: "看看改动" })).toBe("审查：看看改动");
    expect(agyToolDetail("some_new_tool", { toolSummary: '"整理清单"' })).toBe("整理清单");
    expect(agyToolDetail("other_tool", { Foo: "bar" })).toBe("bar");
  });

  it("show a result without Antigravity's timestamps and reminders", () => {
    expect(
      agyToolOutput(
        "Created At: 2026-11-01T19:20:13+08:00\nCompleted At: 2026-11-01T19:20:13+08:00\nCreated file file:///a/D.md with requested content.\nIf relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission.",
      ),
    ).toBe("Created file file:///a/D.md with requested content.");
    expect(agyToolOutput("Created At: x\nCommand exited with code 0.\n\nCommand output:\nok")).toBe("Command exited with code 0.\n\nCommand output:\nok");
  });
});
