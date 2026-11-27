// File ingestion, title healing, project resolution, full-text indexing & message extraction
// (server/server/services/ingest_service.py).
import { randomUUID } from "node:crypto";

import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheDeletePrefix } from "../cache";
import type { Db } from "../db/client";
import { conversationMessages, documents, documentVersions, projects, syncState, tools } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { sessionActivity } from "./claude-session";
import * as contentStaging from "./content-staging";
import { hermesMessagesToStore, messagesToStore, type StoredMessage } from "./conversation-parser";
import { EMBED_CATEGORIES } from "./embedding";
import * as messageStore from "./message-store";
import { stripProfileBlock } from "./profile-scopes";
import { dropExcluded, updateSyncState } from "./project-exclusion";
import { publishEventThrottled } from "./sse";
import { scheduleForDocument } from "./session-timeline";
import { MAX_INPUT_CHARS, tokenizeForIndex } from "./tokenize";

export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  claude_code: "Claude Code",
  openclaw: "OpenClaw",
  codex: "Codex",
  antigravity: "Antigravity",
  workbuddy: "WorkBuddy",
  obsidian: "Obsidian",
  cursor: "Cursor",
  hermes: "Hermes",
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isJunkOrUuidTitle(title: string | null | undefined, sessionId?: string | null): boolean {
  if (!title) return true;
  const rawS = String(title);
  if (/^(?:\n|\r|\\n|\\r|\\\\n|\\\\r)/.test(rawS)) return true;
  const t = rawS.trim();
  if (!t) return true;
  if (/^(?:用户: |用户：|助手: |助手：|user: |assistant: )/.test(t)) return true;
  const low = t.toLowerCase();
  if (
    ["transcript", "transcript.jsonl", "conversation", "untitled", "unknown", "start", "starting the conversation", "starting conversation"].includes(low)
  ) {
    return true;
  }
  if (
    ["starting the conversation", "starting conversation", "agent-", "subagent-", "workflow-", "wf_", "wf-", "prompt-", "run-", "rollout-"].some((p) =>
      low.startsWith(p),
    )
  ) {
    return true;
  }
  if (low.startsWith("this session is being continued from a previous conversation")) return true;
  if (t.startsWith("【前序会话核心记忆快照") || t.startsWith("【前文对话历史】") || t.startsWith("Memento: 【前序会话核心记忆快照")) return true;
  if (low.startsWith("the following is the codex agent history")) return true;
  if (low.startsWith("<recommended_plugins>") || low.startsWith("<environment_context>") || low.startsWith("<turn_aborted>")) return true;
  if (["[request interrupted", "[interrupted", "request interrupted", "turn aborted", "<turn_aborted"].some((p) => low.startsWith(p))) return true;
  if (["{", "[{", '{"', '{"type"', '{"timestamp"', '{"step_index"'].some((p) => t.startsWith(p))) return true;
  if (low.startsWith("<ide_opened_file>") || low.startsWith("<environment_context>") || low.startsWith("<user_request>")) return true;
  if (/\\[dswDSWbB]/.test(t) || t.includes("(.*?)") || t.includes("<") || t.startsWith("re.search")) return true;
  if (t.includes("\ufffd") || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t)) return true;
  if (/(?:\\[0-7]{3}){2,}/.test(t)) return true;
  if (/^\s*(?:\\n)?\d+:/.test(t)) return true;
  if ([".jsonl", ".json", ".pbtxt", ".sqlite", ".md"].some((e) => low.endsWith(e))) return true;
  if (UUID_RE.test(t)) return true;
  if (sessionId && (t === sessionId || t === sessionId.slice(0, 8))) return true;
  return false;
}

const INJECTED_CONTEXT_RES = [
  /^【前序会话核心记忆快照[\s\S]*?【执行规则】[\s\S]*?当前用户指令[：:]\s*/,
  /^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*/,
  /^【前文对话历史】[\s\S]*?【当前用户指令】\s*/,
  /^【前文对话历史】[\s\S]*?\n\s*用户[：:]\s*/,
  /^【前序会话核心记忆快照[\s\S]*?\n\s*用户[：:]\s*/,
  /^【前文对话历史】\s*/,
  /^【前序会话核心记忆快照[\s\S]*?】\s*/,
];

export function safeDecodePbtxtString(s: string): string {
  if (!s) return "";
  const decoded = s.replace(/(?:\\[0-7]{1,3})+/g, (match) => {
    const bytes: number[] = [];
    for (const m of match.matchAll(/\\([0-7]{1,3})/g)) bytes.push(parseInt(m[1]!, 8));
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return bytes.map((b) => String.fromCharCode(b)).join("");
    }
  });
  return decoded
    .replaceAll("\\\\", "\\")
    .replaceAll('\\"', '"')
    .replaceAll("\\n", " ")
    .replaceAll("\\r", "")
    .replaceAll("\\t", " ")
    .trim();
}

export function stripInjectedContext(content: string): string {
  let res = content;
  for (const pat of INJECTED_CONTEXT_RES) {
    const next = res.replace(pat, "");
    if (next !== res) {
      res = next;
      break;
    }
  }
  if (res.startsWith("用户: ")) res = res.slice(4);
  else if (res.startsWith("用户：")) res = res.slice(3);
  return res;
}

export function titleFromUserMessages(contents: (string | null | undefined)[], sessionId?: string | null): string | null {
  for (const content of contents) {
    if (!content) continue;
    const cand = stripInjectedContext(content.trim()).trim().split("\n")[0]!.trim().slice(0, 60);
    if (cand && !isJunkOrUuidTitle(cand, sessionId)) return cand;
  }
  return null;
}

export function extractCustomTitle(content: string | null | undefined, sessionId?: string | null): string | null {
  if (!content || !content.includes('"customTitle"')) return null;
  for (const m of content.matchAll(/"customTitle"\s*:\s*"((?:[^"\\]|\\.)+)"/g)) {
    const raw = m[1]!;
    let cand: string;
    try {
      cand = String(JSON.parse(`"${raw}"`)).trim();
    } catch {
      cand = raw.trim();
    }
    if (isJunkOrUuidTitle(cand, sessionId)) continue;
    if (cand.startsWith("Memento: ")) cand = cand.slice("Memento: ".length).trim();
    if (cand && !isJunkOrUuidTitle(cand, sessionId)) return cand.slice(0, 60);
  }
  return null;
}

const NON_TRANSCRIPT_TOOLS = new Set(["claude_code", "workbuddy", "cursor"]);

