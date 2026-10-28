import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";
import { findExecutable, findPython } from "./exec-env.js";

export interface AntigravitySessionInfo {
  title?: string;
  workspacePath?: string;
  projectName?: string;
}

let summariesCache: { map: Map<string, AntigravitySessionInfo>; at: number } | undefined;

function loadSummariesMap(home = homeDir()): Map<string, AntigravitySessionInfo> {
  const dbPath = join(home, ".gemini", "antigravity", "conversation_summaries.db");
  const map = new Map<string, AntigravitySessionInfo>();
  if (!existsSync(dbPath)) return map;

  const now = Date.now();
  if (summariesCache && now - summariesCache.at < 15_000) {
    return summariesCache.map;
  }

  try {
    let output = "";
    try {
      const sqliteBin = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
      output = execFileSync(
        sqliteBin,
        [dbPath, "SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE status != 'deleted';"],
        { encoding: "utf8", timeout: 3000, windowsHide: true }
      );
    } catch {
      const pyBin = process.platform === "win32" ? "python" : "python3";
      const script = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); [print(f\"{r[0]}|{r[1]}|{r[2]}\") for r in conn.execute(\"SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE status != 'deleted'\")]";
      output = execFileSync(pyBin, ["-c", script, dbPath], { encoding: "utf8", timeout: 3000, windowsHide: true });
    }

    for (const line of output.split("\n")) {
      const parts = line.split("|");
      if (parts.length < 3) continue;
      const cid = parts[0]?.trim();
      const title = parts[1]?.trim();
      const wsUrisRaw = parts.slice(2).join("|").trim();
      if (!cid) continue;

      let wsPath: string | undefined;
      let pName: string | undefined;
      if (wsUrisRaw) {
        const m = /"file:\/\/\/([^"]+)"|"file:\/\/([^"]+)"/.exec(wsUrisRaw);
        if (m) {
          const rawUri = m[1] || m[2];
          if (!rawUri) continue;
          let cleaned = decodeURIComponent(rawUri);
          if (process.platform === "win32") {
            if (/^\/[a-zA-Z]:/.test(cleaned)) cleaned = cleaned.slice(1);
          } else {
            if (!cleaned.startsWith("/")) cleaned = "/" + cleaned;
          }
          wsPath = cleaned.replace(/\\/g, "/").replace(/\/+$/, "");
          const leaf = wsPath.split("/").pop();
          if (leaf && !["", "-", "--", "tmp", "temp", "dev", "desktop"].includes(leaf.toLowerCase())) {
            pName = leaf;
          }
        }
      }

      map.set(cid, {
        title: title || undefined,
        workspacePath: wsPath,
        projectName: pName,
      });
    }
    summariesCache = { map, at: now };
  } catch {
    if (summariesCache) return summariesCache.map;
  }
  return map;
}

export function getAntigravitySessionInfo(sessionId: string, home = homeDir()): AntigravitySessionInfo | undefined {
  return loadSummariesMap(home).get(sessionId);
}

export function getAntigravityWorkspaces(home = homeDir()): string[] {
  const map = loadSummariesMap(home);
  const seen = new Set<string>();
  for (const s of map.values()) {
    if (s.workspacePath) seen.add(s.workspacePath);
  }
  return Array.from(seen);
}

const JUNK_TITLE_SET = new Set([
  "",
  "start",
  "starting conversation",
  "starting the conversation",
  "starting the conversation...",
  "untitled",
  "unknown",
  "transcript",
  "transcript.jsonl",
  "conversation",
  "新对话",
  "新会话",
  "新建对话",
]);

const JUNK_PREFIXES = [
  "starting the conversation",
  "starting conversation",
  "new conversation",
  "agent-",
  "subagent-",
  "workflow-",
  "wf_",
  "wf-",
  "prompt-",
  "run-",
  "rollout-",
  "this session is being continued from a previous conversation",
  "the following is the codex agent history",
  "<recommended_plugins>",
  "<environment_context>",
  "<turn_aborted>",
  "[request interrupted",
  "[interrupted",
  "request interrupted",
  "turn aborted",
  "<ide_opened_file>",
  "<user_request>",
];

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isJunkAntigravityTitle(title?: string | null, sessionId?: string): boolean {
  if (!title) return true;
  const t = title.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (JUNK_TITLE_SET.has(lower)) return true;
  for (const p of JUNK_PREFIXES) {
    if (lower.startsWith(p)) return true;
  }
  if (t.startsWith("{") || t.startsWith("[{") || t.startsWith('{"')) return true;
  if (/^\\[dswDSWbB]/.test(t) || t.includes("(.*?)") || t.startsWith("<") || t.startsWith("re.search")) return true;
  if (t.endsWith(".jsonl") || t.endsWith(".json") || t.endsWith(".pbtxt") || t.endsWith(".sqlite") || t.endsWith(".md")) return true;
  if (UUID_RE.test(t)) return true;
  if (sessionId && (t === sessionId || t === sessionId.slice(0, 8))) return true;
  return false;
}

export function extractUserTitleFromText(text: string): string | undefined {
  if (!text) return undefined;
  let cleaned = text;
  cleaned = cleaned.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  cleaned = cleaned.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
  cleaned = cleaned.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "");
  cleaned = cleaned.replace(/<system>[\s\S]*?<\/system>/gi, "");
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(cleaned);
  if (reqMatch?.[1]) {
    cleaned = reqMatch[1];
  }
  cleaned = cleaned.replace(/\\n/g, "\n").replace(/\\r/g, "").trim();
  const firstLine = cleaned.split("\n")[0]?.trim();
  if (!firstLine) return undefined;
  const cand = firstLine.slice(0, 60).trim();
  if (!cand || isJunkAntigravityTitle(cand)) return undefined;
  return cand;
}

function extractTitleFromLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const step = JSON.parse(line) as {
      source?: string;
      type?: string;
      content?: unknown;
    };
    if (step && typeof step.content === "string") {
      if (step.type === "USER_INPUT" || step.source === "USER_EXPLICIT") {
        const cand = extractUserTitleFromText(step.content);
        if (cand) return cand;
      }
    }
  } catch {
    const cand = extractUserTitleFromText(line);
    if (cand) return cand;
  }
  return undefined;
}

function extractTitleFromFileStream(filePath: string, maxLines = 50): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    let remainder = "";
    let linesChecked = 0;

    while (linesChecked < maxLines) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = remainder + buffer.toString("utf8", 0, bytesRead);
      const parts = chunk.split("\n");
      remainder = parts.pop() ?? "";

      for (const line of parts) {
        if (!line.trim()) continue;
        linesChecked++;
        const cand = extractTitleFromLine(line);
        if (cand) return cand;
        if (linesChecked >= maxLines) break;
      }
    }

    if (remainder.trim() && linesChecked < maxLines) {
      const cand = extractTitleFromLine(remainder);
      if (cand) return cand;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
  return undefined;
}

export function extractTitleFromTranscript(linesOrFilePath: string[] | string): string | undefined {
  if (typeof linesOrFilePath === "string") {
    if (!existsSync(linesOrFilePath)) return undefined;
    return extractTitleFromFileStream(linesOrFilePath);
  }

  if (Array.isArray(linesOrFilePath)) {
    for (const line of linesOrFilePath.slice(0, 50)) {
      const cand = extractTitleFromLine(line);
      if (cand) return cand;
    }
  }
  return undefined;
}

