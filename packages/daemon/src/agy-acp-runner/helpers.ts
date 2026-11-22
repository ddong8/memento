import { existsSync } from "node:fs";

import { sqliteRows } from "../sqlite.js";

export type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
export const clip = (s: string, max: number): string => {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
};

export function clipOutput(text: string, head = 1200, tail = 600): string {
  const t = text.trim();
  if (t.length <= head + tail + 40) return t;
  const lines = t.slice(head, t.length - tail).split("\n").length - 1;
  return `${t.slice(0, head)}\n… 省略 ${t.length - head - tail} 字${lines > 0 ? `（${lines} 行）` : ""} …\n${t.slice(-tail)}`;
}

export function cleanToolOutput(content: string): string {
  return clipOutput(
    content
      .replace(/^(?:Created At|Completed At):[^\n]*\n/gm, "")
      .replace(/\s*If relevant, proactively run terminal commands to execute this code for the USER\. Don't ask for permission\./g, ""),
  );
}

const DETAIL_KEYS = [
  "CommandLine", "Command", "command", "cmd",
  "Path", "AbsolutePath", "TargetFile", "file_path", "path", "filePath", "File",
  "Query", "query", "Pattern", "pattern", "Url", "url",
  "Description", "description", "Prompt", "prompt", "Role", "toolSummary",
];

export function acpToolDetail(name: string, args: Json, fallbackTitle = ""): string {
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return "";
  };
  const join2 = (x: string, y: string, sep = "  ") => [x, y].filter(Boolean).join(sep);
  let d = "";
  switch (name) {
    case "run_command":
      d = first("CommandLine", "Command", "command");
      break;
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item": {
      d = first("Path", "AbsolutePath", "File", "TargetFile", "file_path");
      const from = first("StartLine");
      const to = first("EndLine");
      if (d && from) d += to ? `:${from}-${to}` : `:${from}`;
      break;
    }
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "write_file":
    case "write_to_file":
      d = first("Path", "TargetFile", "AbsolutePath", "File", "file_path");
      break;
    case "list_dir":
      d = first("DirectoryPath", "Path", "path");
      break;
    case "grep_search":
    case "codebase_search":
      d = join2(first("Query", "Pattern", "query", "pattern"), first("SearchPath", "SearchDirectory", "Path"));
      break;
    case "find_by_name":
      d = join2(first("Pattern", "pattern"), first("SearchDirectory", "SearchPath"));
      break;
    case "search_web":
      d = first("query", "Query");
      break;
    case "read_url_content":
    case "view_content_chunk":
      d = first("Url", "url", "DocumentId");
      break;
    case "manage_task":
      d = join2(first("Action"), first("TaskId"), " ");
      break;
    case "schedule": {
      const secs = first("DurationSeconds");
      d = join2(secs ? `${secs}s 后` : "", first("Prompt"), "：");
      break;
    }
    case "invoke_subagent":
      d = join2(first("Role", "TypeName"), first("Prompt"), "：");
      break;
    case "swarm":
      d = join2([first("action"), first("name")].filter(Boolean).join(" "), first("brief", "title"), "：");
      break;
    case "run_workflow":
      d = first("Description", "ScriptPath");
      break;
  }
  if (!d) d = first(...DETAIL_KEYS);
  if (!d && fallbackTitle && fallbackTitle !== `Run ${name}`) d = fallbackTitle;
  return Array.from(d.split("\n")[0]!.replace(/^["']+|["']+$/g, "")).slice(0, 200).join("");
}

export function extractAcpToolOutput(rawOutput: unknown, content?: unknown): string {
  const parts: string[] = [];
  if (typeof rawOutput === "string" && rawOutput.trim()) {
    parts.push(rawOutput.trim());
  } else if (isObj(rawOutput)) {
    const out = rawOutput.output ?? rawOutput.text ?? rawOutput.content ?? rawOutput.stdout;
    if (typeof out === "string" && out.trim()) parts.push(out.trim());
    const err = rawOutput.error;
    if (typeof err === "string" && err.trim()) parts.push(err.trim());
    else if (isObj(err) && typeof err.message === "string" && err.message.trim()) parts.push(err.message.trim());
  }
  if (!parts.length && Array.isArray(content)) {
    for (const item of content) {
      if (isObj(item)) {
        if (typeof item.text === "string" && item.text.trim()) parts.push(item.text.trim());
        else if (isObj(item.content) && typeof item.content.text === "string" && item.content.text.trim()) {
          parts.push(item.content.text.trim());
        }
      }
    }
  }
  return parts.join("\n").trim();
}

export interface AcpModelOption {
  modelId: string;
  name?: string;
}

export interface ResolvedAcpModel {
  modelId?: string;
  applyEffortSeparately: boolean;
  invalidError?: string;
}

export function normalizeAcpEffort(effort: string): string {
  const e = effort.trim().toLowerCase();
  if (e === "max" || e === "extra") return "xhigh";
  if (e === "low" || e === "medium" || e === "high" || e === "xhigh") return e;
  return "";
}

export function resolveAcpModel(
  requestedModel: string,
  requestedEffort: string,
  available: readonly AcpModelOption[],
): ResolvedAcpModel {
  const m = requestedModel.trim();
  const eff = normalizeAcpEffort(requestedEffort);
  if (!m) {
    return { modelId: undefined, applyEffortSeparately: Boolean(eff) };
  }
  if (!available.length) {
    return { modelId: m, applyEffortSeparately: Boolean(eff) };
  }
  const byLower = new Map(available.map((x) => [x.modelId.toLowerCase(), x.modelId]));
  const exact = byLower.get(m.toLowerCase());
  if (exact) {
    const embedsEffort = /-(?:low|medium|high|xhigh)$/i.test(exact);
    if (eff && embedsEffort) {
      const swapped = exact.replace(/-(?:low|medium|high|xhigh)$/i, `-${eff}`);
      const swappedHit = byLower.get(swapped.toLowerCase());
      if (swappedHit) return { modelId: swappedHit, applyEffortSeparately: false };
    }
    return { modelId: exact, applyEffortSeparately: Boolean(eff) && !embedsEffort };
  }
  if (eff) {
    const withEff = byLower.get(`${m}-${eff}`.toLowerCase());
    if (withEff) return { modelId: withEff, applyEffortSeparately: false };
  }
  for (const fallbackEff of ["high", "medium", "low", "xhigh"]) {
    const cand = byLower.get(`${m}-${fallbackEff}`.toLowerCase());
    if (cand) return { modelId: cand, applyEffortSeparately: false };
  }
  return {
    invalidError: `invalid model selection (--model "${m}" --effort "${requestedEffort}"): model ${m} is not recognized as a known model`,
    applyEffortSeparately: false,
  };
}

export interface AcpQuestionItem {
  question: string;
  options: Array<{ label: string; description?: string }>;
  isMultiSelect: boolean;
}

export function parseAskQuestionArgs(args: Json): AcpQuestionItem[] {
  const rawList = Array.isArray(args.questions) ? args.questions : [];
  const items: AcpQuestionItem[] = [];
  for (const q of rawList) {
    if (!isObj(q)) continue;
    const text = str(q.question).trim();
    if (!text) continue;
    const opts: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o === "string" && o.trim()) {
          opts.push({ label: o.trim() });
        } else if (isObj(o)) {
          const label = str(o.label || o.text || o.value).trim();
          const description = str(o.description).trim() || undefined;
          if (label) opts.push(description ? { label, description } : { label });
        }
      }
    }
    items.push({
      question: text,
      options: opts,
      isMultiSelect: q.is_multi_select === true || q.isMultiSelect === true,
    });
  }
  return items;
}