function inferCategory(toolId: string, category: string, _contentType: string, relativePath: string): string {
  if (category !== "conversation" || !NON_TRANSCRIPT_TOOLS.has(toolId)) return category;
  const low = relativePath.replaceAll("\\", "/").toLowerCase();
  if (low.endsWith(".md")) {
    if (toolId === "cursor" || `/${low}`.includes("/memory/")) return "memory";
    if (low.startsWith("plans/")) return "plan";
  } else if (toolId === "cursor" && low.endsWith(".json")) {
    return "config";
  }
  return category;
}

export function parentSessionIdFromContent(content: string | null | undefined): string | null {
  if (!content) return null;
  if (content.includes('"isSidechain"') && /"isSidechain"\s*:\s*true/.test(content)) {
    const m = /"sessionId"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(content);
    if (m) return m[1]!;
  }
  const firstNl = content.indexOf("\n");
  const firstLine = firstNl === -1 ? content : content.slice(0, firstNl);
  if (firstLine.includes('"session_meta"') && (firstLine.includes("parent_thread_id") || firstLine.includes("thread_spawn"))) {
    try {
      const meta = JSON.parse(firstLine) as Record<string, unknown>;
      if (meta?.type === "session_meta" && meta.payload && typeof meta.payload === "object") {
        const p = meta.payload as Record<string, unknown>;
        const ownId = String(p.id ?? "").trim();
        let parentTid = String(p.parent_thread_id ?? "").trim();
        if (!parentTid && p.source && typeof p.source === "object") {
          const sub = (p.source as Record<string, unknown>).subagent;
          if (sub && typeof sub === "object") {
            const sp = (sub as Record<string, unknown>).thread_spawn;
            if (sp && typeof sp === "object") parentTid = String((sp as Record<string, unknown>).parent_thread_id ?? "").trim();
          }
        }
        if (parentTid && parentTid !== ownId) return parentTid;
      }
    } catch {
      /* ignore */
    }
  }
  const gm = /Reviewed Codex session id:\s*([0-9a-fA-F-]{36})/.exec(content);
  if (gm) return gm[1]!;
  if (firstLine.includes('"parent_conversation_id"')) {
    const am = /"parent_conversation_id"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(firstLine);
    if (am) return am[1]!;
  }
  return null;
}

export function extractLatestAiTitle(content: string | null | undefined): string | null {
  if (!content || !content.includes('"aiTitle"')) return null;
  const matches = [...content.matchAll(/"aiTitle"\s*:\s*"([^"]+)"/g)];
  if (!matches.length) return null;
  const cand = matches[matches.length - 1]![1]!.trim();
  return cand || null;
}

const RESANITIZE_PATTERNS: [RegExp, string][] = [
  [/sk-[a-zA-Z0-9]{20,}/g, "[API_KEY_REDACTED]"],
  [/ghp_[a-zA-Z0-9]{36}/g, "[GITHUB_TOKEN_REDACTED]"],
  [/bot\d+:[A-Za-z0-9_-]{35}/g, "[TELEGRAM_BOT_TOKEN_REDACTED]"],
  [/-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gm, "[PRIVATE_KEY_REDACTED]"],
];

function resanitize(text: string): { text: string; hadSensitive: boolean } {
  let out = text;
  let found = false;
  for (const [pat, rep] of RESANITIZE_PATTERNS) {
    const next = out.replace(pat, rep);
    if (next !== out) {
      found = true;
      out = next;
    }
  }
  return { text: out, hadSensitive: found };
}

const WORKSPACE_PATTERNS = [
  /([a-zA-Z]:[/\\]dev[/\\]\d{4}[/\\]\d+[/\\][a-zA-Z0-9_.-]+)/g,
  /([a-zA-Z]:[/\\]dev[/\\]\d+[/\\][a-zA-Z0-9_.-]+)/g,
  /([a-zA-Z]:[/\\]Users[/\\][a-zA-Z0-9_.-]+[/\\]Desktop[/\\][a-zA-Z0-9_.-]+)/g,
  /([a-zA-Z]:[/\\](?:dev|projects|workspace)[/\\][a-zA-Z0-9_.-]+)/g,
  /(\/Users\/[a-zA-Z0-9_.-]+\/Desktop\/dev\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)?)/g,
  /(\/Users\/[a-zA-Z0-9_.-]+\/Desktop\/[a-zA-Z0-9_.-]+)/g,
  /(\/Users\/[a-zA-Z0-9_.-]+\/(?:dev|projects|workspace)\/[a-zA-Z0-9_.-]+)/g,
  /(\/home\/[a-zA-Z0-9_.-]+\/(?:dev|projects|workspace)\/[a-zA-Z0-9_.-]+)/g,
  /([a-zA-Z]:[/\\]dev[/\\][a-zA-Z0-9_.-]+)/g,
];

const IGNORE_PATH_EXTS = new Set([".md", ".py", ".js", ".ts", ".jsx", ".tsx", ".json", ".jsonl", ".yml", ".yaml", ".sh", ".txt", ".html", ".css", ".png", ".jpg", ".jpeg", ".ico"]);
const IGNORE_PATH_DIRS = new Set(["docs", "doc", "src", "tests", "test", "bin", "dist", "build", "node_modules", "temp", "tmp", "scratch", "tools", "mcp", "import", "off", ".system_generated", "subagents", "workflows", "conversations", "logs"]);
const IGNORE_PROJECT_NAMES = new Set(["-", "--", "...", "dev", "desktop", "tmp", "temp", "projects", "workspace", "file:", "file", "untitled", "unknown", "none", "null"]);
const FILE_LIKE_NAME = /\.(jsonl?|log|txt|md|py|tsx?|jsx?|mjs|cjs|ya?ml|toml|lock|csv|xml|html?|sh|ps1|bat|png|jpe?g|gif|pdf|zip|tar|gz)$/i;
const TOOL_STATE_MARKERS = ["/.gemini/antigravity/brain/", "/.system_generated/", "/.claude/projects/", "/.codex/sessions/", "/appdata/"];
const ROOT_LIKE_PATH = /^(?:[a-z]:)?\/?(?:users|home)?\/?$/i;