export function updateAntigravitySessionTitle(sessionId: string, newTitle: string, home = homeDir()): boolean {
  if (!sessionId || !newTitle || isJunkAntigravityTitle(newTitle, sessionId)) return false;
  const trimmedTitle = newTitle.trim().slice(0, 100);
  let updatedDb = false;

  const dbPath = join(home, ".gemini", "antigravity", "conversation_summaries.db");
  if (existsSync(dbPath)) {
    try {
      const pyBin = process.platform === "win32" ? "python" : "python3";
      const script = "import sqlite3, sys; conn = sqlite3.connect(sys.argv[1]); conn.execute('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?;', (sys.argv[2], sys.argv[3])); conn.commit(); conn.close()";
      execFileSync(pyBin, ["-c", script, dbPath, trimmedTitle, sessionId], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      });
      updatedDb = true;
    } catch {
      try {
        const sqliteBin = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
        const escapedTitle = trimmedTitle.replace(/'/g, "''");
        const escapedCid = sessionId.replace(/'/g, "''");
        execFileSync(
          sqliteBin,
          [dbPath, `UPDATE conversation_summaries SET title = '${escapedTitle}' WHERE conversation_id = '${escapedCid}';`],
          { encoding: "utf8", timeout: 5000, windowsHide: true }
        );
        updatedDb = true;
      } catch {
        // ignore db update error
      }
    }
  }

  summariesCache = undefined;

  try {
    const annDir = join(home, ".gemini", "antigravity", "annotations");
    if (!existsSync(annDir)) {
      mkdirSync(annDir, { recursive: true });
    }
    const annPath = join(annDir, `${sessionId}.pbtxt`);
    const escapedForPbtxt = trimmedTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    writeFileSync(annPath, `title:"${escapedForPbtxt}"\n`, "utf8");
  } catch {
    // ignore annotation write failure
  }

  return updatedDb;
}

export function healAntigravitySession(
  sessionId: string,
  linesOrFilePath: string[] | string,
  currentTitle?: string,
  home = homeDir()
): string | undefined {
  if (currentTitle && !isJunkAntigravityTitle(currentTitle, sessionId)) {
    return currentTitle;
  }

  let cand = extractTitleFromTranscript(linesOrFilePath);
  if (!cand && Array.isArray(linesOrFilePath)) {
    const transcriptFile = join(home, ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(transcriptFile)) {
      cand = extractTitleFromTranscript(transcriptFile);
    }
  }

  if (cand) {
    updateAntigravitySessionTitle(sessionId, cand, home);
    return cand;
  }

  return undefined;
}

export async function healAllAntigravitySessions(home = homeDir()): Promise<number> {
  const map = loadSummariesMap(home);
  let count = 0;
  for (const [cid, info] of map.entries()) {
    if (!info.title || isJunkAntigravityTitle(info.title, cid)) {
      const transcriptFile = join(home, ".gemini", "antigravity", "brain", cid, ".system_generated", "logs", "transcript.jsonl");
      if (existsSync(transcriptFile)) {
        const healed = healAntigravitySession(cid, transcriptFile, undefined, home);
        if (healed) count++;
      }
    }
  }
  return count;
}


/**
 * Antigravity tasks go through a small Python runner (assets/agy_cli.py) that
 * talks to the running app's language server, so they work in the app's own
 * conversations (~/.gemini/antigravity), the ones memento collects and resumes.
 * Google's agy CLI keeps its conversations apart (~/.gemini/antigravity-cli)
 * and can't resume the app's, so it is only the fallback.
 */
/** Where the runner ships: next to the daemon's code, or MEMENTO_AGY_RUNNER (bundled apps). */
const runnerAsset = () => process.env.MEMENTO_AGY_RUNNER || fileURLToPath(new URL("../assets/agy_cli.py", import.meta.url));
function run(cmd: string, args: string[], timeout = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

/**
 * Installs ~/.gemini/antigravity/bin/agy_cli.py (rewritten whenever it differs
 * from the shipped one) and an `agy` wrapper on PATH; the script's path, or
 * undefined when it couldn't be written.
 */
export async function ensureAgyCliInstalled(home = homeDir()): Promise<string | undefined> {
  const dir = join(home, ".gemini", "antigravity", "bin");
  const script = join(dir, "agy_cli.py");
  try {
    await mkdir(dir, { recursive: true });
    const target = await readFile(runnerAsset(), "utf8");
    if ((await readFile(script, "utf8").catch(() => "")) !== target) {
      // Whole file or nothing: a task starting meanwhile must not run half a script.
      await writeFile(`${script}.tmp`, target);
      if (process.platform !== "win32") await chmod(`${script}.tmp`, 0o755);
      await rename(`${script}.tmp`, script);
    }
  } catch {
    if (!existsSync(script)) return undefined;
  }
  try {
    if (process.platform === "win32") {
      const winBin = join(home, "AppData", "Local", "agy", "bin");
      await mkdir(winBin, { recursive: true });
      const cmd = join(winBin, "agy.cmd");
      if (!existsSync(cmd)) await writeFile(cmd, `@echo off\r\npython "${script}" %*\r\n`);
    } else {
      const localBin = join(home, ".local", "bin");
      await mkdir(localBin, { recursive: true });
      const wrapper = join(localBin, "agy");
      if (!existsSync(wrapper)) {
        await writeFile(wrapper, `#!/bin/sh\nexec python3 "${script}" "$@"\n`);
        await chmod(wrapper, 0o755);
      }
    }
  } catch {
    // only for running `agy` by hand; tasks run the script itself
  }
  return script;
}

/**
 * What runs an Antigravity task: the runner itself, not the first `agy` on
 * PATH, since Google's agy CLI installs to the same folders (on Windows its
 * agy.exe sits beside our agy.cmd and wins). Google's CLI or agentapi only
 * when the runner can't run (not written, or no Python).
 */
export async function antigravityExecutable(home = homeDir()): Promise<string | undefined> {
  const script = await ensureAgyCliInstalled(home);
  if (script && (await findPython())) return script;
  return findExecutable(["agy", "agentapi"]);
}

let cached: { env: Record<string, string>; at: number } | undefined;

/** The running Antigravity app's language server, as `agentapi` and the quota probe reach it. */
export interface AntigravityLanguageServer {
  /** Plain-HTTP port serving the app page and the Connect RPC API on 127.0.0.1. */
  port: number;
  csrf?: string;
  /** The language_server executable, when the OS reports it. */
  binary?: string;
}

interface LanguageServerProcess {
  pid?: string;
  csrf?: string;
  binary?: string;
  ports: number[];
}

function findLanguageServer(lines: string[]): { pid?: string; csrf?: string } {
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("language_server") && lower.includes("antigravity") && !lower.includes("grep")) {
      return { pid: /^\s*(\d+)/.exec(line)?.[1], csrf: /--csrf_token\s+(\S+)/.exec(line)?.[1] };
    }
  }
  return {};
}

