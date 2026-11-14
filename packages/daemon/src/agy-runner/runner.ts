import { execFile, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { agyToolDetail, agyToolOutput } from "../agent-stream.js";

export { agyToolDetail, agyToolOutput };
import { sqliteRows } from "../sqlite.js";

/**
 * memento's Antigravity task runner (bundled to assets/agy_cli.mjs, run on Electron as Node).
 * It drives the language server the running Antigravity app started, through its `agentapi`
 * subcommand and Connect RPC API, in the app's own conversations (~/.gemini/antigravity),
 * the ones memento collects and resumes.
 *
 * What the daemon reads (task-runner.ts, agent-stream.ts):
 *   - "session id: <id>" on stderr once the conversation is known, and progress lines there;
 *   - the reply on stdout, with memento_event JSON lines for each tool call (what it works on, its
 *     status and output) and each question;
 *   - answers on stdin as {"type":"memento_answer","question_id","answer"}; any other line is a follow-up;
 *   - "[STATUS_STILL_RUNNING: tasks=…]" when background tasks outlive the wait;
 *   - exit 0 done, 1 failed, 124 timed out or unfinished, 130 stopped.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Python truthiness: Antigravity leaves fields empty as often as it leaves them out. */
const truthy = (v: unknown): boolean =>
  v !== undefined &&
  v !== null &&
  v !== false &&
  v !== 0 &&
  v !== "" &&
  !(Array.isArray(v) && v.length === 0) &&
  !(isObj(v) && Object.keys(v).length === 0);
const or = (...vs: unknown[]): unknown => vs.find(truthy);
/** The first n characters (code points, so an emoji is never cut in half). */
const head = (s: string, n: number): string => Array.from(s).slice(0, n).join("");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const err = (text: string) => void process.stderr.write(text);
const out = (text: string) => void process.stdout.write(text);

const agyHome = () => join(homedir(), ".gemini", "antigravity");

/** stdout of a command, rejecting when it fails (as Python's check_output). */
function capture(cmd: string, args: string[], timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 << 20 }, (e, stdout) =>
      e ? reject(e) : resolve(stdout),
    );
  });
}

/** stdout of a command whatever its exit code; "" when it couldn't start. */
function outputOf(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout, windowsHide: true }, (_e, stdout) => resolve(stdout ?? ""));
  });
}

async function probePage(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { "User-Agent": "Antigravity-Probe" },
      signal: AbortSignal.timeout(1000),
    });
    if (res.status !== 200) {
      await res.body?.cancel();
      return undefined;
    }
    const page = (await res.text()).slice(0, 2048);
    return page.includes("antigravity") || page.includes("csrfToken") ? page : undefined;
  } catch {
    return undefined;
  }
}

/** Finds ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN when run by hand (the daemon passes them). */
export async function autoDiscoverLanguageServer(): Promise<void> {
  if (process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) return;
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      let pid: string | undefined;
      let csrf: string | undefined;
      for (const line of (await capture("ps", ["-eo", "pid,command"])).split("\n")) {
        if (line.includes("language_server") && line.includes("antigravity") && !line.includes("grep")) {
          pid = /^\s*(\d+)/.exec(line)?.[1];
          csrf = /--csrf_token\s+(\S+)/.exec(line)?.[1];
          break;
        }
      }
      if (!pid) return;
      const lsof = await capture("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid]);
      const ports = lsof
        .split("\n")
        .map((l) => /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(l)?.[1])
        .filter((p): p is string => !!p)
        .map(Number);
      for (const port of ports) {
        const page = await probePage(port);
        if (page === undefined) continue;
        csrf ??= /"csrfToken":"([^"]+)"/.exec(page)?.[1];
        process.env.ANTIGRAVITY_LS_ADDRESS = `localhost:${port}`;
        if (csrf) process.env.ANTIGRAVITY_CSRF_TOKEN = csrf;
        return;
      }
    } else if (process.platform === "win32") {
      const raw = await capture(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name LIKE '%language_server%'\" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json",
        ],
        3000,
      );
      const data: unknown = JSON.parse(raw);
      let pid: string | undefined;
      let csrf: string | undefined;
      for (const item of Array.isArray(data) ? data : [data]) {
        const cmdLine = str(obj(item).CommandLine);
        if (cmdLine.toLowerCase().includes("antigravity")) {
          pid = String(obj(item).ProcessId);
          csrf = /--csrf_token\s+(\S+)/.exec(cmdLine)?.[1];
          break;
        }
      }
      if (!pid) return;
      const ports = (await capture("netstat", ["-ano"]))
        .split("\n")
        .filter((l) => l.includes("LISTENING") && l.trim().split(/\s+/).pop() === pid)
        .map((l) => /127\.0\.0\.1:(\d+)/.exec(l)?.[1])
        .filter((p): p is string => !!p)
        .map(Number);
      for (const port of ports) {
        const page = await probePage(port);
        if (page === undefined) continue;
        csrf ??= /"csrfToken":"([^"]+)"/.exec(page)?.[1];
        process.env.ANTIGRAVITY_LS_ADDRESS = `localhost:${port}`;
        if (csrf) process.env.ANTIGRAVITY_CSRF_TOKEN = csrf;
        break;
      }
    }
  } catch {
    // not found: the caller says Antigravity isn't running
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * argv prefix for `agentapi`, a subcommand of the Antigravity app's language_server; undefined when it
 * isn't there. The binary is called directly, never through a .cmd wrapper: cmd.exe would cut a
 * multi-line prompt at the first line break and act on & | < > ^ % in it.
 */
export function agentapiCommand(fileExists: (p: string) => boolean = isFile): string[] | undefined {
  const binDir = join(agyHome(), "bin");
  // First the running app's binary, which the daemon finds (it matches the language server it talks to,
  // wherever Antigravity is installed), then the default install folders
  const candidates = [
    ...(process.env.ANTIGRAVITY_LS_BINARY ? [process.env.ANTIGRAVITY_LS_BINARY] : []),
    "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
    join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Programs", "Antigravity", "resources", "bin", "language_server.exe"),
    "C:/Program Files/Antigravity/resources/bin/language_server.exe",
  ];
  // What an older runner wrote into agentapi.cmd
  try {
    const m = /"([^"]+)"\s+agentapi/.exec(readFileSync(join(binDir, "agentapi.cmd"), "utf8"));
    if (m) candidates.push(m[1]!);
  } catch {
    // none
  }
  for (const c of candidates) if (fileExists(c)) return [c, "agentapi"];
  const wrapper = join(binDir, "agentapi");
  if (process.platform !== "win32" && fileExists(wrapper) && isExecutable(wrapper)) return [wrapper];
  return undefined;
}