function isAgyScratch(path: string | null | undefined): boolean {
  return (path || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase().endsWith("/.gemini/antigravity/scratch");
}

export function isInvalidProjectName(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = String(name).trim().toLowerCase();
  if (!n || IGNORE_PROJECT_NAMES.has(n)) return true;
  const stripped = n.replace(/^[-_./\\"'` \t\r\n]+|[-_./\\"'` \t\r\n]+$/g, "");
  if (!stripped || IGNORE_PROJECT_NAMES.has(stripped)) return true;
  if (n.startsWith("file:")) return true;
  if (/^\d+$/.test(n)) return true;
  if (/^[a-zA-Z]:?$/.test(n)) return true;
  if (["var", "folders", "tmp", "temp", "appdata", "local"].includes(n)) return true;
  return false;
}

export function isJunkProject(title: string | null | undefined, sourcePath: string | null | undefined): boolean {
  if (title && FILE_LIKE_NAME.test(title.trim())) return true;
  const sp = (sourcePath || "").replaceAll("\\", "/").trim();
  if (!sp) return false;
  const norm = `${sp.toLowerCase().replace(/\/+$/, "")}/`;
  if (TOOL_STATE_MARKERS.some((m) => norm.includes(m)) || isAgyScratch(sp)) return true;
  return ROOT_LIKE_PATH.test(sp.replace(/\/+$/, ""));
}

const STRIP_EDGE_RE = /^[-"'` ]+|[-"'` ]+$/g;

export function prettifyProjectName(raw: string): string {
  const name = raw.replace(STRIP_EDGE_RE, "");
  const cleaned = name
    .replace(
      /^(?:[A-Za-z]--?)?(?:Users-[^-]+-(?:Desktop-?|Documents-?)?)?(?:home-[^-]+-)?(?:dev-?)?(?:python-?)?(?:\d{4}-\d{2,4}-?)?(?:\d{2,4}-?)?/i,
      "",
    )
    .replace(STRIP_EDGE_RE, "");
  return cleaned || name;
}

function hashToPath(projectHash: string): string {
  const raw = projectHash.replace(STRIP_EDGE_RE, "");
  const m = /^([A-Za-z])--?(.+)$/.exec(raw);
  if (m) return `${m[1]}:/${m[2]!.replaceAll("-", "/")}`;
  if (raw.startsWith("Users-") || raw.startsWith("home-")) return `/${raw.replaceAll("-", "/")}`;
  return projectHash;
}

function cleanSourcePath(path: string | null | undefined): string | null {
  if (!path) return null;
  let s = String(path).trim().replace(/^["'\\` ]+|["'\\` ]+$/g, "");
  if (!s || IGNORE_PROJECT_NAMES.has(s.toLowerCase())) return null;
  if (/^file:\/*$/i.test(s)) return null;
  if (s.toLowerCase().startsWith("file:")) {
    s = s.replace(/^file:\/+/i, "");
    if (!/^[a-zA-Z]:/.test(s) && !s.startsWith("/")) s = `/${s}`;
  }
  s = s.replace(/^[a-zA-Z0-9_-]+:\/\//, "").replace(/^["'\\` ]+|["'\\` ]+$/g, "");
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep raw */
  }
  s = s.replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/^\\\\?\?\\/, "");
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1);
  s = s.replace(/^["'\\` ]+|["'\\` ]+$/g, "");
  const m = /((?:[a-zA-Z]:\/|\/)[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*)/.exec(s);
  if (m) {
    const cand = m[1]!.replace(/\/+$/, "").replace(/^["'\\` ]+|["'\\` ]+$/g, "");
    const last = cand.split("/").pop()!.replace(STRIP_EDGE_RE, "");
    if (!isInvalidProjectName(last)) return cand;
  }
  const cleaned = s.split(/["',\r\n]/)[0]!.replace(/^["'\\` ]+|["'\\` ]+$/g, "").replace(/\/+$/, "");
  if (isInvalidProjectName(cleaned)) return null;
  return cleaned || null;
}

function extractWorkspaceFromContent(content: string): [string | null, string | null] {
  const ui = /<user_information>([\s\S]*?)<\/user_information>/.exec(content);
  if (ui) {
    const uiText = ui[1]!;
    const wsM =
      /Active Workspaces:\s*\n\s*-\s*([^\r\n]+)/.exec(uiText) ??
      /Command Working Directory:\s*([^\r\n]+)/.exec(uiText) ??
      /((?:\/[a-zA-Z0-9_.-]+)+|[a-zA-Z]:[/\\][^\s\r\n->]+)\s*->/.exec(uiText);
    if (wsM) {
      const rawPath = wsM[1]!.trim();
      const wsPath = cleanSourcePath(rawPath) ?? rawPath.replaceAll("\\", "/").replace(/\/+$/, "");
      const wsName = wsPath.split("/").pop() ?? "";
      if (wsName && !/^\d+$/.test(wsName) && !isInvalidProjectName(wsName) && !wsPath.includes("/antigravity/") && !wsPath.includes("/.gemini/")) {
        return [wsName, wsPath];
      }
    }
  }
  for (const m of content.matchAll(/"[Cc]wd"\s*:\s*"?\\?"?((?:[a-zA-Z]:|\/)[^",\r\n}]+)/g)) {
    const cleanCand = m[1]!.replace(/[\\"]+$/, "");
    let decoded: string;
    try {
      decoded = String(JSON.parse(`"${cleanCand}"`));
    } catch {
      decoded = cleanCand.replaceAll("\\\\", "/").replaceAll("\\", "/");
    }
    const wsPath = cleanSourcePath(decoded) ?? decoded.replaceAll("\\", "/").replace(/\/+$/, "");
    const wsName = wsPath.split("/").pop() ?? "";
    if (wsName && !/^\d+$/.test(wsName) && !isInvalidProjectName(wsName) && !wsPath.includes("/antigravity/") && !wsPath.includes("/.gemini/")) {
      return [wsName, wsPath];
    }
  }
  const roots = new Map<string, number>();
  for (const pat of WORKSPACE_PATTERNS) {
    for (const m of content.matchAll(pat)) {
      const root = m[1]!.replaceAll("\\", "/");
      if (root.includes("/antigravity/") || root.includes("/.gemini/")) continue;
      roots.set(root, (roots.get(root) ?? 0) + 1);
    }
  }
  const ranked = [...roots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [candidate] of ranked) {
    const parts = candidate.replace(/\/+$/, "").split("/");
    while (parts.length) {
      const last = parts[parts.length - 1]!.toLowerCase();
      if (IGNORE_PATH_DIRS.has(last) || /^\d+$/.test(last) || IGNORE_PROJECT_NAMES.has(last) || [...IGNORE_PATH_EXTS].some((e) => last.endsWith(e))) {
        parts.pop();
      } else break;
    }
    const nonEmpty = parts.filter(Boolean);
    if (!nonEmpty.length) continue;
    if (nonEmpty.length <= 2 && nonEmpty.some((p) => ["users", "home", "dev"].includes(p.toLowerCase()))) continue;
    if (nonEmpty.length <= 3 && nonEmpty[0]!.endsWith(":") && nonEmpty.slice(1).some((p) => ["users", "home", "dev"].includes(p.toLowerCase()))) continue;
    if (nonEmpty.length >= 2) {
      const projectName = nonEmpty[nonEmpty.length - 1]!;
      if (!/^\d+$/.test(projectName) && !IGNORE_PROJECT_NAMES.has(projectName.toLowerCase())) {
        return [projectName, parts.join("/")];
      }
    }
  }
  return [null, null];
}

export async function ensureTool(db: Db, toolId: string) {
  const [existing] = await db.select().from(tools).where(eq(tools.id, toolId)).limit(1);
  if (existing) return existing;
  const [inserted] = await db
    .insert(tools)
    .values({ id: toolId, displayName: TOOL_DISPLAY_NAMES[toolId] ?? toolId, totalFiles: 0, totalSizeBytes: 0 })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [refetched] = await db.select().from(tools).where(eq(tools.id, toolId)).limit(1);
  return refetched!;
}

async function hasRealProject(db: Db, projectId: string | null): Promise<boolean> {
  if (!projectId) return false;
  const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return Boolean(proj && !isInvalidProjectName(proj.title) && !isJunkProject(proj.title, proj.sourcePath));
}

export async function ensureProject(db: Db, toolId: string, rawHash: string, rawSourcePath?: string | null) {
  let projectHash = (rawHash || "").replace(STRIP_EDGE_RE, "");
  let sourcePath: string | null = rawSourcePath ?? null;
  if (isAgyScratch(sourcePath)) {
    projectHash = "general";
    sourcePath = null;
  }
  if (isInvalidProjectName(projectHash)) {
    const spCand = (sourcePath || "").replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop()!.replace(STRIP_EDGE_RE, "");
    projectHash = !isInvalidProjectName(spCand) ? spCand : "general";
  }
  const cleanedHash = prettifyProjectName(projectHash).replace(STRIP_EDGE_RE, "");
  if (!isInvalidProjectName(cleanedHash)) {
    if (!sourcePath && cleanedHash !== projectHash) sourcePath = hashToPath(projectHash);
    projectHash = cleanedHash;
  }
  sourcePath = cleanSourcePath(sourcePath);
  const slug = `${toolId}/${projectHash}`;
  const [existing] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!existing) {
    const [inserted] = await db
      .insert(projects)
      .values({ id: randomUUID(), slug, title: projectHash, toolId, sourcePath: sourcePath || projectHash, visibility: "private" })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [again] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    return again!;
  }
  if (sourcePath) {
    const oldSp = existing.sourcePath ?? "";
    const oldLast = oldSp.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop()!.toLowerCase();
    const dirty = /["\r\n]/.test(oldSp);
    if (!oldSp || oldSp === existing.title || oldSp.length < 10 || isInvalidProjectName(oldLast) || dirty) {
      const [updated] = await db.update(projects).set({ sourcePath }).where(eq(projects.id, existing.id)).returning();
      return updated ?? existing;
    }
  }
  return existing;
}

export class OffsetMismatch extends Error {
  constructor(readonly expected: number) {
    super(`expected offset ${expected}`);
  }
}

export function sliceLockKey(machineId: string, toolId: string, relativePath: string): string {
  return `slice|${machineId}|${toolId}|${relativePath}`;
}

export async function lockSlice(db: Db, machineId: string, toolId: string, relativePath: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sliceLockKey(machineId, toolId, relativePath)}, 0))`);
}

export async function claimSlice(
  db: Db,
  toolId: string,
  relativePath: string,
  machineId: string,
  mode: string,
  offset: number,
  endOffset: number,
): Promise<[string, number] | null> {
  await lockSlice(db, machineId, toolId, relativePath);
  if (mode !== "delta") return null;
  const mach = normalizeUuid(machineId);
  if (!mach) throw new OffsetMismatch(0);
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.toolId, toolId), eq(documents.relativePath, relativePath), or(eq(documents.machineId, mach), isNull(documents.machineId))))
    .limit(1);
  if (!doc) throw new OffsetMismatch(0);
  const [st] = await db
    .select({ lastEndOffset: syncState.lastEndOffset })
    .from(syncState)
    .where(and(eq(syncState.toolId, toolId), eq(syncState.relativePath, relativePath), eq(syncState.machineId, mach)))
    .limit(1);
  const end = st?.lastEndOffset ?? null;
  if (end === null || offset === end) return null;
  if (endOffset <= end) return [doc.id, end];
  throw new OffsetMismatch(end);
}

function latestTime(msgs: StoredMessage[]): Date | null {
  let best: Date | null = null;
  for (const m of msgs) {
    if (m.timestamp && (!best || m.timestamp.getTime() > best.getTime())) best = m.timestamp;
  }
  return best;
}

function computeSourceTime(
  prevStr: string | null | undefined,
  category: string,
  timestamp: number | null | undefined,
  latestMsg: Date | null,
  now: Date,
  created: boolean,
): string | null | undefined {
  const cands: Date[] = [];
  if (timestamp) cands.push(new Date(timestamp * 1000));
  if (latestMsg) cands.push(latestMsg);
  if (!cands.length) {
    if (!created && category !== "conversation") return now.toISOString();
    return undefined;
  }
  const maxCand = cands.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  const when = maxCand.getTime() <= now.getTime() ? maxCand : now;
  let prev: Date | null = null;
  if (!(created && !timestamp) && prevStr) {
    const t = Date.parse(prevStr.includes("T") ? prevStr : prevStr.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (!Number.isNaN(t)) prev = new Date(t);
  }
  return (!prev || when.getTime() > prev.getTime() ? when : prev).toISOString();
}

export interface IngestFileParams {
  db: Db;
  redis: Redis | null;
  toolId: string;
  category: string;
  contentType: string;
  relativePath: string;
  content: string;
  contentHash: string;
  fileSize: number;
  mode: string;
  offset: number;
  metadata: Record<string, unknown>;
  timestamp?: number | null;
  machineId?: string | null;
  userId?: string | null;
  endOffset?: number | null;
}

export async function ingestFile(params: IngestFileParams): Promise<{ id: string; title: string | null; toolId: string; category: string }> {
  const { db, redis, toolId, contentType, relativePath, contentHash, fileSize, mode, offset, timestamp, machineId, userId, endOffset = null } = params;
  const metadata: Record<string, unknown> = { ...(params.metadata ?? {}) };
  const category = inferCategory(toolId, params.category, contentType, relativePath);
  const machUuid = normalizeUuid(machineId);
  const now = new Date();
  const nowIso = now.toISOString();

  // Fast-path dedup
  const [syncRow] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.toolId, toolId), eq(syncState.relativePath, relativePath), machUuid ? eq(syncState.machineId, machUuid) : sql`true`))
    .limit(1);
  if (category !== "discovery" && syncRow && syncRow.lastHash === contentHash && (mode !== "delta" || syncRow.lastOffset === offset)) {
    await db.update(syncState).set({ lastSyncedAt: nowIso, lastEndOffset: endOffset }).where(eq(syncState.id, syncRow.id));
    const [existingDoc] = await db
      .select({
        id: documents.id,
        toolId: documents.toolId,
        category: documents.category,
        title: documents.title,
        machineId: documents.machineId,
        projectId: documents.projectId,
        metadata: documents.metadata,
      })
      .from(documents)
      .where(
        and(
          eq(documents.toolId, toolId),
          eq(documents.relativePath, relativePath),
          machUuid ? or(eq(documents.machineId, machUuid), isNull(documents.machineId)) : sql`true`,
        ),
      )
      .limit(1);
    if (existingDoc) {
      const docPatch: Partial<typeof documents.$inferInsert> = {};
      if (machUuid && !existingDoc.machineId) docPatch.machineId = machUuid;
      let incomingHash = (metadata.project_hash || metadata.project_name) as string | null | undefined;
      if (isJunkProject(incomingHash, metadata.project_path as string | undefined) || (mode === "delta" && (await hasRealProject(db, existingDoc.projectId)))) {
        incomingHash = null;
      } else if (!incomingHash && metadata.project_path) {
        incomingHash = String(metadata.project_path).replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop();
      }
      let curMd = (existingDoc.metadata && typeof existingDoc.metadata === "object" ? existingDoc.metadata : {}) as Record<string, unknown>;
      if (incomingHash && !isInvalidProjectName(incomingHash)) {
        const cleanH = prettifyProjectName(incomingHash).replace(STRIP_EDGE_RE, "");
        if (cleanH && !isInvalidProjectName(cleanH)) {
          const [pRow] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, `${toolId}/${cleanH}`)).limit(1);
          if (pRow && existingDoc.projectId !== pRow.id) {
            docPatch.projectId = pRow.id;
            curMd = { ...curMd, project_hash: cleanH, ...(metadata.project_path ? { project_path: metadata.project_path } : {}) };
            docPatch.metadata = curMd;
          }
        }
      }
      let newTitle = metadata.title ? String(metadata.title).trim() : null;
      let sid = String(metadata.session_id || relativePath.split("/").pop()!.split(".")[0] || "").trim();
      if ((!sid || sid === "transcript") && relativePath.includes("brain/")) {
        const bm = /brain\/([0-9a-fA-F-]+)\//.exec(relativePath);
        if (bm) sid = bm[1]!;
      }
      const titleIsJunk = isJunkOrUuidTitle(existingDoc.title, sid);
      let validNew = Boolean(newTitle) && !isJunkOrUuidTitle(newTitle, sid);
      if (params.content && category === "conversation") {
        const aiCand = extractLatestAiTitle(params.content);
        if (aiCand && !isJunkOrUuidTitle(aiCand, sid)) {
          newTitle = aiCand;
          validNew = true;
        }
      }
      if (titleIsJunk && !validNew) {
        const mCand = metadata.name || metadata.first_user_message;
        if (mCand && !isJunkOrUuidTitle(String(mCand), sid)) {
          newTitle = String(mCand).trim().split("\n")[0]!.slice(0, 60);
          validNew = true;
        }
      }
      const parentSid = (params.content ? parentSessionIdFromContent(params.content) : null) || (typeof metadata.parent_session_id === "string" ? metadata.parent_session_id : null);
      if (parentSid) {
        if (curMd.parent_session_id !== parentSid || !curMd.is_subagent) {
          curMd = { ...curMd, parent_session_id: parentSid, is_subagent: true };
          docPatch.metadata = curMd;
        }
        const [pDoc] = await db
          .select({ title: documents.title })
          .from(documents)
          .where(and(eq(documents.toolId, toolId), or(sql`${documents.metadata}->>'session_id' = ${parentSid}`, like(documents.relativePath, `%${parentSid}%`))))
          .limit(1);
        if (pDoc?.title && !isJunkOrUuidTitle(pDoc.title, parentSid)) {
          newTitle = toolId === "codex" ? `审核: ${pDoc.title}` : pDoc.title;
          validNew = true;
        }
      }
      if (validNew && newTitle && (titleIsJunk || ["antigravity", "claude_code", "codex", "workbuddy"].includes(toolId)) && existingDoc.title !== newTitle) {
        docPatch.title = newTitle;
      }
      if (Object.keys(docPatch).length) {
        await db.update(documents).set(docPatch).where(eq(documents.id, existingDoc.id));
      }
      return { id: existingDoc.id, title: docPatch.title ?? existingDoc.title, toolId: existingDoc.toolId, category: existingDoc.category };
    }
  }

  let content = params.content.replaceAll("\u0000", "");
  const sanitized = resanitize(content);
  content = sanitized.text;
  const hadSensitive = sanitized.hadSensitive;
  if (category !== "conversation") content = stripProfileBlock(content);

  await ensureTool(db, toolId);

  // Project resolution
  let projectId: string | null = null;
  let projectHash = (metadata.project_hash || metadata.project_name) as string | null | undefined;
  let metaProjectPath = (typeof metadata.project_path === "string" ? metadata.project_path : null) as string | null;
  if (isJunkProject(projectHash, metaProjectPath)) {
    projectHash = null;
    metaProjectPath = null;
  }
  const looksLikeHash = Boolean(
    projectHash &&
      (/^[0-9a-f]{8}-/.test(projectHash) ||
        projectHash.includes("--") ||
        /^-?Users-/.test(projectHash) ||
        /^[A-Za-z]--?/.test(projectHash) ||
        /^-?home-/.test(projectHash) ||
        projectHash.length > 20),
  );
  let needsExtract = !projectHash || looksLikeHash || isInvalidProjectName(projectHash);
  let projectPath = metaProjectPath;

  if (needsExtract && content && category === "conversation") {
    const cwdMatch = /"[Cc][Ww][Dd]"\s*:\s*"((?:\\.|[^"\\])+)"/.exec(content.slice(0, 50_000));
    if (cwdMatch) {
      let decodedCwd: string;
      try {
        decodedCwd = String(JSON.parse(`"${cwdMatch[1]}"`));
      } catch {
        decodedCwd = cwdMatch[1]!.replaceAll("\\\\", "/");
      }
      const rawCwd = decodedCwd.replace(/^\\\\?\?\\/, "").replace(/^["'\\` ]+|["'\\` ]+$/g, "");
      const cleanedCwd = cleanSourcePath(rawCwd);
      const cwd = (cleanedCwd || rawCwd).replaceAll("\\", "/").replace(/\/+$/, "").replace(/^["'\\` ]+|["'\\` ]+$/g, "");
      const candHash = cwd.split("/").pop()!.replace(STRIP_EDGE_RE, "");
      if (!isInvalidProjectName(candHash)) {
        projectPath = projectPath || cleanedCwd || rawCwd;
        projectHash = candHash;
        needsExtract = false;
      }
    } else if (looksLikeHash && projectHash) {
      const cand = prettifyProjectName(projectHash);
      if (!isInvalidProjectName(cand)) {
        projectHash = cand;
        needsExtract = false;
      }
    }
  }
  if ((needsExtract || !projectHash || isInvalidProjectName(projectHash)) && relativePath) {
    const parts = relativePath.split("/");
    if (parts.length >= 3 && parts[0] === "projects") {
      const dirH = parts[1]!;
      const cand = prettifyProjectName(dirH);
      if (!isInvalidProjectName(cand)) {
        projectHash = cand;
        if (!projectPath) projectPath = hashToPath(dirH);
        needsExtract = false;
      }
    }
  }
  if (needsExtract && content && toolId === "antigravity" && relativePath.includes("brain")) {
    const [eName, ePath] = extractWorkspaceFromContent(content);
    if (eName && !isInvalidProjectName(eName)) {
      projectHash = eName;
      if (ePath && !projectPath) projectPath = ePath;
    }
  }
  if (projectHash) projectHash = projectHash.replace(/[\x00-\x1f].*/, "").replace(STRIP_EDGE_RE, "");
  if (projectHash && isJunkProject(projectHash, projectPath)) projectHash = null;

  let resolvedProjectTitle: string | null = null;
  if (projectHash) {
    const proj = await ensureProject(db, toolId, projectHash, projectPath ?? metaProjectPath);
    projectId = proj.id;
    resolvedProjectTitle = proj.title;
  }
  if (!projectId) {
    const sid = (metadata.session_id || metadata.cascade_id) as string | undefined;
    if (sid) {
      const [row] = await db
        .select({ projectId: documents.projectId })
        .from(documents)
        .where(and(eq(documents.toolId, toolId), sql`${documents.metadata}->>'session_id' = ${sid}`, sql`${documents.projectId} IS NOT NULL`))
        .limit(1);
      if (row?.projectId) projectId = row.projectId;
    }
  }

  if (projectId && category !== "discovery" && category !== "system") {
    let pName = resolvedProjectTitle;
    if (!pName) {
      const [p] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId)).limit(1);
      pName = p?.title ?? null;
    }
    await dropExcluded(db, userId, machineId, toolId, relativePath, pName, contentHash, offset, endOffset);
  }

  // Existing document lookup (without loading content column)
  const [existing] = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      projectId: documents.projectId,
      machineId: documents.machineId,
      category: documents.category,
      title: documents.title,
      metadata: documents.metadata,
      needsReview: documents.needsReview,
      sourceModifiedAt: documents.sourceModifiedAt,
      syncedAt: documents.syncedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.toolId, toolId),
        eq(documents.relativePath, relativePath),
        machUuid ? or(eq(documents.machineId, machUuid), isNull(documents.machineId)) : sql`true`,
      ),
    )
    .limit(1);

  let title = String(metadata.title ?? relativePath.split("/").pop() ?? "").trim();
  delete metadata.title;
  let sid = String(metadata.session_id || relativePath.split("/").pop()!.split(".")[0] || "").trim();
  if ((!sid || sid === "transcript") && relativePath.includes("brain/")) {
    const bm = /brain\/([0-9a-fA-F-]+)\//.exec(relativePath);
    if (bm) sid = bm[1]!;
  }
  if (sid && !metadata.session_id) metadata.session_id = sid;
  if (toolId === "claude_code" && category === "conversation" && content) {
    Object.assign(metadata, sessionActivity(content));
  }
  let titleIsJunk = isJunkOrUuidTitle(title, sid);
  let detectedParentSid: string | null = null;
  if (category === "conversation") {
    detectedParentSid = (content ? parentSessionIdFromContent(content) : null) || (typeof metadata.parent_session_id === "string" && metadata.parent_session_id.trim() ? metadata.parent_session_id.trim() : null);
    if (detectedParentSid) {
      metadata.parent_session_id = detectedParentSid;
      if (!("is_subagent" in metadata)) metadata.is_subagent = true;
    }
  }
  if (titleIsJunk && content && category === "conversation") {
    if (detectedParentSid) {
      const [pDoc] = await db
        .select({ title: documents.title })
        .from(documents)
        .where(and(eq(documents.toolId, toolId), or(sql`${documents.metadata}->>'session_id' = ${detectedParentSid}`, like(documents.relativePath, `%${detectedParentSid}%`))))
        .limit(1);
      if (pDoc?.title && !isJunkOrUuidTitle(pDoc.title, detectedParentSid)) {
        title = toolId === "codex" ? `审核: ${pDoc.title}` : pDoc.title;
        titleIsJunk = false;
      }
    }
    if (titleIsJunk) {
      const cand = extractLatestAiTitle(content);
      if (cand && !isJunkOrUuidTitle(cand, sid)) {
        title = cand;
        titleIsJunk = false;
      }
    }
    if (titleIsJunk && toolId === "antigravity" && sid) {
      const [ann] = await db
        .select({ title: documents.title, content: documents.content })
        .from(documents)
        .where(and(eq(documents.toolId, "antigravity"), eq(documents.category, "state"), like(documents.relativePath, `%annotations/${sid}.pbtxt`)))
        .limit(1);
      if (ann) {
        let candAnn = ann.title;
        if (!candAnn && ann.content) {
          const m = /title:\s*"([^"]+)"/.exec(ann.content);
          if (m) candAnn = m[1]!.trim();
        }
        if (candAnn && !candAnn.includes("(.*?)") && !candAnn.endsWith(".pbtxt")) {
          if (candAnn.includes("\\")) candAnn = safeDecodePbtxtString(candAnn);
          if (!isJunkOrUuidTitle(candAnn, sid)) {
            title = candAnn;
            titleIsJunk = false;
          }
        }
      }
    }
    if (titleIsJunk && toolId === "antigravity") {
      const reqM = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content.slice(0, 15_000));
      if (reqM) {
        const cand = reqM[1]!.trim().split("\n")[0]!.slice(0, 60);
        if (!isJunkOrUuidTitle(cand, sid)) {
          title = cand;
          titleIsJunk = false;
        }
      }
    }
    if (titleIsJunk) {
      const cand = metadata.name || metadata.first_user_message || metadata.title;
      if (cand) {
        const s = String(cand).trim().split("\n")[0]!.slice(0, 60);
        if (!isJunkOrUuidTitle(s, sid)) {
          title = s;
          titleIsJunk = false;
        }
      }
    }
  }

  let docId: string;
  let finalTitle = title;
  let finalProjectId = projectId;
  let prevTitle: string | null = null;
  let indexUnchanged = false;
  let indexBody: string | null = null;
  const created = !existing;
  let finalMeta = metadata;
  let prevSourceMod: string | null = null;

  if (!existing) {
    docId = randomUUID();
    const srcMod = timestamp ? new Date(timestamp * 1000).toISOString() : nowIso;
    prevSourceMod = srcMod;
    await db.insert(documents).values({
      id: docId,
      toolId,
      projectId,
      machineId: machUuid,
      relativePath,
      category,
      contentType,
      title,
      content,
      contentHash,
      fileSizeBytes: fileSize,
      metadata,
      visibility: "private",
      needsReview: hadSensitive,
      embeddingStatus: "pending",
      embeddingAttempts: 0,
      knowledgeStatus: "pending",
      knowledgeAttempts: 0,
      syncedAt: nowIso,
      sourceModifiedAt: srcMod,
    });
    indexBody = content;
  } else {
    docId = existing.id;
    prevTitle = existing.title;
    prevSourceMod = existing.sourceModifiedAt;
    const patch: Partial<typeof documents.$inferInsert> = {
      contentHash,
      fileSizeBytes: fileSize,
      needsReview: existing.needsReview || hadSensitive,
      syncedAt: nowIso,
    };
    if (existing.category !== category && existing.category === "conversation") patch.category = category;
    if ((EMBED_CATEGORIES as readonly string[]).includes(category)) patch.embeddingStatus = "pending";

    let staged = mode === "delta" && existing.category === "conversation" && (await contentStaging.shouldStage(db, docId));
    let current: string | null = null;
    if (mode === "delta" && !staged) {
      const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
      current = cRow?.content ?? null;
      staged = existing.category === "conversation" && contentStaging.pastIndex(current);
    }
    if (staged) {
      await contentStaging.stageDelta(db, docId, content);
      indexUnchanged = true;
      indexBody = null;
    } else if (mode === "delta") {
      indexUnchanged = Boolean(current) && current!.length >= MAX_INPUT_CHARS;
      const nextContent = contentStaging.appendContent(current, content);
      patch.content = nextContent;
      if (!current) patch.contentS3Key = null;
      indexBody = nextContent;
    } else {
      patch.content = content;
      patch.contentS3Key = null;
      await contentStaging.dropPending(db, docId);
      indexBody = content;
    }

    const keepProject = mode === "delta" && (await hasRealProject(db, existing.projectId));
    const oldMd = (existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<string, unknown>;
    const newMd: Record<string, unknown> = { ...oldMd, ...metadata };
    if (keepProject) {
      for (const k of ["project_path", "project_hash"]) {
        if (k in oldMd) newMd[k] = oldMd[k];
        else delete newMd[k];
      }
    }
    finalMeta = newMd;
    patch.metadata = newMd;
    if (machUuid && !existing.machineId) patch.machineId = machUuid;
    if (title && !isJunkOrUuidTitle(title, sid)) {
      patch.title = title;
      finalTitle = title;
    } else {
      finalTitle = existing.title ?? title;
    }
    finalProjectId = existing.projectId;
    if (projectId && existing.projectId !== projectId && !keepProject) {
      let shouldReplace = true;
      if (existing.projectId) {
        const [oldP] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, existing.projectId)).limit(1);
        const [newP] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId)).limit(1);
        if (oldP && newP) {
          const oldDummy = /^\d+$/.test(oldP.title) || IGNORE_PROJECT_NAMES.has(oldP.title.toLowerCase());
          const newDummy = /^\d+$/.test(newP.title) || IGNORE_PROJECT_NAMES.has(newP.title.toLowerCase());
          if (newDummy && !oldDummy) shouldReplace = false;
        }
      }
      if (shouldReplace) {
        patch.projectId = projectId;
        finalProjectId = projectId;
      }
    }
    await db.update(documents).set(patch).where(eq(documents.id, docId));
    await db.insert(documentVersions).values({ documentId: docId, contentHash, fileSizeBytes: fileSize });
  }

  // Full-text index upsert
  if (!(indexUnchanged && finalTitle === prevTitle)) {
    if (indexBody === null) {
      const [sub] = await db
        .select({ body: sql<string>`substr(${documents.content}, 1, ${MAX_INPUT_CHARS})` })
        .from(documents)
        .where(eq(documents.id, docId))
        .limit(1);
      indexBody = sub?.body ?? "";
    }
    const tsvInput = tokenizeForIndex(`${finalTitle || ""} ${indexBody || ""}`);
    await db.execute(sql`
      INSERT INTO document_search (document_id, content_tsv)
      VALUES (${docId}::uuid, to_tsvector('simple', ${tsvInput}))
      ON CONFLICT (document_id) DO UPDATE SET content_tsv = EXCLUDED.content_tsv
    `);
  }

  // Antigravity annotation propagates title to parent conversation
  if (toolId === "antigravity" && relativePath.includes("annotations")) {
    const annSid = String(metadata.session_id || relativePath.split("/").pop()!.replace(".pbtxt", "")).trim();
    let annTitle = finalTitle && !["transcript", "transcript.jsonl"].includes(finalTitle) && !finalTitle.endsWith(".pbtxt") && !finalTitle.includes("\\") && !finalTitle.includes("(.*?)") ? finalTitle : null;
    if (!annTitle && content) {
      const m = /title:\s*"([^"]+)"/.exec(content);
      if (m) {
        let cand = m[1]!.trim();
        if (cand && !cand.includes("(.*?)") && !cand.endsWith(".pbtxt")) {
          if (cand.includes("\\")) cand = safeDecodePbtxtString(cand);
          if (!isJunkOrUuidTitle(cand, annSid)) annTitle = cand;
        }
      }
    }
    if (annSid && annTitle) {
      await db
        .update(documents)
        .set({ title: annTitle })
        .where(and(eq(documents.toolId, "antigravity"), eq(documents.category, "conversation"), or(sql`${documents.metadata}->>'session_id' = ${annSid}`, like(documents.relativePath, `%${annSid}%`))));
      if (finalTitle !== annTitle) {
        finalTitle = annTitle;
        await db.update(documents).set({ title: annTitle }).where(eq(documents.id, docId));
      }
    }
  }

  if (finalProjectId) {
    await db.update(projects).set({ updatedAt: sql`now()` }).where(eq(projects.id, finalProjectId));
  }

  // Extract conversation messages
  let latestMsg: Date | null = null;
  if (category === "conversation" && (contentType === "jsonl" || (contentType === "json" && toolId === "hermes"))) {
    const complete = endOffset !== null && endOffset >= fileSize;
    if (toolId === "hermes") {
      const msgs = hermesMessagesToStore(content);
      const plan = messageStore.planAlignment(await messageStore.storedRows(db, docId), msgs);
      await messageStore.applyAlignment(db, docId, plan);
      latestMsg = latestTime(msgs);
    } else {
      const msgs = await messageStore.storeSlice(db, docId, (seen) => messagesToStore(content, toolId, seen), mode !== "delta", complete);
      latestMsg = latestTime(msgs);
      const userMsgs = msgs.filter((m) => m.role === "user").slice(0, 25).map((m) => m.content);
      const aiCand = extractLatestAiTitle(content);
      if (aiCand && !isJunkOrUuidTitle(aiCand, sid)) {
        finalTitle = aiCand;
        await db.update(documents).set({ title: aiCand }).where(eq(documents.id, docId));
      } else if (isJunkOrUuidTitle(finalTitle, sid)) {
        const cand = extractCustomTitle(content, sid) || (userMsgs.length ? titleFromUserMessages(userMsgs, sid) : null);
        if (cand) {
          finalTitle = cand;
          await db.update(documents).set({ title: cand }).where(eq(documents.id, docId));
        }
      }
      // Codex history / first_user_message supplement
      const userHistory = Array.isArray(finalMeta.user_history) ? finalMeta.user_history : [];
      if (userHistory.length) {
        const existingRows = await db
          .select({ content: conversationMessages.content })
          .from(conversationMessages)
          .where(and(eq(conversationMessages.documentId, docId), eq(conversationMessages.role, "user")));
        const existingTexts = new Set(existingRows.map((r) => r.content));
        let injected = 0;
        for (const entry of userHistory) {
          if (!entry || typeof entry !== "object") continue;
          const rec = entry as Record<string, unknown>;
          const text = String(rec.text ?? "").trim();
          const tsEpoch = Number(rec.ts ?? 0);
          if (!text || existingTexts.has(text)) continue;
          existingTexts.add(text);
          await db.insert(conversationMessages).values({
            documentId: docId,
            lineNumber: -1000 + injected,
            messageType: "history_user_message",
            role: "user",
            content: text.replaceAll("\u0000", ""),
            metadata: {},
            timestamp: tsEpoch ? new Date(tsEpoch * 1000).toISOString() : null,
          });
          injected++;
        }
      } else if (typeof finalMeta.first_user_message === "string" && finalMeta.first_user_message.trim()) {
        const [exUser] = await db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(and(eq(conversationMessages.documentId, docId), eq(conversationMessages.role, "user")))
          .limit(1);
        if (!exUser) {
          await db.insert(conversationMessages).values({
            documentId: docId,
            lineNumber: 0,
            messageType: "first_user_message",
            role: "user",
            content: finalMeta.first_user_message.trim().replaceAll("\u0000", ""),
            metadata: {},
            timestamp: prevSourceMod || nowIso,
          });
        }
      }
    }
  }

  const nextSourceMod = computeSourceTime(prevSourceMod, category, timestamp, latestMsg, now, created);
  if (nextSourceMod !== undefined) {
    await db.update(documents).set({ sourceModifiedAt: nextSourceMod }).where(eq(documents.id, docId));
  }

  // Tool stats
  const [cntRow] = await db.select({ c: sql<number>`count(*)::int` }).from(documents).where(eq(documents.toolId, toolId));
  await db.update(tools).set({ lastSyncAt: nowIso, totalFiles: Number(cntRow?.c ?? 0) }).where(eq(tools.id, toolId));

  // Sync state
  await updateSyncState(db, toolId, relativePath, contentHash, offset, machineId, endOffset);

  // Bust user caches (best-effort)
  if (userId) {
    const prefixes = [
      `daily:detail:${userId}:`,
      `daily:dates:${userId}:`,
      `dashboard:${userId}:`,
      `memory:stats:${userId}:`,
      `devices:stats:${userId}:`,
      `projects:list:${userId}:`,
      `projects:list:v2:${userId}:`,
      `search:${userId}:`,
    ];
    if (finalProjectId) {
      prefixes.push(
        `project:conv:${userId}:${finalProjectId}:`,
        `project:conv:v2:${userId}:${finalProjectId}:`,
        `project:conv:v3:${userId}:${finalProjectId}:`,
        `project:blueprint:${userId}:${finalProjectId}:`,
        `project:detail:${userId}:${finalProjectId}:`,
        `project:timeline:${userId}:${finalProjectId}:`,
      );
    }
    if (["CODE_BLUEPRINT.md", "PROJECT_BLUEPRINT.md", "BUSINESS_BLUEPRINT.md"].some((f) => relativePath.endsWith(f))) {
      prefixes.push(`project:blueprint:${userId}:`, `project:conv:v3:${userId}:`, `project:detail:${userId}:`, `user:blueprint:v4:${userId}`);
    }
    for (const p of prefixes) await cacheDeletePrefix(redis, p);
  }

  publishEventThrottled("file_synced", { document_id: docId, tool_id: toolId, category, relative_path: relativePath, title: finalTitle }, userId ?? null);
  if (category === "conversation" && sid) {
    scheduleForDocument(db, docId, sid);
  }

  return { id: docId, title: finalTitle, toolId, category };
}