export function formatAskQuestionAnswers(questions: readonly AcpQuestionItem[], answers: readonly string[]): string {
  if (questions.length <= 1) return (answers[0] ?? "").trim();
  return questions.map((q, i) => `${i + 1}. ${q.question}\n${(answers[i] ?? "").trim()}`).join("\n\n");
}

export const AGY_BG_STARTED =
  /(?:Tool is running as a background task with task id|Command running in background with ID|Task running in background with ID):\s*((?:[0-9a-fA-F-]+\/)?task-\d+)/i;

export const AGY_BG_ENDED = [
  "finished with result",
  "The command exited with code",
  "Command exited with code",
  "Timer fired",
  "Timer cancelled",
  "Status: DONE",
  "was canceled",
  "was cancelled",
  "Status: CANCELLED",
  "Status: CANCELED",
  "Status: ERROR",
  "Status: FAILED",
  "failed with result",
];

export function parseBackgroundStart(content: string): { fullId: string; shortId: string; description?: string } | null {
  const m = AGY_BG_STARTED.exec(content);
  if (!m?.[1]) return null;
  const fullId = m[1].trim();
  const shortId = fullId.split("/").pop()!;
  const description = /Task Description:\s*(.+)/i.exec(content)?.[1]?.trim() || undefined;
  return { fullId, shortId, description };
}