/** The app's most recently active top-level conversation (what `-c` continues); "" when there's none. */
export function latestConversationId(dbPath = join(agyHome(), "conversation_summaries.db")): string {
  if (!existsSync(dbPath)) return "";
  const rows = sqliteRows(
    dbPath,
    "SELECT conversation_id FROM conversation_summaries WHERE killed = 0 AND parent_conversation_id = '' " +
      "ORDER BY last_modified_time DESC LIMIT 1",
    [],
    2000,
  );
  const id = rows?.[0]?.[0];
  return truthy(id) ? String(id).trim() : "";
}

export interface Completed {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `agentapi` with these arguments, passed as they are (prompts with line breaks and quotes stay whole). */
export function runAgentapi(agentapi: string[], ...args: string[]): Promise<Completed> {
  return new Promise((resolve, reject) => {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    // stdin stays ours: it carries the user's answers
    const child = spawn(agentapi[0]!, [...agentapi.slice(1), ...args], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

/** Whether the language server still answers its HTTP probe. */
async function isLanguageServerAlive(): Promise<boolean> {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  if (!addr) return false;
  try {
    const res = await fetch(`http://${addr}/`, { headers: { "User-Agent": "Antigravity-Probe" }, signal: AbortSignal.timeout(1500) });
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * A folder as Antigravity writes it in a project's resources: file:///d%3A/dev/x on Windows (drive
 * lower-cased, colon escaped, as VS Code URIs), file:///Users/x elsewhere.
 */
export function agyFolderUri(dir: string, platform: NodeJS.Platform = process.platform): string {
  const path = dir.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(path);
  const enc = (p: string) => p.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  if (drive?.[1] && platform === "win32") return `file:///${drive[1].toLowerCase()}%3A${enc(drive[2] || "/")}`;
  return `file://${enc(path.startsWith("/") ? path : `/${path}`)}`;
}

/** Two folder URIs (or paths) naming the same folder: decoded, slashes and trailing slash evened out. */
export function sameAgyFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (u: string) => {
    let p = u.trim();
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep as is
    }
    p = p.replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return platform === "win32" || /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
  };
  return norm(a) === norm(b);
}

/** A folder URI's or path's real path when it exists here (symlinks such as macOS /tmp resolved), else as is. */
function realFolder(uriOrPath: string): string {
  let p = uriOrPath.trim();
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as is
  }
  p = p.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The same folder, by how it's written or by where it really is. */
const isFolder = (uri: string, dir: string) => sameAgyFolder(uri, dir) || sameAgyFolder(realFolder(uri), realFolder(dir));

/** Folder URIs a project's resources name (git folders and plain folders alike). */
function projectFolders(project: Obj): string[] {
  const uris: string[] = [];
  for (const r of list(obj(project.projectResources).resources)) {
    for (const v of Object.values(obj(r))) {
      const uri = str(obj(v).folderUri);
      if (uri) uris.push(uri);
    }
  }
  return uris;
}

/** Ids of the projects Antigravity has (the built-in "outside-of-project" left out). */
async function agyProjects(): Promise<Obj[]> {
  const ids = list(obj(await lsRpc("ListProjects", {})).projectIds)
    .map(str)
    .filter((id) => id && id !== "outside-of-project");
  if (!ids.length) return [];
  return list(obj(await lsRpc("ReadProjects", { ids })).projects).map(obj);
}

/** The project the latest of the app's own conversations in this folder ran in, if it still exists. */
async function projectFromHistory(dir: string, known: Set<string>): Promise<string | undefined> {
  const rows =
    sqliteRows(
      join(agyHome(), "conversation_summaries.db"),
      "SELECT project_id, workspace_uris FROM conversation_summaries WHERE project_id NOT IN ('', 'outside-of-project', 'default-cli-project') ORDER BY last_modified_time DESC LIMIT 2000",
    ) ?? [];
  for (const [pid, ws] of rows) {
    const id = str(pid);
    let uris: unknown[] = [];
    try {
      uris = list(JSON.parse(str(ws) || "[]"));
    } catch {
      continue;
    }
    if (uris.length !== 1 || !isFolder(str(uris[0]), dir)) continue;
    if (known.has(id)) return id;
    const p = obj(obj(await lsRpc("ReadProject", { id })).project);
    if (str(p.id) === id) return id;
  }
  return undefined;
}

/**
 * The Antigravity project a new conversation works in for this folder: one whose resources name it,
 * else the one the app's own conversations here used, else a new one made for it. agentapi starts a
 * conversation in ANTIGRAVITY_PROJECT_ID's project and takes its workspace from there, not from our
 * cwd; without it the hub used its default project, so a task for easywork-copilot ran in the
 * chem-vision project created last (seen 2026-11-14 on Windows). No project for the home folder or
 * a drive root: those are what no folder picked looks like.
 */
export async function projectForFolder(dir: string): Promise<string | undefined> {
  const full = resolve(dir);
  if (sameAgyFolder(full, homedir()) || dirname(full) === full) return undefined;
  const projects = await agyProjects();
  const match = projects.find((p) => projectFolders(p).some((u) => isFolder(u, full)));
  if (match && str(match.id)) return str(match.id);
  const fromHistory = await projectFromHistory(full, new Set(projects.map((p) => str(p.id))));
  if (fromHistory) return fromHistory;
  // Names are unique in the app: the folder's, then with its parent, then numbered
  const names = new Set(projects.map((p) => str(p.name)));
  const base = basename(full) || full;
  const pick = [base, `${base} (${basename(dirname(full))})`, ...Array.from({ length: 8 }, (_, i) => `${base} ${i + 2}`)].find(
    (n) => !names.has(n),
  );
  if (!pick) return undefined;
  // The id is ours to give: without one the app writes the project to "projects/.json"
  const id = randomUUID();
  const created = await lsRpc("CreateProject", {
    project: { id, name: pick, projectResources: { resources: [{ gitFolder: { folderUri: agyFolderUri(full) } }] } },
  });
  if (!created) return undefined;
  return str(obj(obj(await lsRpc("ReadProject", { id })).project).id) === id ? id : undefined;
}

/** Calls the language server's Connect RPC with JSON, as the Antigravity app does; null on failure. */
export async function lsRpc(method: string, body: unknown, timeoutSeconds = 10): Promise<Obj | null> {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  if (!addr) return null;
  try {
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-codeium-csrf-token": process.env.ANTIGRAVITY_CSRF_TOKEN ?? "" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const parsed: unknown = JSON.parse((await res.text()) || "{}");
    return isObj(parsed) ? parsed : {};
  } catch {
    return null;
  }
}

const YES = /^\s*(允许|是|好|确认|同意|yes|y|ok|allow|accept|approve)/i;

/**
 * Commands Antigravity is running right now: its language server's child processes (a run_command
 * shows up as `zsh -c <command>`). Empty where this can't be told (no pgrep, e.g. Windows).
 */
export async function lsRunningCommands(): Promise<string[]> {
  const cmds: string[] = [];
  for (const pid of (await outputOf("pgrep", ["-f", "[Aa]ntigravity.*language_server"], 2000)).split(/\s+/).filter(Boolean)) {
    for (const child of (await outputOf("pgrep", ["-P", pid], 2000)).split(/\s+/).filter(Boolean)) {
      const cmd = (await outputOf("ps", ["-o", "command=", "-p", child], 2000)).trim();
      if (cmd) cmds.push(cmd);
    }
  }
  return cmds;
}

/** Status line while the transcript is quiet and no tool call is known to be in flight. */
export function thinkingHeartbeat(elapsedSec: number, runningCmds: string[]): string {
  if (runningCmds.length) {
    let shown = runningCmds[0]!;
    for (const prefix of ["/bin/zsh -c ", "zsh -c ", "/bin/bash -c ", "bash -c ", "sh -c "]) {
      if (shown.startsWith(prefix)) {
        shown = shown.slice(prefix.length);
        break;
      }
    }
    return `⏳ [命令执行中（已用时 ${elapsedSec}s）：${head(shown, 60)}]`;
  }
  if (elapsedSec >= 600) return `⏳ [模型仍在生成（已用时 ${elapsedSec}s），远端模型可能在排队重试；任务仍在进行，可随时停止]`;
  return `⏳ [模型思考推理中（已用时 ${elapsedSec}s），请稍候...]`;
}

/** The model the user picked in the Antigravity app (its default), from the language server. */
async function activeModelId(): Promise<string> {
  try {
    const us = obj(obj(await lsRpc("GetUserStatus", {}, 2.5)).userStatus);
    const cfg = obj(us.cascadeModelConfigData);
    const models = list(cfg.clientModelConfigs).map(obj);
    const override = obj(obj(cfg.defaultOverrideModelConfig).modelOrAlias).model;
    if (truthy(override) && models.length) {
      for (const m of models) {
        if (obj(m.modelOrAlias).model === override || m.modelId === override) {
          const id = String(m.modelId ?? "").trim();
          if (id) return id;
        }
      }
    }
    if (models.length) return String(models[0]!.modelId ?? "").trim();
  } catch {
    // no default
  }
  return "";
}

/** Antigravity model IDs / tiers (flash, pro, flash_lite) to try, in order. */
export function getModelCandidates(requestedModel: string): string[] {
  const m = (requestedModel || "").toLowerCase().trim();
  if (!m || ["flash", "gemini-3.8-flash", "gemini-3.7-flash"].includes(m)) return ["flash", "pro", "flash_lite"];
  if (["flash_lite", "flash-lite", "gemini-3.6-flash", "gemini-2.5-flash-lite"].includes(m)) return ["flash_lite", "flash", "pro"];
  if (["pro", "gemini-3.1-pro", "gemini-2.5-pro", "claude-sonnet-4-6", "claude-opus-4-6", "claude-3-7-sonnet"].includes(m)) {
    return ["pro", "flash", "flash_lite"];
  }
  let tiers: string[];
  if (["argon", "pro", "ultra", "opus", "sonnet", "gpt"].some((k) => m.includes(k))) tiers = ["pro", "flash", "flash_lite"];
  else if (m.includes("lite")) tiers = ["flash_lite", "flash", "pro"];
  else tiers = ["flash", "pro", "flash_lite"];
  return [m, ...tiers.filter((t) => t !== m)];
}

const TRANSIENT = [
  "connection reset", "eof", "broken pipe", "timeout", "timed out",
  "handshake", "temporarily unavailable", "stream was interrupted",
  "stream interrupted", "interrupted", "please continue the task",
  "rate limit", "resource exhausted", "overloaded", "retry", "try again",
  "no capacity available", "capacity available", "code 503", "unavailable",
  "service unavailable", "bad gateway", "502", "503", "504",
  "quota reached", "quota", "temporarily",
];

/**
 * The error a trajectory ends on (its last step an ERROR_MESSAGE the language server isn't retrying), as
 * the user is shown it; "" while it goes on or ended otherwise.
 */
export function finalTrajectoryError(steps: unknown[]): string {
  const last = obj(steps.at(-1));
  if (last.type !== "CORTEX_STEP_TYPE_ERROR_MESSAGE" || last.status !== "CORTEX_STEP_STATUS_DONE") return "";
  const e = obj(obj(last.errorMessage).error);
  const msg = str(or(e.modelErrorMessage, e.userErrorMessage, e.shortError, e.fullError)) || "Antigravity 返回了错误";
  return isTransientError(msg) ? "" : msg;
}

/**
 * Whether an Antigravity error is an upstream retry, rate limit or temporary capacity problem. A used-up
 * quota ("Individual quota reached … Resets in 54h11m34s") isn't, unless the server is still retrying it
 * (an "attempt N"): waiting on it held runs for their whole 2 hours.
 */
export function isTransientError(errMsg: string): boolean {
  if (!errMsg) return false;
  const low = errMsg.toLowerCase();
  if (/attempt\s+\d+/.test(low)) return true;
  if (/individual quota reached|quota_exhausted/.test(low)) return false;
  return TRANSIENT.some((kw) => low.includes(kw));
}

export interface RunnerArgs {
  prompt: string;
  /** --resume / --conversation */
  conversation: string;
  continueRecent: boolean;
  model: string;
  effort: string;
  title: string;
  /** Seconds; 0 = unlimited */
  timeout: number;
}

const VALUE_OPTIONS: Record<string, string> = {
  "-p": "prompt",
  "--prompt": "prompt",
  "--resume": "resume",
  "--conversation": "conversation",
  "--model": "model",
  "--effort": "effort",
  "--title": "title",
  "--timeout": "timeout",
  "--print-timeout": "printTimeout",
  "--output-format": "outputFormat",
};
const FLAG_OPTIONS: Record<string, string> = {
  "-c": "continue",
  "--continue": "continue",
  "--dangerously-skip-permissions": "skipPermissions",
};

/** `--print-timeout` as the official agy CLI takes it: seconds, or with an s / m suffix. */
function printTimeoutSeconds(value: string): number | undefined {
  let pt = value.trim().toLowerCase();
  if (pt.endsWith("s")) pt = pt.slice(0, -1);
  else if (pt.endsWith("m")) {
    const minutes = pt.slice(0, -1).trim() ? Number(pt.slice(0, -1)) : Number.NaN;
    if (Number.isFinite(minutes)) pt = String(Math.trunc(minutes * 60));
  }
  return /^\s*[+-]?\d+\s*$/.test(pt) ? Number.parseInt(pt, 10) : undefined;
}

/** The command line, as the Python runner's argparse read it; a string is a usage error. Unknown options are ignored. */
export function parseArgs(argv: string[]): RunnerArgs | string {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const words: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (positionalOnly || !a.startsWith("-") || a === "-" || /^-\d/.test(a)) {
      words.push(a);
      continue;
    }
    if (a === "--") {
      positionalOnly = true;
      continue;
    }
    let name = a;
    let inlineValue: string | undefined;
    if (!(a in VALUE_OPTIONS) && !(a in FLAG_OPTIONS)) {
      const eq = a.indexOf("=");
      if (eq > 0 && a.slice(0, eq) in VALUE_OPTIONS) {
        name = a.slice(0, eq);
        inlineValue = a.slice(eq + 1);
      } else if (a.startsWith("-p") && !a.startsWith("--")) {
        name = "-p";
        inlineValue = a.slice(2);
      } else {
        // An unknown option; one with a space in it is prompt text
        if (a.includes(" ")) words.push(a);
        continue;
      }
    }
    if (name in FLAG_OPTIONS) {
      flags.add(FLAG_OPTIONS[name]!);
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) return `argument ${name}: expected one argument`;
    values[VALUE_OPTIONS[name]!] = value;
  }
  let timeout = 0;
  if (values.timeout !== undefined) {
    if (!/^\s*[+-]?\d+\s*$/.test(values.timeout)) return `argument --timeout: invalid int value: '${values.timeout}'`;
    timeout = Number.parseInt(values.timeout, 10);
  }
  if (values.printTimeout) timeout = printTimeoutSeconds(values.printTimeout) ?? timeout;
  return {
    prompt: [...(values.prompt ? [values.prompt] : []), ...words].join(" ").trim(),
    conversation: (values.conversation || values.resume || "").trim(),
    continueRecent: flags.has("continue"),
    model: (values.model ?? "").trim(),
    effort: values.effort ?? "",
    title: values.title ?? "",
    timeout,
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString("utf8");
}

/** New lines of a transcript Antigravity is appending to, from a byte offset on. */
class TranscriptReader {
  private readonly fd: number;
  private pos: number;
  private rest = Buffer.alloc(0);
  private lines: string[] = [];

  constructor(path: string, start: number) {
    this.fd = openSync(path, "r");
    this.pos = start;
  }

  /** The next whole line, or undefined when nothing new has been written. */
  next(): string | undefined {
    if (!this.lines.length) this.fill();
    return this.lines.shift();
  }

  close(): void {
    closeSync(this.fd);
  }

  private fill(): void {
    const size = fstatSync(this.fd).size;
    if (size > this.pos) {
      const chunk = Buffer.alloc(Math.min(size - this.pos, 8 << 20));
      const n = readSync(this.fd, chunk, 0, chunk.length, this.pos);
      this.pos += n;
      this.rest = Buffer.concat([this.rest, chunk.subarray(0, n)]);
    }
    for (let nl = this.rest.indexOf(0x0a); nl >= 0; nl = this.rest.indexOf(0x0a)) {
      this.lines.push(this.rest.subarray(0, nl).toString("utf8"));
      this.rest = this.rest.subarray(nl + 1);
    }
    // A last line still without its line break counts once it is whole JSON (a half-written one never parses)
    if (!this.lines.length && this.rest.length) {
      const text = this.rest.toString("utf8");
      try {
        JSON.parse(text);
        this.lines.push(text);
        this.rest = Buffer.alloc(0);
      } catch {
        // wait for the rest
      }
    }
  }
}

/** Whether a background task's log ends with its timer firing or being cancelled. */
function timerEnded(logPath: string, size: number): boolean {
  const fd = openSync(logPath, "r");
  try {
    const len = Math.min(512, size);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    const tail = buf.subarray(0, n).toString("utf8");
    return tail.includes("] Timer fired.") || tail.includes("] Timer cancelled:");
  } finally {
    closeSync(fd);
  }
}

interface QuestionItem {
  question: string;
  options: string[];
  multi: boolean;
  command?: string;
  uri?: string;
}

interface Interaction {
  kind: string;
  trajectoryId: unknown;
  step: Obj;
  items: QuestionItem[];
  answers: Map<number, string>;
}

const transcriptPaths = (convId: string) => {
  const logs = join(agyHome(), "brain", convId, ".system_generated", "logs");
  return [join(logs, "transcript_full.jsonl"), join(logs, "transcript.jsonl")] as const;
};

const fileSize = (p: string): number | undefined => {
  try {
    return statSync(p).size;
  } catch {
    return undefined;
  }
};

/** Runs one task (or follow-up) and resolves with the exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    err(`agy_cli: error: ${args}\n`);
    return 2;
  }

  let convId = args.conversation;
  if (args.continueRecent && !convId) convId = latestConversationId();

  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    try {
      prompt = (await readAll(process.stdin)).trim();
    } catch {
      // no prompt
    }
  }
  if (!prompt) {
    err("Error: empty prompt\n");
    return 1;
  }

  const agentapi = agentapiCommand();
  if (!agentapi) {
    err("Error: agentapi not found: Antigravity's language_server isn't installed where expected\n");
    return 1;
  }

  if (!process.env.ANTIGRAVITY_LS_ADDRESS) await autoDiscoverLanguageServer();
  if (!process.env.ANTIGRAVITY_LS_ADDRESS) {
    err("💡 未检测到正在运行的 Antigravity 应用服务。请先启动 Antigravity 应用后再试。\n");
    return 1;
  }

  // Inherited from a parent Antigravity session or subagent, these make agentapi fail with
  // "sender conversation not found"
  for (const k of ["ANTIGRAVITY_SOURCE_METADATA", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_TRAJECTORY_ID"]) {
    delete process.env[k];
  }

  const candidates = getModelCandidates(args.model || (await activeModelId()));
  const title = args.title || head(prompt, 40);
  let startPos = 0;

  if (convId) {
    const [full, plain] = transcriptPaths(convId);
    startPos = fileSize(full) ?? fileSize(plain) ?? 0;
    try {
      const res = await runAgentapi(agentapi, "send-message", `--title=${title}`, convId, prompt);
      if (res.code !== 0) {
        err(`Error resuming conversation via Antigravity: ${(res.stderr || res.stdout || "").trim()}\n`);
        return 1;
      }
    } catch (e) {
      err(`Error resuming conversation via Antigravity: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  } else {
    // In the project for the task's folder, so the conversation's workspace is that folder. Over any
    // inherited ANTIGRAVITY_PROJECT_ID too (an older daemon passes the app's last-created project, a
    // daemon started from an Antigravity terminal its session's): the folder is what the task asked for.
    const project = await projectForFolder(process.cwd()).catch(() => undefined);
    if (project) process.env.ANTIGRAVITY_PROJECT_ID = project;
    // A new conversation, stepping down a tier when a model can't take it
    let lastErr = "";
    for (const cand of candidates) {
      try {
        const res = await runAgentapi(agentapi, "new-conversation", `--model=${cand}`, `--title=${title}`, prompt);
        if (res.code === 0) {
          const id = obj(obj(obj(JSON.parse(res.stdout)).response).newConversation).conversationId;
          if (id === undefined) throw new Error("no conversationId in the reply");
          convId = String(id);
          if (cand !== candidates[0]) err(`\n⚡ [提示: 模型 ${candidates[0]} 暂不可用，已自动智能降级至 ${cand} 成功建立会话]\n\n`);
          break;
        }
        lastErr = (res.stderr || res.stdout || "").trim();
        err(`\n⏳ [模型 ${cand} 启动遇到异常 (${head(lastErr, 80)})，自动尝试切换下一档位...]\n\n`);
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        err(`\n⏳ [模型 ${cand} 启动失败 (${lastErr})，自动尝试切换下一档位...]\n\n`);
      }
    }
    if (!convId) {
      err(`Error initiating conversation via Antigravity: ${lastErr}\n`);
      return 1;
    }
  }
  const cid = convId;
  err(`session id: ${cid}\n`);

  const state = { waiting: false, inFlight: [] as string[], toolStart: 0 };

  // Steps Antigravity holds for the user (ask_question, command and file approvals). Answers go back
  // through HandleCascadeUserInteraction, as the app sends them: an agentapi send-message only queues
  // behind the open question and arrives as a stray message once it's resolved some other way.
  const interactions = new Map<number, Interaction>();
  const openQuestions: { id: string; step: number; item: number }[] = [];
  const questionId = (step: number, item: number) => `agy_${cid.slice(0, 8)}_${step}_${item}`;
  const emit = (event: Obj) => out(`\n${JSON.stringify({ type: "memento_event", event })}\n`);

  // Each tool call is a row in the timeline. Its result is the next GENERIC step, in call order
  // (null holds the place of an ask_question, shown as a question instead); one started in the
  // background stays running until its task ends.
  const pendingTools: (string | null)[] = [];
  const backgroundTools = new Map<string, string>();
  const toolEnded = (id: string | null | undefined, status: "done" | "failed", output?: string) => {
    if (id) emit({ kind: "tool", id, status, ...(output ? { output } : {}) });
  };
  const closePending = () => {
    for (const id of pendingTools.splice(0)) toolEnded(id, "done");
  };
  const backgroundEnded = (tid: string, status: "done" | "failed") => {
    toolEnded(backgroundTools.get(tid), status);
    backgroundTools.delete(tid);
  };

  // The run's last step, when it's an error the language server gave up on: it doesn't always reach the
  // transcript. Out of quota ("Individual quota reached … Resets in 54h") the trajectory ends on that
  // ERROR_MESSAGE 1.5 s in while the transcript keeps only the question, so the run waited out its 2 hours.
  let trajectoryError = "";

  /** Shows each step Antigravity is waiting on as a question (once); false when the RPC isn't reachable. */
  const pollInteractions = async (): Promise<boolean> => {
    const traj = await lsRpc("GetCascadeTrajectory", { cascadeId: cid });
    if (traj === null) return false;
    const t = obj(traj.trajectory);
    const steps = list(t.steps);
    trajectoryError = finalTrajectoryError(steps);
    for (let idx = 0; idx < steps.length; idx++) {
      const step = obj(steps[idx]);
      if (step.status !== "CORTEX_STEP_STATUS_WAITING" || interactions.has(idx)) continue;
      const req = obj(step.requestedInteraction);
      let kind: string;
      let items: QuestionItem[];
      if ("askQuestion" in req || truthy(step.askQuestion)) {
        kind = "ask_question";
        items = list(obj(or(step.askQuestion, req.askQuestion)).questions).map((raw) => {
          const q = obj(raw);
          return {
            question: str(q.question) || "请选择或确认下一步操作",
            options: list(q.options).map((o) => str(obj(o).text)),
            multi: truthy(q.isMultiSelect),
          };
        });
      } else if ("runCommand" in req) {
        kind = "run_command";
        const rc = obj(step.runCommand);
        const cmd = str(rc.proposedCommandLine) || str(rc.commandLine);
        items = [{ question: `Antigravity 请求执行命令：${cmd}`, options: ["允许", "拒绝"], multi: false, command: cmd }];
      } else if ("filePermission" in req) {
        kind = "file_permission";
        const uri = str(obj(req.filePermission).absolutePathUri);
        items = [{ question: `Antigravity 请求访问：${uri}`, options: ["允许", "拒绝"], multi: false, uri }];
      } else {
        kind = Object.keys(req)[0] ?? "interaction";
        items = [{ question: `Antigravity 正在等待你在应用里处理（${kind}），memento 无法代为回复`, options: [], multi: false }];
      }
      if (!items.length) continue;
      interactions.set(idx, { kind, trajectoryId: t.trajectoryId ?? null, step, items, answers: new Map() });
      items.forEach((_, i) => openQuestions.push({ id: questionId(idx, i), step: idx, item: i }));
      items.forEach((it, i) =>
        emit({
          kind: "question",
          id: questionId(idx, i),
          tool: kind,
          question: it.question,
          options: it.options,
          is_multi_select: it.multi,
          status: "waiting",
        }),
      );
      state.waiting = true;
    }
    return true;
  };

  const submit = async (idx: number): Promise<boolean> => {
    const entry = interactions.get(idx)!;
    let interaction: Obj;
    if (entry.kind === "ask_question") {
      const qs = list(obj(or(entry.step.askQuestion, obj(entry.step.requestedInteraction).askQuestion)).questions).map(obj);
      const responses = qs.map((q, i) => {
        const ans = entry.answers.get(i) ?? "";
        const labels = truthy(q.isMultiSelect) ? ans.split(",").map((x) => x.trim()) : [ans.trim()];
        const ids = list(q.options)
          .map(obj)
          .filter((o) => labels.includes(str(o.text).trim()))
          .map((o) => o.id ?? null);
        return ids.length ? { ...q, selectedOptionIds: ids } : { ...q, writeInResponse: ans };
      });
      interaction = { askQuestion: { responses } };
    } else if (entry.kind === "run_command") {
      const cmd = entry.items[0]?.command ?? "";
      interaction = { runCommand: { confirm: YES.test(entry.answers.get(0) ?? ""), proposedCommandLine: cmd, submittedCommandLine: cmd } };
    } else if (entry.kind === "file_permission") {
      interaction = {
        filePermission: {
          allow: YES.test(entry.answers.get(0) ?? ""),
          scope: "PERMISSION_SCOPE_ONCE",
          absolutePathUri: entry.items[0]?.uri ?? "",
        },
      };
    } else {
      return true;
    }
    const body = { cascadeId: cid, interaction: { trajectoryId: entry.trajectoryId, stepIndex: idx, ...interaction } };
    return (await lsRpc("HandleCascadeUserInteraction", body)) !== null;
  };

  const onInput = async (line: string): Promise<void> => {
    const raw = line.trim();
    if (!raw) return;
    let qid: string | null = null;
    let ans = raw;
    if (raw.startsWith("{")) {
      try {
        const m: unknown = JSON.parse(raw);
        if (isObj(m) && m.type === "memento_answer") {
          qid = truthy(m.question_id) ? String(m.question_id) : null;
          ans = truthy(m.answer) ? String(m.answer) : "";
        }
      } catch {
        // plain text
      }
    }
    const at = openQuestions.findIndex((q) => qid === null || q.id === qid);
    if (at >= 0) {
      const [hit] = openQuestions.splice(at, 1);
      const entry = interactions.get(hit!.step)!;
      entry.answers.set(hit!.item, ans);
      if (entry.answers.size >= entry.items.length && !(await submit(hit!.step))) {
        err("\n⚠️ [回答没能提交给 Antigravity，请在 Antigravity 应用里回答]\n");
      }
      if (!openQuestions.length) state.waiting = false;
      return;
    }
    // Not an answer: a follow-up for the running conversation
    state.waiting = false;
    try {
      await runAgentapi(agentapi, "send-message", cid, ans);
    } catch (e) {
      err(`Error forwarding answer to Antigravity: ${e instanceof Error ? e.message : String(e)}\n`);
      emit({ kind: "steer", text: ans, status: "late" });
    }
  };
  // One line at a time, in order, as they come
  let inputs = Promise.resolve();
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
    inputs = inputs.then(() => onInput(line)).catch(() => {});
  });

  // Wait for the transcript
  const [fullLog, plainLog] = transcriptPaths(cid);
  const waitStart = Date.now();
  while (!existsSync(fullLog) && !existsSync(plainLog)) {
    if (Date.now() - waitStart > 20_000) {
      err("Timed out waiting for Antigravity response log.\n");
      return 1;
    }
    await sleep(100);
  }
  const reader = new TranscriptReader(existsSync(fullLog) ? fullLog : plainLog, startPos);

  const startTime = Date.now();
  let idle = 0;
  let completed = false;
  let lastError = "";
  const background = new Set<string>();
  const logSizes = new Map<string, number>();
  let lsDeadChecks = 0;
  const tasksDir = join(agyHome(), "brain", cid, ".system_generated", "tasks");
  const short = (t: string) => t.split("/").pop()!;
  const backgroundNames = () => [...background].map(short).join(", ");

  try {
    for (;;) {
      if (args.timeout > 0 && Date.now() - startTime > args.timeout * 1000) {
        if (background.size) {
          err(`\n[STATUS_STILL_RUNNING: tasks=${backgroundNames()}]\n`);
          err(`\n⏳ [任务在后台持续执行中（${backgroundNames()}），达到单次等待上限（${args.timeout}s），保持后台运行]\n`);
          completed = true;
          break;
        }
        err(`\n[Agent timeout: 任务执行已达到安全上限（${args.timeout}s）]\n`);
        return 124;
      }

      const next = reader.next();
      if (next === undefined) {
        await sleep(200);
        idle++;

        // A question not shown yet, or quiet for 10 s (possibly an approval Antigravity waits on)
        if ((state.waiting && !openQuestions.length && idle % 5 === 0) || (idle >= 50 && idle % 50 === 0)) await pollInteractions();

        // With background tasks, their logs tell whether they are still active or their timer fired / was cancelled
        if (background.size && existsSync(tasksDir)) {
          let grew = false;
          for (const t of [...background]) {
            const tc = short(t);
            const logPath = join(tasksDir, `${tc}.log`);
            try {
              if (!existsSync(logPath)) continue;
              const size = statSync(logPath).size;
              if (size > (logSizes.get(tc) ?? -1)) {
                logSizes.set(tc, size);
                grew = true;
              }
              if (size > 0 && timerEnded(logPath, size)) {
                background.delete(t);
                backgroundEnded(t, "done");
                err(`\n✅ [后台任务 ${tc} 执行完毕/已结束]\n\n`);
                idle = 0;
              }
            } catch {
              // log unreadable this time
            }
          }
          // A log still being written means the task is alive
          if (grew) idle = 0;
        }

        // A heartbeat every 25 s, on stderr so the reply stays clean
        if (idle > 0 && idle % 125 === 0) {
          if (state.waiting) err("\n\n⏳ [等待用户选择或回复中...]\n\n");
          else if (state.inFlight.length) {
            const elapsed = state.toolStart ? Math.trunc((Date.now() - state.toolStart) / 1000) : Math.trunc(idle * 0.2);
            err(`\n\n⏳ [工具 ${state.inFlight.join(", ")} 持续执行中（已运行 ${elapsed}s），请稍候...]\n\n`);
          } else if (background.size) err(`\n\n⏳ [后台任务 ${backgroundNames()} 执行中，请稍候...]\n\n`);
          else err(`\n\n${thinkingHeartbeat(Math.trunc(idle * 0.2), await lsRunningCommands())}\n\n`);
        }

        // Quiet for over 20 s: every 10 s, check the language server is still there
        if (idle > 100 && idle % 50 === 0) {
          if (!(await isLanguageServerAlive())) {
            // 3 in a row (30 s) without an answer: it's gone
            if (++lsDeadChecks >= 3) {
              err("\n[Agent error: Antigravity 语言服务器已断开连接]\n");
              return 1;
            }
          } else {
            lsDeadChecks = 0;
          }
        }

        // 5 s quiet after an error that isn't a retry
        if (lastError && idle > 25) {
          err(`\nAntigravity Error: ${lastError}\n`);
          return 1;
        }
        // The trajectory ended on an error the transcript never got (checked at the next poll)
        if (trajectoryError && idle > 25 && !state.waiting) {
          err(`\nAntigravity Error: ${trajectoryError}\n`);
          return 1;
        }

        // 1. Waiting for the user: no idle limit (the task timeout still applies)
        if (state.waiting) continue;

        // 2. A tool call in flight: up to 3600 s (or the task timeout) for one call
        if (state.inFlight.length) {
          const toolTimeout = args.timeout > 0 ? Math.min(3600, args.timeout) : 3600;
          if (state.toolStart && Date.now() - state.toolStart > toolTimeout * 1000) {
            err(`\n[Tool timeout: 工具 ${state.inFlight.join(", ")} 执行超时（超过 ${toolTimeout}s）]\n`);
            return 124;
          }
          continue;
        }

        // 3. Background tasks: after 180 s quiet, hand them over to background monitoring
        if (background.size) {
          if (idle > 900) {
            err(`\n[STATUS_STILL_RUNNING: tasks=${backgroundNames()}]\n`);
            err(`\n⏳ [后台任务（${backgroundNames()}）持续运行中，达到单次轮询等待上限（180s），已安全转入后台监控]\n`);
            completed = true;
            break;
          }
          continue;
        }

        // 4. The model generating with nothing new in the log: no idle limit. On 503s and other capacity
        //    problems Antigravity retries quietly, one step can take over ten minutes (a capacity outage
        //    once lasted 40), and it doesn't give up by itself; ending here would only have memento report
        //    a failure while Antigravity finishes the work anyway. A lost language server (checked above)
        //    and the task timeout still end it.
        continue;
      }

      idle = 0;
      const line = next.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(parsed)) continue;
      const data = parsed;

      const source = data.source;
      const stepType = data.type;
      const content = str(data.content);
      const toolCalls = list(data.tool_calls).map(obj);

      // task-<n> IDs only from a real async tool start (type GENERIC, status RUNNING), never from code or
      // logs a view_file or grep shows
      let startedTask = "";
      if (stepType === "GENERIC" && data.status === "RUNNING" && content.startsWith("Created At:")) {
        const m =
          /(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*((?:[0-9a-fA-F-]+\/)?task-\d+)/i.exec(
            content,
          );
        if (m) {
          const tid = m[1]!.trim();
          startedTask = tid;
          background.add(tid);
          err(`\n⏳ [后台任务启动: ${short(tid)}，持续追踪执行进度...]\n\n`);
          idle = 0;
        }
      }

      // Did a background task finish, fail or get cancelled?
      const isFileView = content.includes("File Path: `") || content.includes("The following changes were made by the ");
      for (const tid of [...background]) {
        const tc = short(tid);
        const matched = !isFileView && (content.includes(tc) || content.includes(tid));
        const senderMatched = stepType === "SYSTEM_MESSAGE" && (content.includes(`sender=${tid}`) || content.includes(`sender=${tc}`));
        const cancelled =
          matched &&
          [
            "was canceled", "was cancelled", "Tool execution was canceled",
            "Tool execution was cancelled", "Status: CANCELLED", "Status: CANCELED",
            "Status: ERROR", "Status: FAILED", "failed with result",
            `Task "${tid}" cancelled`, `Task "${tc}" cancelled`,
          ].some((kw) => content.includes(kw));
        const finished =
          !cancelled &&
          (senderMatched ||
            (matched && ["finished with result", "The command exited with code", "Timer fired", "Status: DONE"].some((kw) => content.includes(kw))));
        if (finished || cancelled) {
          background.delete(tid);
          backgroundEnded(tid, cancelled ? "failed" : "done");
          err(`\n${cancelled ? "⏹️" : "✅"} [后台任务 ${tc} ${cancelled ? "已取消/终止" : "执行完毕，已接收运行结果"}]\n\n`);
          idle = 0;
        } else if (existsSync(tasksDir)) {
          const logPath = join(tasksDir, `${tc}.log`);
          try {
            const size = existsSync(logPath) ? statSync(logPath).size : 0;
            if (size > 0 && timerEnded(logPath, size)) {
              background.delete(tid);
              backgroundEnded(tid, "done");
              err(`\n✅ [后台任务 ${tc} 执行完毕/已结束]\n\n`);
              idle = 0;
            }
          } catch {
            // log unreadable this time
          }
        }
      }

      // A tool, system or user result: one call fewer in flight
      if (stepType === "GENERIC" || stepType === "SYSTEM_MESSAGE") {
        state.inFlight.shift();
        if (!state.inFlight.length) state.toolStart = 0;
      }
      if (stepType === "GENERIC" && pendingTools.length) {
        const id = pendingTools.shift();
        if (id) {
          const output = agyToolOutput(content);
          if (startedTask) {
            backgroundTools.set(startedTask, id);
            emit({ kind: "tool", id, status: "running", ...(output ? { output } : {}) });
          } else {
            toolEnded(id, data.status === "ERROR" || data.status === "INVALID" ? "failed" : "done", output);
          }
        }
      }
      if (stepType === "USER_INPUT") {
        state.waiting = false;
        state.inFlight = [];
        state.toolStart = 0;
        closePending();
      }

      // Not the model's own steps, or a tool's output
      if (stepType === "USER_INPUT" || stepType === "CHECKPOINT" || stepType === "GENERIC" || stepType === "SYSTEM_MESSAGE") continue;

      if (stepType === "ERROR_MESSAGE") {
        state.inFlight = [];
        state.toolStart = 0;
        const errMsg = str(or(data.error, data.message, data.content));
        const attempt = /attempt\s+(\d+)/i.exec(errMsg);
        if (attempt || isTransientError(errMsg)) {
          const nth = attempt ? `（第 ${attempt[1]} 次重试）` : "";
          err(`\n⏳ [远端模型服务容量紧张/排队中，Antigravity 正在自动退避重试${nth}，请稍候...]\n\n`);
          // The language server retrying means it's still at work
          idle = 0;
          continue;
        }
        lastError = errMsg;
        continue;
      }

      if (source === "MODEL" && stepType === "PLANNER_RESPONSE") {
        lastError = "";
        state.inFlight = [];
        state.toolStart = 0;
        // Calls whose results never came (the model moved on): over
        closePending();

        if (toolCalls.length) {
          const names = toolCalls.map((tc) => str(tc.name) || "tool");
          let rpcOk = false;
          if (toolCalls.some((tc) => tc.name === "ask_question")) {
            state.waiting = true;
            state.inFlight = [];
            state.toolStart = 0;
            rpcOk = await pollInteractions();
          } else {
            state.inFlight = names;
            state.toolStart = Date.now();
          }

          for (const [i, tc] of toolCalls.entries()) {
            const tcName = str(tc.name) || "tool";
            let tcArgs: Obj = obj(tc.args);
            if (typeof tc.args === "string") {
              try {
                tcArgs = obj(JSON.parse(tc.args));
              } catch {
                tcArgs = {};
              }
            }
            if (tcName === "manage_task" && ["kill", "stop", "cancel"].includes(str(tcArgs.Action))) {
              const target = truthy(tcArgs.TaskId) ? String(tcArgs.TaskId) : "";
              for (const tid of [...background]) {
                if (target && (tid.includes(target) || target.includes(tid) || short(target) === short(tid))) {
                  background.delete(tid);
                  backgroundEnded(tid, "done");
                  err(`\n⏹️ [后台任务 ${short(tid)} 已由 Agent 主动终止]\n\n`);
                  idle = 0;
                }
              }
            }

            if (tcName === "ask_question" && !rpcOk) {
              // No RPC (older Antigravity): shown from the transcript, and the answer goes as a message
              const qArgs = tcArgs.questions;
              const q = Array.isArray(qArgs) && qArgs.length ? obj(qArgs[0]) : tcArgs;
              emit({
                kind: "question",
                id: truthy(tc.id) ? tc.id : `agy_q_${Date.now()}`,
                tool: "ask_question",
                question: str(q.question) || "请选择或确认下一步操作",
                options: or(q.options) ?? [],
                is_multi_select: truthy(q.is_multi_select),
                status: "waiting",
              });
            }

            if (tcName === "ask_question") {
              pendingTools.push(null);
              continue;
            }
            const id = `agy_${String(data.step_index ?? Date.now())}_${i}`;
            pendingTools.push(id);
            emit({ kind: "tool", id, name: tcName, detail: agyToolDetail(tcName, tcArgs), status: "running" });
          }
        }

        if (content.trim()) {
          out(`${content.trim()}\n\n`);
          if (!toolCalls.length) {
            if (!background.size && !state.waiting) {
              // The final reply with nothing left running: the turn is done
              completed = true;
              break;
            } else if (background.size) {
              // Background tasks still running: keep showing what the model says meanwhile, don't end early
              err(`\n⏳ [后台任务 ${backgroundNames()} 持续执行中，持续追踪进度...]\n\n`);
              idle = 0;
            }
          }
        }
      }
    }
  } finally {
    reader.close();
    // Every row ends with the run, except the background ones it leaves running
    closePending();
  }
  return completed ? 0 : 124;
}

/** Writes what's pending on stdout and stderr, then exits. */
export async function exit(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((r) => s.write("", () => r()))));
  process.exit(code);
}
