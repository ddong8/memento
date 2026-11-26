import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";
import { executionEnvironment, findExecutable } from "./exec-env.js";
import { sqliteRows, sqliteRun } from "./sqlite.js";

export type AntigravityAppDataDir = "antigravity" | "antigravity-cli";

export interface AntigravitySessionInfo {
  title?: string;
  workspacePath?: string;
  projectName?: string;
  parentConversationId?: string;
  agentName?: string;
  nestingDepth?: number;
}

let summariesCache: { home: string; map: Map<string, AntigravitySessionInfo>; at: number } | undefined;

function readSummariesDb(dbPath: string, map: Map<string, AntigravitySessionInfo>): boolean {
  if (!existsSync(dbPath)) return false;
  let rows = sqliteRows(
    dbPath,
    "SELECT conversation_id, title, workspace_uris, parent_conversation_id, agent_name, nesting_depth FROM conversation_summaries WHERE status != 'deleted'",
  );
  if (!rows) {
    rows = sqliteRows(dbPath, "SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE status != 'deleted'");
  }
  if (!rows) return false;
  for (const row of rows) {
    const cid = String(row[0] ?? "").trim();
    const title = String(row[1] ?? "").replace(/\n/g, " ").trim();
    const wsUrisRaw = String(row[2] ?? "").trim();
    const parentConversationId = String(row[3] ?? "").trim() || undefined;
    const agentName = String(row[4] ?? "").trim() || undefined;
    const depthNum = row[5] != null && row[5] !== "" ? Number(row[5]) : undefined;
    const nestingDepth = typeof depthNum === "number" && Number.isFinite(depthNum) && depthNum > 0 ? depthNum : undefined;
    if (!cid) continue;

    let wsPath: string | undefined;
    let pName: string | undefined;
    if (wsUrisRaw) {
      const m = /"file:\/\/\/([^"]+)"|"file:\/\/([^"]+)"/.exec(wsUrisRaw);
      if (m) {
        const rawUri = m[1] || m[2];
        if (rawUri) {
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
    }

    const prev = map.get(cid);
    map.set(cid, {
      title: title || prev?.title || undefined,
      workspacePath: wsPath || prev?.workspacePath,
      projectName: pName || prev?.projectName,
      ...(parentConversationId || prev?.parentConversationId ? { parentConversationId: parentConversationId || prev?.parentConversationId } : {}),
      ...(agentName || prev?.agentName ? { agentName: agentName || prev?.agentName } : {}),
      ...(nestingDepth || prev?.nestingDepth ? { nestingDepth: nestingDepth || prev?.nestingDepth } : {}),
    });
  }
  return true;
}

function loadSummariesMap(home = homeDir()): Map<string, AntigravitySessionInfo> {
  // Read antigravity-cli first, then antigravity (Desktop authoritative store) so Desktop metadata wins when both have rows.
  const dbPaths = [
    join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"),
    join(home, ".gemini", "antigravity", "conversation_summaries.db"),
  ];
  const map = new Map<string, AntigravitySessionInfo>();
  if (!dbPaths.some((p) => existsSync(p))) return map;

  const now = Date.now();
  if (summariesCache && summariesCache.home === home && now - summariesCache.at < 15_000) {
    return summariesCache.map;
  }

  try {
    let anyOk = false;
    for (const dbPath of dbPaths) {
      if (readSummariesDb(dbPath, map)) anyOk = true;
    }
    if (!anyOk) throw new Error("conversation_summaries.db unreadable");
    summariesCache = { home, map, at: now };
  } catch {
    if (summariesCache && summariesCache.home === home) return summariesCache.map;
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
  // Corrupted / mojibake titles with replacement characters or raw control characters
  if (t.includes("\ufffd") || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) return true;
  if (t.startsWith("\\n") || t.startsWith("\n") || t.startsWith("\\r") || t.startsWith("\r")) return true;
  if (t.startsWith("【前文对话历史") || t.startsWith("【前序会话核心记忆快照") || t.startsWith("Memento: 【前序会话核心记忆快照")) return true;
  if (/(?:\\[0-7]{3}){2,}/.test(t)) return true;
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
  // Strip multi-turn continuation preambles
  cleaned = cleaned.replace(/^【前序会话核心记忆快照[\s\S]*?【执行规则】[\s\S]*?当前用户指令[：:]\s*/i, "");
  cleaned = cleaned.replace(/^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*/i, "");
  cleaned = cleaned.replace(/^【前文对话历史[^】]*】[\s\S]*?【当前用户指令】\s*/i, "");
  cleaned = cleaned.replace(/^【前文对话历史[^】]*】[\s\S]*?\n\s*用户[：:]\s*/i, "");
  cleaned = cleaned.replace(/^【前序会话核心记忆快照[\s\S]*?\n\s*用户[：:]\s*/i, "");
  cleaned = cleaned.replace(/^【前文对话历史[^】]*】\s*/i, "");
  cleaned = cleaned.replace(/^【前序会话核心记忆快照[\s\S]*?】\s*/i, "");
  cleaned = cleaned.replace(/^用户[：:]\s*/i, "").trim();
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

  for (const subdir of ["antigravity", "antigravity-cli"] as const) {
    const dbPath = join(home, ".gemini", subdir, "conversation_summaries.db");
    if (existsSync(dbPath)) {
      if (sqliteRun(dbPath, "UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?", [trimmedTitle, sessionId])) {
        updatedDb = true;
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

function antigravityTranscriptFile(sessionId: string, home = homeDir()): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  for (const subdir of ["antigravity", "antigravity-cli"] as const) {
    const p = join(home, ".gemini", subdir, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(p)) return p;
  }
  return undefined;
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
    const transcriptFile = antigravityTranscriptFile(sessionId, home);
    if (transcriptFile) {
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
      const transcriptFile = antigravityTranscriptFile(cid, home);
      if (transcriptFile) {
        const healed = healAntigravitySession(cid, transcriptFile, undefined, home);
        if (healed) count++;
      }
    }
  }
  return count;
}

/** Whether Google's official agy CLI (~/.gemini/antigravity-cli) owns the trajectory for sessionId. */
export function antigravityCliHasConversation(sessionId: string, home = homeDir()): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const db = join(home, ".gemini", "antigravity-cli", "conversations", `${sessionId}.db`);
  try {
    return statSync(db).size > 0;
  } catch {
    return false;
  }
}

/** Whether the Antigravity desktop app (~/.gemini/antigravity) owns sessionId on this machine. */
export function antigravityDesktopHasConversation(sessionId: string, home = homeDir()): boolean {
  if (!/^[\w-]+$/.test(sessionId)) return false;
  const db = join(home, ".gemini", "antigravity", "conversations", `${sessionId}.db`);
  if (existsSync(db)) return true;
  return existsSync(join(home, ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"));
}

/**
 * Whether this machine has an active Antigravity Desktop App store (~/.gemini/antigravity).
 * Note: Memento's own `ensureAgyCliInstalled` creates `~/.gemini/antigravity/bin/` even on headless
 * servers, so we check for genuine Desktop app store files instead of bare directory existence.
 */
export function antigravityDesktopStorePresent(home = homeDir()): boolean {
  const agDir = join(home, ".gemini", "antigravity");
  return (
    existsSync(join(agDir, "conversation_summaries.db")) ||
    existsSync(join(agDir, "conversations")) ||
    existsSync(join(agDir, "antigravity_state.pbtxt")) ||
    existsSync(join(agDir, "jetski_state.pbtxt"))
  );
}

/**
 * Picks which Antigravity app-data-dir (`~/.gemini/<dir>`) `agy acp --stdio --app-data-dir` should use:
 * 1) Resuming a Desktop session -> `"antigravity"` (in-place bidirectional resume, never forks!).
 * 2) Resuming an existing CLI session -> `"antigravity-cli"` (preserves CLI continuity).
 * 3) New / cross-device session -> `"antigravity"` when Desktop store exists here, else `"antigravity-cli"`.
 */
export function selectAntigravityAppDataDir(sessionId?: string, home = homeDir()): AntigravityAppDataDir {
  const sid = sessionId?.trim();
  if (sid) {
    if (antigravityDesktopHasConversation(sid, home)) return "antigravity";
    if (antigravityCliHasConversation(sid, home)) return "antigravity-cli";
  }
  return antigravityDesktopStorePresent(home) ? "antigravity" : "antigravity-cli";
}

function normalizeFolderForCompare(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("file://")) {
    s = s.slice("file://".length);
    try {
      s = decodeURIComponent(s);
    } catch {
      // keep raw
    }
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  }
  s = s.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || /^[a-zA-Z]:/.test(s)) {
    return s.toLowerCase();
  }
  return s;
}

function folderCandidates(dir: string): Set<string> {
  const out = new Set<string>();
  const resolved = resolve(dir);
  out.add(normalizeFolderForCompare(resolved));
  try {
    out.add(normalizeFolderForCompare(realpathSync(resolved)));
  } catch {
    // non-existent or unreadable
  }
  return out;
}

function extractProjectFolderUris(project: Record<string, unknown>): string[] {
  const uris: string[] = [];
  const pr = project.projectResources;
  const resources = pr && typeof pr === "object" && !Array.isArray(pr) ? (pr as Record<string, unknown>).resources : undefined;
  if (Array.isArray(resources)) {
    for (const item of resources) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      for (const nestedKey of ["gitFolder", "localFolder", "folder", "workspace"]) {
        const sub = obj[nestedKey];
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          const u = (sub as Record<string, unknown>).folderUri ?? (sub as Record<string, unknown>).uri;
          if (typeof u === "string" && u.trim()) uris.push(u.trim());
        }
      }
      for (const directKey of ["folderUri", "workspaceUri", "uri"]) {
        const u = obj[directKey];
        if (typeof u === "string" && u.trim()) uris.push(u.trim());
      }
    }
  }
  return uris;
}

/**
 * Finds the Antigravity Desktop project ID (`~/.gemini/config/projects/*.json`, falling back to
 * `~/.gemini/antigravity/conversation_summaries.db`) matching `workDir`, so brand-new sessions
 * created via `agy acp --app-data-dir antigravity` appear under the matching Desktop project
 * instead of `default-cli-project`. Returns undefined for home directory or drive roots.
 */
export function resolveAntigravityDesktopProjectId(workDir: string, home = homeDir()): string | undefined {
  if (!workDir?.trim()) return undefined;
  const full = resolve(workDir);
  if (normalizeFolderForCompare(full) === normalizeFolderForCompare(home) || dirname(full) === full) {
    return undefined;
  }
  const targets = folderCandidates(full);

  // 1. Authoritative project configs in ~/.gemini/config/projects/*.json
  const projectsDir = join(home, ".gemini", "config", "projects");
  const validProjectIds = new Set<string>();
  if (existsSync(projectsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(projectsDir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      entries = [];
    }
    for (const file of entries) {
      try {
        const parsed = JSON.parse(readFileSync(join(projectsDir, file), "utf8")) as Record<string, unknown>;
        const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
        if (!id || id === "default-cli-project" || id === "outside-of-project") continue;
        validProjectIds.add(id);
        for (const uri of extractProjectFolderUris(parsed)) {
          if (targets.has(normalizeFolderForCompare(uri))) return id;
        }
      } catch {
        // skip unreadable project json
      }
    }
  }

  // 2. Fallback: most recent Desktop conversation summary for this exact workspace
  const dbPath = join(home, ".gemini", "antigravity", "conversation_summaries.db");
  if (existsSync(dbPath)) {
    const rows =
      sqliteRows(
        dbPath,
        "SELECT project_id, workspace_uris FROM conversation_summaries WHERE project_id NOT IN ('', 'outside-of-project', 'default-cli-project') ORDER BY last_modified_time DESC LIMIT 2000",
      ) ?? [];
    for (const [pidRaw, wsRaw] of rows) {
      const pid = String(pidRaw ?? "").trim();
      if (!pid || (validProjectIds.size > 0 && !validProjectIds.has(pid))) continue;
      let uris: unknown[] = [];
      try {
        uris = JSON.parse(String(wsRaw ?? "[]")) as unknown[];
      } catch {
        continue;
      }
      if (!Array.isArray(uris) || uris.length !== 1) continue;
      if (typeof uris[0] === "string" && targets.has(normalizeFolderForCompare(uris[0]))) {
        return pid;
      }
    }
  }
  return undefined;
}

/**
 * Replaces protobuf field 18 (`\x92\x01<varint><default-cli-project>`) in a trajectory_metadata_blob
 * with the matching Desktop project ID. Returns null when the blob does not hold `default-cli-project`.
 */
export function patchTrajectoryMetadataProjectId(blob: Buffer, projectId: string): Buffer | null {
  const pid = projectId.trim();
  if (!pid || pid === "default-cli-project") return null;
  const pidBytes = Buffer.from(pid, "utf8");
  if (pidBytes.length > 127) return null; // single-byte protobuf varint length
  const needle = Buffer.concat([Buffer.from([0x92, 0x01, 0x13]), Buffer.from("default-cli-project", "utf8")]);
  const idx = blob.indexOf(needle);
  if (idx === -1) return null;
  const replacement = Buffer.concat([Buffer.from([0x92, 0x01, pidBytes.length]), pidBytes]);
  return Buffer.concat([blob.subarray(0, idx), replacement, blob.subarray(idx + needle.length)]);
}

/**
 * Rebinds a newly created `default-cli-project` Antigravity session to its Desktop workspace project
 * in both `conversation_summaries.db` and `conversations/<id>.db` (`trajectory_metadata_blob`).
 * Never overwrites a conversation that already belongs to a real Desktop project.
 */
export function bindAntigravitySessionProject(
  sessionId: string,
  projectId: string,
  appDataDir: AntigravityAppDataDir = "antigravity",
  home = homeDir(),
): boolean {
  if (!/^[\w-]+$/.test(sessionId) || !projectId?.trim() || projectId === "default-cli-project") return false;
  const pid = projectId.trim();
  const base = join(home, ".gemini", appDataDir);
  let changed = false;

  const summaryDb = join(base, "conversation_summaries.db");
  if (existsSync(summaryDb)) {
    const existing = sqliteRows(summaryDb, "SELECT project_id FROM conversation_summaries WHERE conversation_id = ? LIMIT 1", [sessionId]);
    const currentPid = String(existing?.[0]?.[0] ?? "").trim();
    if (!currentPid || currentPid === "default-cli-project" || currentPid === "outside-of-project") {
      if (
        sqliteRun(
          summaryDb,
          "UPDATE conversation_summaries SET project_id = ? WHERE conversation_id = ? AND project_id IN ('', 'default-cli-project', 'outside-of-project')",
          [pid, sessionId],
        )
      ) {
        changed = true;
      }
    } else {
      // Already belongs to a real project; leave both DBs untouched.
      return false;
    }
  }

  const convDb = join(base, "conversations", `${sessionId}.db`);
  if (existsSync(convDb)) {
    try {
      const sqlite = (process as unknown as { getBuiltinModule?: (id: string) => { DatabaseSync?: new (path: string) => {
        prepare: (sql: string) => { get: (...args: unknown[]) => Record<string, unknown> | undefined; run: (...args: unknown[]) => void };
        exec: (sql: string) => void;
        close: () => void;
      } } }).getBuiltinModule?.("node:sqlite");
      if (sqlite?.DatabaseSync) {
        const db = new sqlite.DatabaseSync(convDb);
        try {
          db.exec("PRAGMA busy_timeout = 1500");
          const row = db.prepare("SELECT id, data FROM trajectory_metadata_blob LIMIT 1").get();
          const raw = row?.data;
          if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
            const patched = patchTrajectoryMetadataProjectId(Buffer.from(raw), pid);
            if (patched) {
              db.prepare("UPDATE trajectory_metadata_blob SET data = ? WHERE id = ?").run(patched, row?.id ?? 1);
              changed = true;
            }
          }
        } finally {
          db.close();
        }
      }
    } catch {
      // non-fatal: summary DB already updated
    }
  }

  if (changed) summariesCache = undefined;
  return changed;
}

function cleanTranscriptTurnText(raw: string): string {
  let s = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "")
    .replace(/<system>[\s\S]*?<\/system>/gi, "")
    .trim();
  const req = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(s);
  if (req?.[1]) s = req[1].trim();
  return s;
}

/**
 * Recent user/assistant exchanges from an Antigravity desktop conversation's local transcript,
 * formatted as a compact preamble so Google's official agy CLI can continue a desktop conversation
 * without failing with `trajectory not found`.
 */
export function antigravityDesktopTranscriptContext(
  sessionId: string,
  home = homeDir(),
  maxMessages = 8,
): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const transcriptPath = join(home, ".gemini", "antigravity", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  if (!existsSync(transcriptPath)) return undefined;
  let raw: string;
  try {
    // Bound memory on huge transcripts by reading the trailing 1.5 MB at most
    const size = statSync(transcriptPath).size;
    const maxBytes = 1_500_000;
    if (size <= maxBytes) {
      raw = readFileSync(transcriptPath, "utf8");
    } else {
      const fd = openSync(transcriptPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const read = readSync(fd, buf, 0, maxBytes, size - maxBytes);
        const slice = buf.toString("utf8", 0, read);
        const nl = slice.indexOf("\n");
        raw = nl >= 0 ? slice.slice(nl + 1) : slice;
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    return undefined;
  }

  const turns: Array<{ role: "用户" | "助手"; text: string }> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step: { type?: string; source?: string; content?: unknown } | null = null;
    try {
      step = JSON.parse(trimmed) as { type?: string; source?: string; content?: unknown };
    } catch {
      continue;
    }
    if (!step || typeof step.content !== "string" || !step.content.trim()) continue;
    if (step.type === "USER_INPUT" || step.source === "USER_EXPLICIT") {
      if (
        step.content.includes("<SYSTEM_MESSAGE>") ||
        step.content.includes("[BROWSER_HOST_FACTS") ||
        /^The subagent\b/i.test(step.content.trim())
      ) {
        continue;
      }
      const cleaned = cleanTranscriptTurnText(step.content);
      if (cleaned) turns.push({ role: "用户", text: cleaned });
    } else if (step.type === "PLANNER_RESPONSE" && step.source === "MODEL") {
      const cleaned = step.content.trim();
      if (cleaned) turns.push({ role: "助手", text: cleaned });
    }
  }
  if (!turns.length) return undefined;
  const tailStart = Math.max(0, turns.length - maxMessages);
  const firstUserIdx = turns.findIndex((t) => t.role === "用户");
  const picked =
    firstUserIdx >= 0 && firstUserIdx < tailStart
      ? [{ role: "初始提问" as const, text: turns[firstUserIdx]!.text }, ...turns.slice(tailStart)]
      : turns.slice(tailStart);
  const recent = picked.map((t) => {
    const body = t.text.length > 1200 ? `${t.text.slice(0, 1150)}\n...[已节略]` : t.text;
    return `${t.role}: ${body}`;
  });
  return `【前文对话历史（续接自 Antigravity 桌面会话 ${sessionId.slice(0, 8)}）】\n${recent.join("\n\n")}\n\n--------------------`;
}

const BACKGROUND_STARTED = /(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*((?:[0-9a-fA-F-]+\/)?task-\d+)/i;
const SUBAGENT_STARTED = /(?:["']?conversationId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{8,64})|Subagent\s+([0-9a-fA-F-]{8,64})\s+is running)/i;
const BACKGROUND_ENDED = ["finished with result", "The command exited with code", "Command exited with code", "Timer fired", "Timer cancelled", "Status: DONE", "was canceled", "was cancelled", "Status: CANCELLED", "Status: CANCELED", "Status: ERROR", "Status: FAILED", "failed with result"];

/**
 * The background tasks and subagents an Antigravity conversation started at or after `since` (ms) and hasn't
 * seen end, from its transcript (transcript_full.jsonl lines). A task ends with the system message it sends
 * ("[Message] … sender=<id> … Task id "<id>" finished with result"), a step reporting its end, or the
 * agent stopping it (manage_task / manage_subagents). Steps that only show a file never count: they may quote any id.
 */
export function openBackgroundTasks(transcript: string, since: number): string[] {
  const open = new Map<string, string>(); // full id -> short id
  const openSubagents = new Set<string>();
  let pendingSubagent = 0;
  const short = (t: string) => t.split("/").pop()!;
  for (const line of transcript.split("\n")) {
    if (!line.trim()) continue;
    let step: Record<string, unknown>;
    try {
      step = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;
    const content = typeof step.content === "string" ? step.content : "";
    const at = Date.parse(String(step.created_at ?? ""));
    if (step.type === "GENERIC" && step.status === "RUNNING" && content.startsWith("Created At:")) {
      const m = BACKGROUND_STARTED.exec(content);
      // A second's slack: the transcript's times are whole seconds
      if (m && !(at < since - 1000)) open.set(m[1]!.trim(), short(m[1]!.trim()));
      continue;
    }
    if (step.type === "GENERIC" && (pendingSubagent > 0 || /Subagent\s+[0-9a-fA-F-]{8,}\s+is running/i.test(content))) {
      const sm = SUBAGENT_STARTED.exec(content);
      const subId = (sm?.[1] ?? sm?.[2])?.trim();
      if (subId && !(at < since - 1000)) {
        open.set(subId, subId);
        openSubagents.add(subId);
        if (pendingSubagent > 0) pendingSubagent--;
      }
      continue;
    }
    for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
      const c = call as { name?: unknown; args?: unknown };
      let a: Record<string, unknown> = {};
      try {
        a = (typeof c.args === "string" ? JSON.parse(c.args) : c.args ?? {}) as Record<string, unknown>;
      } catch {
        // not JSON
      }
      if (c.name === "invoke_subagent") {
        if (!(at < since - 1000)) pendingSubagent++;
        continue;
      }
      if (c.name === "manage_subagents") {
        const act = String(a.Action ?? "");
        if (act === "kill_all") {
          for (const sid of [...openSubagents]) {
            open.delete(sid);
            openSubagents.delete(sid);
          }
        } else if (act === "kill" && Array.isArray(a.ConversationIds)) {
          for (const rawId of a.ConversationIds) {
            const sid = String(rawId);
            open.delete(sid);
            openSubagents.delete(sid);
          }
        }
        continue;
      }
      if (c.name !== "manage_task" || !["kill", "stop", "cancel"].includes(String(a.Action ?? ""))) continue;
      const target = String(a.TaskId ?? "");
      for (const [tid, tc] of open) if (target && (tid.includes(target) || target.includes(tid) || short(target) === tc)) open.delete(tid);
    }
    if (!content || content.includes("File Path: `") || content.includes("The following changes were made by the ")) continue;
    for (const [tid, tc] of open) {
      const sender = step.type === "SYSTEM_MESSAGE" && (content.includes(`sender=${tid}`) || content.includes(`sender=${tc}`));
      const mentioned = new RegExp(`(?:^|[^\\w-])${tc}(?!\\d)`).test(content);
      if (sender || (mentioned && BACKGROUND_ENDED.some((kw) => content.includes(kw)))) {
        open.delete(tid);
        openSubagents.delete(tid);
      }
    }
  }
  return [...open.keys()];
}

/**
 * The background tasks a run of Google's agy CLI in conversation `conversationId` left running
 * (see openBackgroundTasks); undefined when its transcript can't be read.
 */
export function agyCliOpenBackgroundTasks(
  conversationId: string,
  since: number,
  home = homeDir(),
  appDataDir?: AntigravityAppDataDir,
): string[] | undefined {
  if (!/^[\w-]+$/.test(conversationId)) return undefined;
  const dirs: AntigravityAppDataDir[] = appDataDir === "antigravity" ? ["antigravity", "antigravity-cli"] : ["antigravity-cli", "antigravity"];
  for (const subdir of dirs) {
    const logs = join(home, ".gemini", subdir, "brain", conversationId, ".system_generated", "logs");
    for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
      try {
        return openBackgroundTasks(readFileSync(join(logs, name), "utf8"), since);
      } catch {
        // try the next one
      }
    }
  }
  return undefined;
}

/**
 * Incrementally tails `~/.gemini/<appDataDir>/brain/<id>/.system_generated/logs/transcript.jsonl`
 * while an official `agy` CLI process is running, reading only newly appended bytes so Memento can
 * surface backgrounded commands, thinking, blocked tool calls and completed replies live without
 * waiting for `agy --output-format stream-json`'s head-of-line-blocked stdout serializer.
 */
export class AgyCliTranscriptTailer {
  private sessionId?: string;
  private filePath?: string;
  private activeSubdir: AntigravityAppDataDir = "antigravity-cli";
  private offset = 0;
  private remainder = "";
  private taskLogSizes = new Map<string, number>();

  constructor(
    private readonly home = homeDir(),
    initialSessionId?: string,
    private readonly preferredSubdir: AntigravityAppDataDir = "antigravity-cli",
  ) {
    this.activeSubdir = preferredSubdir;
    if (initialSessionId) this.attach(initialSessionId, true);
  }

  /** Attaches to a conversation ID; when `fromEnd` is true (resuming an existing session before spawn), starts at current EOF. */
  attach(sessionId: string, fromEnd = false): void {
    const sid = sessionId.trim();
    if (!sid || !/^[\w-]+$/.test(sid) || sid === this.sessionId) return;
    this.sessionId = sid;
    this.filePath = undefined;
    this.offset = 0;
    this.remainder = "";
    this.taskLogSizes.clear();
    const resolved = this.resolvePath();
    if (resolved && fromEnd) {
      try {
        this.offset = statSync(resolved).size;
      } catch {
        this.offset = 0;
      }
    }
  }

  private resolvePath(): string | undefined {
    if (this.filePath && existsSync(this.filePath)) return this.filePath;
    if (!this.sessionId) return undefined;
    const dirs: AntigravityAppDataDir[] =
      this.preferredSubdir === "antigravity" ? ["antigravity", "antigravity-cli"] : ["antigravity-cli", "antigravity"];
    for (const subdir of dirs) {
      const logs = join(this.home, ".gemini", subdir, "brain", this.sessionId, ".system_generated", "logs");
      for (const name of ["transcript.jsonl", "transcript_full.jsonl"]) {
        const candidate = join(logs, name);
        if (existsSync(candidate)) {
          this.activeSubdir = subdir;
          this.filePath = candidate;
          return candidate;
        }
      }
    }
    return undefined;
  }

  /** Reads newly appended complete JSON step objects since the previous poll. */
  poll(): Record<string, unknown>[] {
    const path = this.resolvePath();
    if (!path) return [];
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // File rotated or truncated
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset) return [];
    const maxChunk = 2 * 1024 * 1024;
    const toRead = Math.min(size - this.offset, maxChunk);
    let fd: number | undefined;
    let text = "";
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(toRead);
      const bytesRead = readSync(fd, buf, 0, toRead, this.offset);
      if (bytesRead <= 0) return [];
      this.offset += bytesRead;
      text = buf.toString("utf8", 0, bytesRead);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }

    const combined = this.remainder + text;
    const lines = combined.split("\n");
    this.remainder = lines.pop() ?? "";
    const steps: Record<string, unknown>[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          steps.push(parsed as Record<string, unknown>);
        }
      } catch {
        // ignore malformed line
      }
    }
    return steps;
  }

  /** Returns true when any active background task's log file grew since the previous check. */
  hasBackgroundLogGrowth(shortTaskIds: Iterable<string>): boolean {
    if (!this.sessionId) return false;
    const tasksDir = join(this.home, ".gemini", this.activeSubdir, "brain", this.sessionId, ".system_generated", "tasks");
    let grew = false;
    for (const shortId of shortTaskIds) {
      const p = join(tasksDir, `${shortId}.log`);
      try {
        const sz = statSync(p).size;
        const prev = this.taskLogSizes.get(shortId);
        if (prev !== undefined && sz > prev) grew = true;
        this.taskLogSizes.set(shortId, sz);
      } catch {
        // log not created yet
      }
    }
    return grew;
  }
}