/**
 * Prints the language server process `$p`, when there is one, and the ports it
 * listens on as JSON. Non-ASCII characters go out as \uXXXX, so a user folder in
 * Chinese survives whatever code page the hidden console has (setting
 * [Console]::OutputEncoding fails without a console). Ports are joined into a
 * string: Windows PowerShell 5.1 can serialize a one-element array as
 * {"value":[...],"Count":1}.
 */
export const WINDOWS_LS_REPORT =
  "if ($p) { $ports = ''; try { $ports = (Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction Stop | ForEach-Object { $_.LocalPort } | Sort-Object -Unique) -join ',' } catch {}; " +
  "$j = [pscustomobject]@{ ProcessId = $p.ProcessId; ExecutablePath = $p.ExecutablePath; CommandLine = $p.CommandLine; Ports = $ports } | ConvertTo-Json -Compress; " +
  "[regex]::Replace($j, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }) }";

/** One PowerShell call for the language server process and its listening ports. */
const WINDOWS_LS_QUERY =
  "$p = Get-CimInstance Win32_Process -Filter \"Name LIKE '%language_server%'\" | Where-Object { $_.CommandLine -match 'antigravity' } | Select-Object -First 1; " +
  WINDOWS_LS_REPORT;

/** Parses WINDOWS_LS_QUERY's output. */
export function parseWindowsLanguageServer(stdout: string): LanguageServerProcess {
  try {
    const item = JSON.parse(stdout.trim()) as { ProcessId?: unknown; ExecutablePath?: unknown; CommandLine?: unknown; Ports?: unknown };
    if (item?.ProcessId == null) return { ports: [] };
    const ports = String(item.Ports ?? "")
      .split(",")
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0);
    return {
      pid: String(item.ProcessId),
      csrf: /--csrf_token\s+(\S+)/.exec(String(item.CommandLine ?? ""))?.[1],
      binary: typeof item.ExecutablePath === "string" && item.ExecutablePath ? item.ExecutablePath : undefined,
      ports: [...new Set(ports)],
    };
  } catch {
    return { ports: [] };
  }
}

/**
 * Listening TCP ports of `pid` from `netstat -ano -p TCP`. Matches the PID column
 * exactly (findstr would also match the PID inside other ports and PIDs) and
 * tells listening rows by their 0-port foreign address, since the state column
 * is localized on some Windows languages.
 */
