import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";

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
 * Antigravity has no headless CLI of its own; tasks go through a small Python
 * runner (assets/agy_cli.py) that talks to the running app's language server.
 */
/** Where the runner ships: next to the daemon's code, or MEMENTO_AGY_RUNNER (bundled apps). */
const runnerAsset = () => process.env.MEMENTO_AGY_RUNNER || fileURLToPath(new URL("../assets/agy_cli.py", import.meta.url));
/** A runner older than these features gets rewritten. */
const RUNNER_MARKERS = [
  "_auto_discover_antigravity_ls",
  "_is_antigravity_ls_alive",
  "in_flight_tools",
  "gemini-3.8-flash",
  "--timeout",
  "ANTIGRAVITY_SOURCE_METADATA",
  "last_error_message",
  "active_background_tasks",
  "STATUS_STILL_RUNNING",
  "is_waiting_transition",
  "is_canceled",
  "task_log_sizes",
  "ask_question_interactive",
  "stream was interrupted",
  'if __name__ == "__main__":',
];

function run(cmd: string, args: string[], timeout = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

/** Installs ~/.gemini/antigravity/bin/agy_cli.py and an `agy` wrapper on PATH. */
export async function ensureAgyCliInstalled(home = homeDir()): Promise<void> {
  try {
    const dir = join(home, ".gemini", "antigravity", "bin");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "agy_cli.py");
    const current = await readFile(script, "utf8").catch(() => "");
    if (!RUNNER_MARKERS.every((m) => current.includes(m))) {
      await writeFile(script, await readFile(runnerAsset(), "utf8"));
      if (process.platform !== "win32") await chmod(script, 0o755);
    }
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
    // Antigravity tasks will report the missing runner.
  }
}

let cached: { env: Record<string, string>; at: number } | undefined;

function findLanguageServer(lines: string[]): { pid?: string; csrf?: string } {
  for (const line of lines) {
    if (line.includes("language_server") && line.includes("antigravity") && !line.includes("grep")) {
      return { pid: /^\s*(\d+)/.exec(line)?.[1], csrf: /--csrf_token\s+(\S+)/.exec(line)?.[1] };
    }
  }
  return {};
}

async function probePorts(ports: number[], csrf: string | undefined): Promise<{ port?: number; csrf?: string }> {
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "User-Agent": "Antigravity-Probe" },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status !== 200) continue;
      const body = await res.text();
      if (body.includes("antigravity") || body.includes("csrfToken")) {
        return { port, csrf: csrf || /"csrfToken":"([^"]+)"/.exec(body)?.[1] };
      }
    } catch {
      // not this one
    }
  }
  return {};
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
    let pid: string | undefined;
    let csrf: string | undefined;
    const ports: number[] = [];
    let projectFiles: string[];

    if (process.platform === "win32") {
      const ps = await run("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name LIKE '%language_server%'\" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json",
      ]);
      try {
        const decoded = JSON.parse(ps.stdout.trim()) as unknown;
        for (const item of (Array.isArray(decoded) ? decoded : [decoded]) as { ProcessId?: unknown; CommandLine?: unknown }[]) {
          const cmd = String(item?.CommandLine ?? "");
          if (cmd.includes("antigravity")) {
            pid = String(item.ProcessId);
            csrf = /--csrf_token\s+(\S+)/.exec(cmd)?.[1];
            break;
          }
        }
      } catch {
        // no process list
      }
      if (!pid) return null;
      const net = await run("cmd", ["/c", `netstat -ano | findstr ${pid}`]);
      for (const line of net.stdout.split("\n")) {
        const m = line.includes("LISTENING") ? /127\.0\.0\.1:(\d+)/.exec(line) : null;
        if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
      }
      projectFiles = [join(process.env.APPDATA ?? "", "Antigravity", "app_storage.json")];
    } else {
      const list = async () => (await run("ps", ["-eo", "pid,command"])).stdout.split("\n");
      ({ pid, csrf } = findLanguageServer(await list()));
      if (!pid && process.platform === "darwin" && existsSync("/Applications/Antigravity.app")) {
        await run("open", ["-a", "Antigravity"]);
        await new Promise((r) => setTimeout(r, 3000));
        ({ pid, csrf } = findLanguageServer(await list()));
      }
      if (!pid) return null;
      const lsof = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid]);
      for (const line of lsof.stdout.split("\n")) {
        const m = /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(line);
        if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
      }
      projectFiles = [
        join(home, "Library", "Application Support", "Antigravity", "app_storage.json"),
        join(home, ".config", "Antigravity", "app_storage.json"),
      ];
    }

    const found = await probePorts(ports, csrf);
    if (found.port === undefined) return null;
    const env: Record<string, string> = { ANTIGRAVITY_LS_ADDRESS: `localhost:${found.port}` };
    if (found.csrf) env.ANTIGRAVITY_CSRF_TOKEN = found.csrf;
    const project = await lastProjectId(projectFiles);
    if (project) env.ANTIGRAVITY_PROJECT_ID = project;
    cached = { env, at: Date.now() };
    return env;
  } catch {
    return null;
  }
}