/**
 * Antigravity tasks go through memento's runner (assets/agy_cli.mjs, run on the
 * desktop app's Electron as Node) that talks to the running app's language
 * server, so they work in the app's own conversations (~/.gemini/antigravity),
 * the ones memento collects and resumes. Google's agy CLI keeps its
 * conversations apart (~/.gemini/antigravity-cli) and can't resume the app's,
 * so it is only the fallback.
 */
/** Where the runner ships: next to the daemon's code, or MEMENTO_AGY_RUNNER (bundled apps). */
const runnerAsset = () => process.env.MEMENTO_AGY_RUNNER || fileURLToPath(new URL("../assets/agy_cli.mjs", import.meta.url));
const acpRunnerAsset = () => process.env.MEMENTO_AGY_ACP_RUNNER || fileURLToPath(new URL("../assets/agy_acp.mjs", import.meta.url));

/**
 * Memento's Antigravity ACP runner (assets/agy_acp.mjs), copied to `~/.memento/runners` so a child
 * process can run it even when the packaged app sits inside app.asar. Rewritten when it changes.
 */
export async function agyAcpRunner(home = homeDir()): Promise<string> {
  const target = join(mementoDir(home), "runners", "agy_acp.mjs");
  const source = await readFile(acpRunnerAsset(), "utf8");
  if ((await readFile(target, "utf8").catch(() => "")) !== source) {
    await mkdir(join(mementoDir(home), "runners"), { recursive: true });
    await writeIfChanged(target, source, 0o755);
  }
  return target;
}