export function parseNetstatListeningPorts(stdout: string, pid: string): number[] {
  const ports: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0]?.toUpperCase() !== "TCP" || cols[cols.length - 1] !== pid) continue;
    if (!/:0$/.test(cols[2] ?? "")) continue;
    const port = Number(/:(\d+)$/.exec(cols[1] ?? "")?.[1]);
    if (port > 0 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

async function languageServerProcess(launch: boolean): Promise<LanguageServerProcess> {
  if (process.platform === "win32") {
    const ls = parseWindowsLanguageServer((await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LS_QUERY], 15_000)).stdout);
    if (ls.pid && !ls.ports.length) ls.ports = parseNetstatListeningPorts((await run("netstat", ["-ano", "-p", "TCP"], 10_000)).stdout, ls.pid);
    return ls;
  }
  const list = async () => (await run("ps", ["-eo", "pid,command"])).stdout.split("\n");
  let { pid, csrf } = findLanguageServer(await list());
  if (!pid && launch && process.platform === "darwin" && existsSync("/Applications/Antigravity.app")) {
    await run("open", ["-a", "Antigravity"]);
    await new Promise((r) => setTimeout(r, 3000));
    ({ pid, csrf } = findLanguageServer(await list()));
  }
  const ports: number[] = [];
  if (pid) {
    const lsof = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid]);
    for (const line of lsof.stdout.split("\n")) {
      const m = /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(line);
      if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
    }
  }
  return { pid, csrf, ports };
}

/** The first port answering with the Antigravity app page; its CSRF token is the one that port checks. */
async function probePorts(ports: number[], csrf: string | undefined): Promise<{ port?: number; csrf?: string }> {
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "User-Agent": "Antigravity-Probe" },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status !== 200) continue;
      const body = await res.text();
      if (body.toLowerCase().includes("antigravity") || body.includes("csrfToken")) {
        return { port, csrf: /"csrfToken":"([^"]+)"/.exec(body)?.[1] || csrf };
      }
    } catch {
      // not this one
    }
  }
  return {};
}

let located: AntigravityLanguageServer | undefined;

/**
 * Where the running Antigravity app's language server listens, on every OS;
 * undefined when it isn't running. The last answer is reused while its port
 * still serves the app page, so a repeat lookup is one local HTTP request
 * rather than a process listing (a PowerShell start on Windows). With `launch`,
 * a closed app is started on macOS.
 */
export async function findAntigravityLanguageServer(
  options: { launch?: boolean; forceRefresh?: boolean } = {},
): Promise<AntigravityLanguageServer | undefined> {
  if (located && !options.forceRefresh) {
    const again = await probePorts([located.port], located.csrf);
    if (again.port !== undefined) return (located = { ...located, csrf: again.csrf });
  }
  located = undefined;
  const ls = await languageServerProcess(options.launch ?? false);
  if (!ls.pid) return undefined;
  const found = await probePorts(ls.ports, ls.csrf);
  if (found.port === undefined) return undefined;
  located = { port: found.port, csrf: found.csrf, binary: ls.binary };
  return located;
}

async function lastProjectId(files: string[]): Promise<string | undefined> {
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(f, "utf8")) as { lastCreatedProjectId?: unknown };
      if (data.lastCreatedProjectId != null) return String(data.lastCreatedProjectId);
    } catch {
      // absent or unreadable
    }
  }
  return undefined;
}

/**
 * Where the running Antigravity app's language server listens, with its CSRF
 * token and last project; null when Antigravity isn't running. On macOS the app
 * is started when it's installed but closed.
 */
export async function discoverAntigravityEnv(forceRefresh = false): Promise<Record<string, string> | null> {
  if (!forceRefresh && cached && Date.now() - cached.at < 30_000) return cached.env;
  cached = undefined;
  const home = homeDir();
  try {
    const ls = await findAntigravityLanguageServer({ launch: true, forceRefresh });
    if (!ls) return null;
    const projectFiles =
      process.platform === "win32"
        ? [join(process.env.APPDATA ?? "", "Antigravity", "app_storage.json")]
        : [
            join(home, "Library", "Application Support", "Antigravity", "app_storage.json"),
            join(home, ".config", "Antigravity", "app_storage.json"),
          ];
    const env: Record<string, string> = { ANTIGRAVITY_LS_ADDRESS: `localhost:${ls.port}` };
    if (ls.csrf) env.ANTIGRAVITY_CSRF_TOKEN = ls.csrf;
    // The runner's agentapi, for an app installed somewhere other than the default folder
    if (ls.binary) env.ANTIGRAVITY_LS_BINARY = ls.binary;
    const project = await lastProjectId(projectFiles);
    if (project) env.ANTIGRAVITY_PROJECT_ID = project;
    cached = { env, at: Date.now() };
    return env;
  } catch {
    return null;
  }
}