export function parseSubagentLaunch(content: string): { conversationId: string; logPath?: string } | null {
  const cidMatch =
    /["']?conversationId["']?\s*[:=]\s*["']?([0-9a-fA-F-]{8,64})/i.exec(content) ??
    /Subagent\s+([0-9a-fA-F-]{8,64})\s+is running/i.exec(content) ??
    /Conversation ID:\s*([0-9a-fA-F-]{8,64})/i.exec(content);
  if (!cidMatch?.[1]) return null;
  let logPath: string | undefined;
  const uriMatch = /["']?logAbsoluteUri["']?\s*[:=]\s*["']?file:\/\/([^"'\s]+)/i.exec(content);
  if (uriMatch?.[1]) {
    let cleaned = decodeURIComponent(uriMatch[1]);
    if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(cleaned)) cleaned = cleaned.slice(1);
    else if (process.platform !== "win32" && !cleaned.startsWith("/")) cleaned = `/${cleaned}`;
    logPath = cleaned;
  }
  return { conversationId: cidMatch[1].trim(), logPath };
}

export function timerSeconds(content: string): number | undefined {
  const m =
    /Task Description:\s*Timer\s*\((\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(content) ??
    /Waiting\s+(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i.exec(content);
  if (!m?.[1] || !m[2]) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = m[2].toLowerCase();
  if (u.startsWith("h")) return n * 3600;
  if (u.startsWith("m")) return n * 60;
  return n;
}

export function unwrapTranscriptArgs(raw: unknown): Json {
  let obj: Json = {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isObj(parsed)) obj = parsed;
    } catch {
      return {};
    }
  } else if (isObj(raw)) {
    obj = { ...raw };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      try {
        const inner = JSON.parse(v) as unknown;
        if (typeof inner === "string") obj[k] = inner;
      } catch {
        // keep as-is
      }
    }
  }
  return obj;
}

export interface AgyConversationState {
  status: string;
  notFullyIdle: boolean;
  stepCount: number;
  killed: boolean;
}

/**
 * Reads the authoritative Cascade engine run state from Google agy CLI's
 * `~/.gemini/antigravity-cli/conversation_summaries.db` (in-process via `node:sqlite`
 * with `sqlite3` CLI fallback). Returns null when the DB or row doesn't exist.
 */
export function readAgyConversationState(dbPath: string, conversationId: string): AgyConversationState | null {
  if (!conversationId || !existsSync(dbPath)) return null;
  const rows = sqliteRows(
    dbPath,
    "SELECT status, not_fully_idle, step_count, killed FROM conversation_summaries WHERE conversation_id = ? LIMIT 1",
    [conversationId],
    1500,
  );
  const row = rows?.[0];
  if (!row) return null;
  const status = str(row[0]).trim();
  const nfiRaw = row[1];
  const notFullyIdle = nfiRaw === 1 || nfiRaw === true || String(nfiRaw).toLowerCase() === "true" || String(nfiRaw) === "1";
  const stepCount = Number(row[2] ?? 0) || 0;
  const killedRaw = row[3];
  const killed = killedRaw === 1 || killedRaw === true || String(killedRaw).toLowerCase() === "true" || String(killedRaw) === "1";
  return { status, notFullyIdle, stepCount, killed };
}

export function isCascadeRunning(state: AgyConversationState | null | undefined): boolean {
  if (!state) return false;
  return /RUNNING|WAITING/i.test(state.status);
}

export function isCascadeIdle(state: AgyConversationState | null | undefined): boolean {
  if (!state) return false;
  return /IDLE|DONE|ERROR|CANCEL/i.test(state.status) && !state.notFullyIdle;
}

export function isAsyncToolName(name: string): boolean {
  return name === "run_command" || name === "schedule" || name === "run_workflow" || name === "bash";
}

export function hasBackgroundEndMarker(content: string): boolean {
  return AGY_BG_ENDED.some((kw) => content.includes(kw));
}

export function isFailedToolOutput(content: string): boolean {
  return /(?:^|\n)\s*(?:The )?command exited with code [1-9]\d*\.?|\bStatus:\s*(?:ERROR|FAILED)\b|failed with result/i.test(content);
}

export function isTransientAgyError(message: string): boolean {
  return /\b(?:attempt\s+\d+|503|429|502|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|overloaded|rate limit|No capacity|temporarily unavailable)\b/i.test(
    message,
  );
}