const acpSupportCache = new Map<string, boolean>();

export function resetAgyAcpSupportCache(): void {
  acpSupportCache.clear();
}

/**
 * Whether Google's official `agy` binary supports `agy acp --stdio` (Agent Client Protocol).
 * Cached per binary path + mtime so the fast `--help` check runs once per installed version.
 */
export async function officialAgySupportsAcp(cli: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  let cacheKey = cli;
  try {
    const st = statSync(cli);
    cacheKey = `${cli}@${st.mtimeMs}:${st.size}`;
  } catch {
    // ignore stat failure
  }
  const hit = acpSupportCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const supported = await new Promise<boolean>((resolve) => {
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
    const opts = { env: env ?? process.env, timeout: 4000, windowsHide: true, maxBuffer: 512 * 1024 };
    const cb = (err: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (err) {
        resolve(false);
        return;
      }
      const text = `${String(stdout ?? "")}\n${String(stderr ?? "")}`;
      resolve(/Agent Client Protocol|Usage:\s*agy\s+acp/i.test(text));
    };
    if (viaShell) {
      execFile("cmd.exe", ["/d", "/s", "/c", `"${cli}" acp --help`], opts, cb);
    } else {
      execFile(cli, ["acp", "--help"], opts, cb);
    }
  });

  acpSupportCache.set(cacheKey, supported);
  return supported;
}
function run(cmd: string, args: string[], timeout = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

/** An `agy` on PATH that memento wrote (for the Python runner or this one), not Google's CLI. */
const OUR_WRAPPER = /agy_cli\.(py|mjs)/;

/** Writes `text` to `path` unless it already holds exactly that; whole file or nothing. */
async function writeIfChanged(path: string, text: string, mode?: number): Promise<void> {
  if ((await readFile(path, "utf8").catch(() => "")) === text) return;
  // A task starting meanwhile must not run half a file
  await writeFile(`${path}.tmp`, text);
  if (mode !== undefined && process.platform !== "win32") await chmod(`${path}.tmp`, mode);
  await rename(`${path}.tmp`, path);
}

/** `agy` for running the runner by hand: on this app's Electron as Node, or on a `node` on PATH. */
function agyWrapper(home: string, script: string, exe = process.execPath): { path: string; text: string } {
  if (process.platform === "win32") {
    return {
      path: join(home, "AppData", "Local", "agy", "bin", "agy.cmd"),
      text:
        `@echo off\r\nrem memento's Antigravity runner (rewritten by Memento)\r\nsetlocal\r\n` +
        `if not exist "${exe}" goto node\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" %*\r\nexit /b %ERRORLEVEL%\r\n` +
        `:node\r\nnode "${script}" %*\r\n`,
    };
  }
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  return {
    path: join(home, ".local", "bin", "agy"),
    text:
      `#!/bin/sh\n# memento's Antigravity runner (rewritten by Memento)\n` +
      `if [ -x ${q(exe)} ]; then ELECTRON_RUN_AS_NODE=1 exec ${q(exe)} ${q(script)} "$@"; fi\n` +
      `exec node ${q(script)} "$@"\n`,
  };
}

/** The execution PATH's directories, where an `agy` memento wrote may sit or be linked from. */
async function executionPathDirs(): Promise<string[]> {
  const env = await executionEnvironment();
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  return (env[key] ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
}

/**
 * Other `agy` wrappers memento wrote, resolved through links: older apps also put
 * one in ~/.gemini/antigravity/bin (Homebrew's bin and the app's own bin link
 * there), and it ran the Python runner, which is gone now.
 */
async function olderWrappers(home: string, dirs: string[]): Promise<string[]> {
  const names = process.platform === "win32" ? ["agy.cmd", "agy.bat"] : ["agy"];
  const found = new Set<string>();
  for (const dir of [join(home, ".gemini", "antigravity", "bin"), ...dirs]) {
    for (const name of names) {
      try {
        const file = await realpath(join(dir, name));
        const info = await stat(file);
        // Google's agy is a binary of many MB; ours is a few lines
        if (info.isFile() && info.size < 64 * 1024 && OUR_WRAPPER.test(await readFile(file, "utf8"))) found.add(file);
      } catch {
        // none there, or unreadable
      }
    }
  }
  return [...found];
}

/**
 * Installs ~/.gemini/antigravity/bin/agy_cli.mjs (rewritten whenever it differs
 * from the shipped one, the Python runner it replaces removed) and an `agy`
 * wrapper on PATH, kept pointing at this app, as is every other `agy` memento
 * wrote (searched for in `pathDirs`, by default the execution PATH when `home`
 * is this user's); the script's path, or undefined when it couldn't be written.
 */
export async function ensureAgyCliInstalled(home = homeDir(), pathDirs?: string[]): Promise<string | undefined> {
  const dir = join(home, ".gemini", "antigravity", "bin");
  const script = join(dir, "agy_cli.mjs");
  try {
    await mkdir(dir, { recursive: true });
    await writeIfChanged(script, await readFile(runnerAsset(), "utf8"), 0o755);
  } catch {
    if (!existsSync(script)) return undefined;
  }
  await unlink(join(dir, "agy_cli.py")).catch(() => {});
  // What Python left of the runner it compiled
  const pycache = join(dir, "__pycache__");
  for (const f of await readdir(pycache).catch(() => [])) {
    if (/^agy_cli\..*\.pyc$/.test(f)) await unlink(join(pycache, f)).catch(() => {});
  }
  await rmdir(pycache).catch(() => {}); // only once empty
  try {
    const wrapper = agyWrapper(home, script);
    await mkdir(join(wrapper.path, ".."), { recursive: true });
    // Google's CLI may own `agy`: only a missing one or ours is (re)written, and none while its installer
    // runs (it stops when anything sits there; ensureOfficialAgyCli moved ours out of its way)
    const current = await readFile(wrapper.path, "utf8").catch(() => undefined);
    if (!officialInstalling && (current === undefined || OUR_WRAPPER.test(current))) await writeIfChanged(wrapper.path, wrapper.text, 0o755);
    const own = await realpath(wrapper.path).catch(() => wrapper.path);
    const dirs = pathDirs ?? (home === homeDir() ? await executionPathDirs() : []);
    for (const older of await olderWrappers(home, dirs)) {
      // In place, so the links to it run the new runner too
      if (older !== own) await writeIfChanged(older, wrapper.text, 0o755).catch(() => {});
    }
  } catch {
    // only for running `agy` by hand; tasks run the script itself
  }
  return script;
}

/**
 * What runs an Antigravity task: the runner itself (a .mjs the task runner
 * starts on this app's Electron as Node), not the first `agy` on PATH, since
 * Google's agy CLI installs to the same folders (on Windows its agy.exe sits
 * beside our agy.cmd and wins). Google's CLI or agentapi only when the runner
 * couldn't be written.
 */
export async function antigravityExecutable(home = homeDir()): Promise<string | undefined> {
  return (await ensureAgyCliInstalled(home)) ?? findExecutable(["agy", "agentapi"]);
}

/** Whether `file` is (or links to) an `agy` wrapper memento wrote, not Google's CLI. */
function isOurWrapper(file: string): boolean {
  try {
    const real = realpathSync(file);
    return statSync(real).size < 64 * 1024 && OUR_WRAPPER.test(readFileSync(real, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Google's own Antigravity CLI (`agy`, installed to ~/.local/bin by its install script), for tasks on a
 * machine where the Antigravity app isn't running, such as a server without a desktop; passes over the
 * `agy` wrappers memento writes. Undefined when it isn't installed.
 */
export async function officialAgyCli(home = homeDir(), env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const e = { ...(env ?? (await executionEnvironment())) };
  const key = Object.keys(e).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = process.platform === "win32" ? ";" : ":";
  // A service's PATH often lacks the installer's folder (install.ps1 puts agy.exe in %LOCALAPPDATA%\agy\bin)
  const installDirs =
    process.platform === "win32"
      ? [join(e.LOCALAPPDATA || join(home, "AppData", "Local"), "agy", "bin"), join(home, ".local", "bin")]
      : [join(home, ".local", "bin")];
  e[key] = [e[key] ?? "", ...installDirs].filter(Boolean).join(sep);
  return findExecutable(process.platform === "win32" ? ["agy.exe"] : ["agy"], e, isOurWrapper);
}

/** Google's install script running now, so the runner's wrapper isn't written back where it installs. */
let officialInstalling: Promise<string | undefined> | undefined;
let officialInstallTriedAt = 0;

/**
 * Google's agy CLI, installed with its official script when it's missing (at most every 30 minutes).
 * Antigravity's sign-in is shared by the app and the CLI on one machine (docs/install: "Signing in on
 * one local surface shares your credentials"), so on a desktop where the app is signed in the CLI runs
 * without asking. On macOS and Linux the script stops when anything sits at ~/.local/bin/agy, so the
 * runner's wrapper there (only for running `agy` by hand) makes way for it.
 */
export async function ensureOfficialAgyCli(home = homeDir()): Promise<string | undefined> {
  const found = await officialAgyCli(home);
  if (found) return found;
  if (officialInstalling) return officialInstalling;
  if (Date.now() - officialInstallTriedAt < 30 * 60_000) return undefined;
  officialInstallTriedAt = Date.now();
  officialInstalling = (async () => {
    try {
      const env = await executionEnvironment();
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        if (process.platform === "win32") {
          execFile(
            "powershell",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://antigravity.google/cli/install.ps1 | iex"],
            { env, timeout: 300_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            done,
          );
          return;
        }
        const target = join(home, ".local", "bin", "agy");
        unlinkIfOurs(target).finally(() =>
          execFile("/bin/bash", ["-c", "curl -fsSL https://antigravity.google/cli/install.sh | bash"], { env: { ...env, HOME: home }, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, done),
        );
      });
      return await officialAgyCli(home);
    } catch {
      return undefined;
    } finally {
      officialInstalling = undefined;
    }
  })();
  return officialInstalling;
}

async function unlinkIfOurs(path: string): Promise<void> {
  if (existsSync(path) && isOurWrapper(path)) await unlink(path).catch(() => {});
}

/**
 * Whether the app's language server turned a call down for want of its CSRF token. Antigravity 2.34's
 * desktop app (its language server in hub mode) hands the token only to the processes it starts itself
 * (over the host bridge, no --csrf_token argument, an empty csrfToken in its page), so another program's
 * agentapi calls fail with "missing CSRF token"; Google's CLI is the way in then.
 */
export function isAppAuthRejection(text: string): boolean {
  return /missing CSRF token|invalid CSRF token|code = Unauthenticated/i.test(text);
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
 * Chinese reads back right whatever code page PowerShell writes in (it depends
 * on the console it gets, and setting [Console]::OutputEncoding fails in a host
 * without one). Ports are joined into a string: Windows PowerShell 5.1 can
 * serialize a one-element array as {"value":[...],"Count":1}.
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

/**
 * Has the running Antigravity load its MCP servers again. It reads
 * mcp_config.json when it starts and doesn't watch it, so an entry written
 * meanwhile (mcp-register.ts) would otherwise wait for the app's next start
 * (2026-11-09 on Windows: none loaded until RefreshMcpServers, then
 * memento-memory was ready at once). Never starts the app; false when it isn't
 * running or didn't take the call.
 */
export async function refreshAntigravityMcpServers(
  locate: typeof findAntigravityLanguageServer = findAntigravityLanguageServer,
): Promise<boolean> {
  const call = async (ls: AntigravityLanguageServer) => {
    try {
      const res = await fetch(`http://127.0.0.1:${ls.port}/exa.language_server_pb.LanguageServerService/RefreshMcpServers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ls.csrf ? { "x-codeium-csrf-token": ls.csrf } : {}) },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };
  const ls = await locate();
  if (!ls) return false;
  if (await call(ls)) return true;
  // The remembered port or token may be stale
  const again = await locate({ forceRefresh: true });
  return again ? call(again) : false;
}

/**
 * Where the running Antigravity app's language server listens, with its CSRF
 * token; null when Antigravity isn't running. On macOS the app
 * is started when it's installed but closed.
 */
export async function discoverAntigravityEnv(forceRefresh = false): Promise<Record<string, string> | null> {
  if (!forceRefresh && cached && Date.now() - cached.at < 30_000) return cached.env;
  cached = undefined;
  try {
    const ls = await findAntigravityLanguageServer({ launch: true, forceRefresh });
    if (!ls) return null;
    // No token to be had (Antigravity 2.34+ keeps it to its own processes, isAppAuthRejection): every
    // agentapi call would be turned down, so tasks go to Google's CLI as on a machine without the app
    if (!ls.csrf) return null;
    const env: Record<string, string> = { ANTIGRAVITY_LS_ADDRESS: `localhost:${ls.port}` };
    if (ls.csrf) env.ANTIGRAVITY_CSRF_TOKEN = ls.csrf;
    // The runner's agentapi, for an app installed somewhere other than the default folder
    if (ls.binary) env.ANTIGRAVITY_LS_BINARY = ls.binary;
    // No ANTIGRAVITY_PROJECT_ID: the runner picks the project for the task's folder (projectForFolder).
    // The app's lastCreatedProjectId here put every new conversation in the project made last, whatever
    // folder the task was for (2026-11-14: easywork-copilot tasks ran in chem-vision).
    cached = { env, at: Date.now() };
    return env;
  } catch {
    return null;
  }
}
