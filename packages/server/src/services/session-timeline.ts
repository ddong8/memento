// Merge CLI/IDE transcripts (ConversationMessage) into AskConversation.turns
// (server/server/services/session_timeline.py).
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheDeletePrefix } from "../cache";
import { withoutNul, type Db } from "../db/client";
import { askConversations, conversationMessages, documents, machines } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { isJunkOrUuidTitle, stripInjectedContext } from "./ingest-service";
import { cleanText } from "./session-compactor";
import { publishEvent } from "./sse";

export const MERGE_MATCH_WINDOW_MS = 10 * 60 * 1000;
const MERGE_TEXT_SLICE = 80;
const TOOL_OUTPUT_MAX = 4000;
const TOOL_DETAIL_MAX = 4000;
const THINKING_TYPES = new Set(["pb_thinking", "reasoning", "thinking"]);
const SYNC_DEBOUNCE_MS = 400;

export interface RawMessageRow {
  lineNumber: number;
  role: string | null;
  messageType: string | null;
  content: string;
  metadata: unknown;
  timestamp: string | null;
}

export interface TimelineTurn {
  role: string;
  content: string;
  created_at?: string | null;
  started_at?: string | null;
  line_number?: number;
  thinking?: string;
  toolCalls?: Record<string, unknown>[];
  steps?: Record<string, unknown>[];
  sources?: Record<string, unknown>[];
  images?: string[];
  duration_ms?: number | null;
  task_id?: string | null;
  agent_session_id?: string | null;
  model?: string | null;
  execution_mode?: string | null;
  origin?: string;
  origin_line?: number;
  [k: string]: unknown;
}

const BINARY_OF_TOOL: Record<string, string> = {
  claude_code: "claude",
  codex: "codex",
  antigravity: "agy",
  workbuddy: "workbuddy",
};

const TIMELINE_FMT_VERSION = 2;

const TOOL_DETAIL_KEYS = [
  "command",
  "cmd",
  "CommandLine",
  "Command",
  "file_path",
  "notebook_path",
  "path",
  "filePath",
  "file",
  "target_file",
  "TargetFile",
  "AbsolutePath",
  "Path",
  "File",
  "url",
  "Url",
  "query",
  "Query",
  "q",
  "pattern",
  "Pattern",
  "SearchPath",
  "DirectoryPath",
  "description",
  "skill",
  "name",
  "title",
  "prompt",
  "message",
];

function extractToolDetail(rawInput: unknown): string {
  if (!rawInput) return "";
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        return extractToolDetail(parsed);
      } catch {
        /* use raw string */
      }
    }
    return trimmed.slice(0, TOOL_DETAIL_MAX);
  }
  if (typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const rec = rawInput as Record<string, unknown>;
    for (const k of TOOL_DETAIL_KEYS) {
      const v = rec[k];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, TOOL_DETAIL_MAX);
    }
    return JSON.stringify(rec).slice(0, TOOL_DETAIL_MAX);
  }
  return String(rawInput).slice(0, TOOL_DETAIL_MAX);
}

function cleanToolOutput(text: string): { stdout: string; exitCode: number } {
  let rest = (text || "").replace(/\r\n/g, "\n");
  while (true) {
    const m = /^\s*(?:Created At|Completed At):[^\n]*\n?/.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  let exitCode = 0;
  const cm = /^\s*Command exited with code (-?\d+)\.?[^\n]*\n?/.exec(rest);
  if (cm) {
    exitCode = Number(cm[1]);
    rest = rest.slice(cm[0].length).replace(/^\s*Command output:[^\n]*\n?/, "");
  }
  return { stdout: rest.replace(/^\n+/, "").trimEnd(), exitCode };
}

export function stepsToToolCalls(
  steps: Record<string, unknown>[],
  opts: { idPrefix?: string; origin?: string; prompt?: string; stdout?: string } = {},
): Record<string, unknown>[] {
  if (!steps.length) return [];
  const origin = opts.origin || "agent";
  const binary = BINARY_OF_TOOL[origin] ?? origin;
  const idPrefix = opts.idPrefix || `session_${origin}`;
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const name = String(s.name || s.tool || "tool");
    const detail = typeof s.detail === "string" ? s.detail : extractToolDetail(s.args);
    const outRaw = typeof s.output === "string" ? s.output : "";
    const status = s.status === "failed" || (typeof s.exit_code === "number" && s.exit_code !== 0) ? "failed" : "done";
    const ev: Record<string, unknown> = {
      kind: "tool",
      id: `${idPrefix}_${i}`,
      name,
      status,
    };
    if (detail) ev.detail = detail.slice(0, TOOL_DETAIL_MAX);
    if (outRaw) ev.output = outRaw.slice(-TOOL_OUTPUT_MAX);
    if (typeof s.at === "string" && s.at) ev.at = s.at;
    events.push(ev);
  }
  return [
    {
      id: idPrefix,
      tool_call_id: idPrefix,
      name: "run_on_device",
      action: "agent",
      binary,
      args: { action: "agent", binary, prompt: opts.prompt || "" },
      status: "executed",
      result: {
        status: "succeeded",
        exit_code: 0,
        stdout: opts.stdout || "",
        events,
      },
    },
  ];
}

function turnStepCount(t: TimelineTurn | undefined): number {
  if (!t) return 0;
  if (Array.isArray(t.toolCalls) && t.toolCalls.length) {
    let n = 0;
    for (const tc of t.toolCalls) {
      const res = tc && typeof tc === "object" ? ((tc as Record<string, unknown>).result as Record<string, unknown> | undefined) : undefined;
      if (Array.isArray(res?.events) && res.events.length) n += res.events.length;
      else n += 1;
    }
    return n;
  }
  return Array.isArray(t.steps) ? t.steps.length : 0;
}

function normKey(text: string): string {
  const cleaned = cleanText(stripInjectedContext(text || "")).replace(/\s+/g, " ").trim().toLowerCase();
  return cleaned.slice(0, MERGE_TEXT_SLICE);
}

function toMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isNaN(n) ? null : n;
}

function parseToolCall(content: string, meta: Record<string, unknown>, at: string | null): Record<string, unknown> {
  const toolName = String(meta.tool_name || content.replace(/^\[Tool:\s*|^\[|\]$/g, "").split("\n")[0] || "tool").trim();
  let detail = extractToolDetail(meta.tool_input);
  if (!detail && content.includes("\n")) detail = content.slice(content.indexOf("\n") + 1).trim();
  return {
    type: "tool_call",
    tool: toolName,
    name: toolName,
    detail: detail.slice(0, TOOL_DETAIL_MAX),
    ...(at ? { at } : {}),
  };
}

export function foldExchange(msgs: RawMessageRow[], origin = "agent"): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let curAssistant: TimelineTurn | null = null;
  let lastUserPrompt = "";
  let lastUserTs: string | null = null;
  let thinkingBuf: string[] = [];
  let stepsBuf: Record<string, unknown>[] = [];
  let textBuf: string[] = [];
  let assistTs: string | null = null;
  let assistLine: number | undefined;

  const flushAssistant = () => {
    const content = textBuf.join("\n\n").trim();
    const thinking = thinkingBuf.join("\n\n").trim();
    if (!content && !thinking && !stepsBuf.length) {
      curAssistant = null;
      return;
    }
    const turn: TimelineTurn = {
      role: "assistant",
      content: content || (stepsBuf.length ? `已完成 ${stepsBuf.length} 步工具调用。` : ""),
      created_at: assistTs,
      ...(lastUserTs ? { started_at: lastUserTs } : {}),
    };
    if (assistLine !== undefined) turn.line_number = assistLine;
    if (thinking) turn.thinking = thinking;
    if (stepsBuf.length) {
      turn.toolCalls = stepsToToolCalls(stepsBuf, {
        idPrefix: `session_${origin}_${assistLine ?? turns.length}`,
        origin,
        prompt: lastUserPrompt,
        stdout: content,
      });
    }
    turns.push(turn);
    curAssistant = null;
    thinkingBuf = [];
    stepsBuf = [];
    textBuf = [];
    assistTs = null;
    assistLine = undefined;
  };

  for (const m of msgs) {
    const role = (m.role || "").toLowerCase();
    const mtype = (m.messageType || "").toLowerCase();
    const meta = (m.metadata && typeof m.metadata === "object" ? m.metadata : {}) as Record<string, unknown>;
    const raw = m.content || "";
    const ts = pgToIso(m.timestamp);

    if (role === "user") {
      if (raw.startsWith("[Result]")) {
        const cleanedOut = cleanToolOutput(raw.slice("[Result]".length).trim());
        if (stepsBuf.length) {
          const last = stepsBuf[stepsBuf.length - 1]!;
          if (!last.output) {
            last.output = cleanedOut.stdout.slice(-TOOL_OUTPUT_MAX);
            last.exit_code = cleanedOut.exitCode;
            if (cleanedOut.exitCode !== 0) last.status = "failed";
          }
        } else {
          stepsBuf.push({
            type: "tool_result",
            name: "tool",
            output: cleanedOut.stdout.slice(-TOOL_OUTPUT_MAX),
            exit_code: cleanedOut.exitCode,
            status: cleanedOut.exitCode === 0 ? "done" : "failed",
            ...(ts ? { at: ts } : {}),
          });
        }
        continue;
      }
      flushAssistant();
      const cleaned = stripInjectedContext(raw).trim();
      if (!cleaned) continue;
      lastUserPrompt = cleaned;
      lastUserTs = ts;
      turns.push({ role: "user", content: cleaned, created_at: ts, line_number: m.lineNumber });
      continue;
    }

    if (role === "tool") {
      if (mtype === "tool_call" || meta.tool_name) {
        if (!assistTs) assistTs = ts;
        if (assistLine === undefined) assistLine = m.lineNumber;
        stepsBuf.push(parseToolCall(raw, meta, ts));
      } else {
        const cleanedOut = cleanToolOutput(raw);
        if (stepsBuf.length && !stepsBuf[stepsBuf.length - 1]!.output) {
          const last = stepsBuf[stepsBuf.length - 1]!;
          last.output = cleanedOut.stdout.slice(-TOOL_OUTPUT_MAX);
          last.exit_code = cleanedOut.exitCode;
          if (cleanedOut.exitCode !== 0) last.status = "failed";
        } else {
          stepsBuf.push({
            type: "tool_result",
            name: "tool",
            output: cleanedOut.stdout.slice(-TOOL_OUTPUT_MAX),
            exit_code: cleanedOut.exitCode,
            status: cleanedOut.exitCode === 0 ? "done" : "failed",
            ...(ts ? { at: ts } : {}),
          });
        }
      }
      if (ts) assistTs = ts;
      continue;
    }

    if (role === "assistant") {
      if (!assistTs) assistTs = ts;
      else if (ts) assistTs = ts;
      if (assistLine === undefined) assistLine = m.lineNumber;
      const metaThinking = typeof meta.thinking === "string" ? meta.thinking.trim() : "";
      if (metaThinking) thinkingBuf.push(metaThinking);
      if (THINKING_TYPES.has(mtype)) {
        if (raw.trim() && raw.trim() !== metaThinking) thinkingBuf.push(raw.trim());
        continue;
      }
      if (meta.tool_name) {
        stepsBuf.push(parseToolCall(raw, meta, ts));
      }
      const parts = raw.split(/\[Tool: ([^\]]+)\]\n?/);
      const lead = parts[0]?.trim();
      if (lead) textBuf.push(lead);
      for (let i = 1; i < parts.length - 1; i += 2) {
        stepsBuf.push({
          type: "tool_call",
          tool: parts[i]!.trim(),
          name: parts[i]!.trim(),
          detail: (parts[i + 1] || "").slice(0, TOOL_DETAIL_MAX),
          ...(ts ? { at: ts } : {}),
        });
      }
      curAssistant = { role: "assistant", content: "" };
    }
  }
  if (curAssistant || textBuf.length || thinkingBuf.length || stepsBuf.length) flushAssistant();
  return turns;
}

export function messagesToTurns(msgs: RawMessageRow[], origin = "agent"): TimelineTurn[] {
  return foldExchange(msgs, origin);
}

function turnFingerprint(t: TimelineTurn): string {
  const role = t.role || "";
  const key = normKey(t.content || "");
  return `${role}:${key}`;
}

export function dropCopiesOfRun(turns: TimelineTurn[], question: string, answer: string, windowStartMs?: number | null): TimelineTurn[] {
  const qKey = normKey(question);
  const aKey = normKey(answer);
  if (!qKey && !aKey) return turns;
  const out: TimelineTurn[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    const tMs = toMs(t.created_at);
    const inWindow = windowStartMs == null || tMs == null || Math.abs(tMs - windowStartMs) <= MERGE_MATCH_WINDOW_MS;
    if (inWindow && t.role === "user" && qKey && normKey(t.content) === qKey) {
      const next = turns[i + 1];
      if (next && next.role === "assistant" && (!aKey || normKey(next.content) === aKey)) {
        i++;
        continue;
      }
      continue;
    }
    out.push(t);
  }
  return out;
}

export function mergeSession(existingTurns: TimelineTurn[], incomingTurns: TimelineTurn[]): { turns: TimelineTurn[]; changed: boolean } {
  if (!incomingTurns.length) return { turns: existingTurns, changed: false };
  if (!existingTurns.length) return { turns: incomingTurns, changed: true };

  const existingByLine = new Map<number, number>();
  const existingUserKeys: { idx: number; key: string; ms: number | null }[] = [];
  existingTurns.forEach((t, idx) => {
    if (typeof t.line_number === "number") existingByLine.set(t.line_number, idx);
    if (t.role === "user") existingUserKeys.push({ idx, key: normKey(t.content), ms: toMs(t.created_at) });
  });

  const merged = [...existingTurns];
  let changed = false;

  for (let i = 0; i < incomingTurns.length; i++) {
    const inc = incomingTurns[i]!;
    if (typeof inc.line_number === "number" && existingByLine.has(inc.line_number)) {
      const idx = existingByLine.get(inc.line_number)!;
      const cur = merged[idx]!;
      const incSteps = turnStepCount(inc);
      const curSteps = turnStepCount(cur);
      const needsToolCallsUpgrade = Boolean(inc.toolCalls?.length) && !(Array.isArray(cur.toolCalls) && cur.toolCalls.length);
      const needsThinking = Boolean(inc.thinking) && !cur.thinking;
      if ((inc.content?.length ?? 0) > (cur.content?.length ?? 0) || incSteps > curSteps || needsToolCallsUpgrade || needsThinking) {
        const next: TimelineTurn = {
          ...cur,
          ...inc,
          content: (inc.content?.length ?? 0) >= (cur.content?.length ?? 0) ? inc.content : cur.content,
          thinking: cur.thinking || inc.thinking,
          toolCalls: Array.isArray(cur.toolCalls) && cur.toolCalls.length && curSteps >= incSteps ? cur.toolCalls : inc.toolCalls ?? cur.toolCalls,
          images: cur.images ?? inc.images,
          task_id: cur.task_id ?? inc.task_id,
          duration_ms: cur.duration_ms ?? inc.duration_ms,
          agent_session_id: cur.agent_session_id ?? inc.agent_session_id,
        };
        if (next.toolCalls?.length) delete next.steps;
        merged[idx] = next;
        changed = true;
      }
      continue;
    }

    if (inc.role === "user") {
      const key = normKey(inc.content);
      const ms = toMs(inc.created_at);
      const match = existingUserKeys.find(
        (e) => e.key === key && (e.ms === null || ms === null || Math.abs(e.ms - ms) <= MERGE_MATCH_WINDOW_MS),
      );
      if (match) {
        const nextInc = incomingTurns[i + 1];
        const nextCur = merged[match.idx + 1];
        if (nextInc?.role === "assistant" && nextCur?.role === "assistant") {
          const betterContent = (nextInc.content?.length ?? 0) > (nextCur.content?.length ?? 0);
          const incSteps = turnStepCount(nextInc);
          const curSteps = turnStepCount(nextCur);
          const needsToolCallsUpgrade = Boolean(nextInc.toolCalls?.length) && !(Array.isArray(nextCur.toolCalls) && nextCur.toolCalls.length);
          const betterTools = incSteps > curSteps || needsToolCallsUpgrade;
          const betterThinking = Boolean(nextInc.thinking) && !nextCur.thinking;
          if (betterContent || betterTools || betterThinking) {
            const next: TimelineTurn = {
              ...nextCur,
              ...(betterContent ? { content: nextInc.content } : {}),
              ...(betterTools && nextInc.toolCalls?.length ? { toolCalls: nextInc.toolCalls } : {}),
              ...(betterThinking ? { thinking: nextInc.thinking } : {}),
              line_number: nextInc.line_number ?? nextCur.line_number,
            };
            if (next.toolCalls?.length) delete next.steps;
            merged[match.idx + 1] = next;
            changed = true;
          }
          i++;
        }
        continue;
      }
    }

    // Avoid tail duplication by fingerprint
    const fp = turnFingerprint(inc);
    const tailDup = merged.slice(-6).some((t) => turnFingerprint(t) === fp);
    if (tailDup) continue;

    merged.push(inc);
    changed = true;
  }

  return { turns: merged, changed };
}

export async function syncConversation(
  db: Db,
  convId: string,
  opts: { docId?: string | null; sessionId?: string | null; machineId?: string | null; redis?: Redis | null } = {},
): Promise<boolean> {
  // Fast metadata-only precheck: NEVER touch the multi-MB TOASTed `turns` column unless the source doc hash changed.
  const [conv] = await db
    .select({
      id: askConversations.id,
      title: askConversations.title,
      userId: askConversations.userId,
      config: askConversations.config,
    })
    .from(askConversations)
    .where(eq(askConversations.id, convId))
    .limit(1);
  if (!conv) return false;
  const cfg = (conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>;
  const sid = opts.sessionId || (typeof cfg.session_id === "string" ? cfg.session_id : null) || (typeof cfg.agent_session_id === "string" ? cfg.agent_session_id : null);

  let docId = opts.docId ?? (typeof cfg.document_id === "string" ? cfg.document_id : null);
  let docTitle: string | null = null;
  let docHash: string | null = null;
  let docToolId = "agent";

  if (!docId && sid) {
    const conds = [
      eq(documents.category, "conversation"),
      sql`(${documents.metadata}->>'session_id' = ${sid} OR ${documents.metadata}->>'cascade_id' = ${sid} OR ${documents.relativePath} LIKE ${`%${sid}%`})`,
    ];
    if (conv.userId) {
      const mids = (await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, conv.userId))).map((m) => m.id);
      if (mids.length) conds.push(inArray(documents.machineId, mids));
    }
    const [doc] = await db
      .select({ id: documents.id, title: documents.title, contentHash: documents.contentHash, toolId: documents.toolId })
      .from(documents)
      .where(and(...conds))
      .orderBy(desc(documents.syncedAt))
      .limit(1);
    if (doc) {
      docId = doc.id;
      docTitle = doc.title;
      docHash = doc.contentHash;
      docToolId = doc.toolId || "agent";
    }
  } else if (docId) {
    const [doc] = await db
      .select({ id: documents.id, title: documents.title, contentHash: documents.contentHash, toolId: documents.toolId })
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    if (doc) {
      docTitle = doc.title;
      docHash = doc.contentHash;
      docToolId = doc.toolId || "agent";
    }
  }

  if (!docId) return false;
  if (docHash && cfg._timeline_hash === docHash && cfg._timeline_fmt === TIMELINE_FMT_VERSION) return false;

  const [rows, fullConvRows] = await Promise.all([
    db
      .select({
        lineNumber: conversationMessages.lineNumber,
        role: conversationMessages.role,
        messageType: conversationMessages.messageType,
        content: conversationMessages.content,
        metadata: conversationMessages.metadata,
        timestamp: conversationMessages.timestamp,
      })
      .from(conversationMessages)
      .where(eq(conversationMessages.documentId, docId))
      .orderBy(asc(conversationMessages.lineNumber)),
    db.select({ turns: askConversations.turns }).from(askConversations).where(eq(askConversations.id, convId)).limit(1),
  ]);

  if (!rows.length) return false;
  const incoming = messagesToTurns(rows, docToolId);
  const currentTurns = Array.isArray(fullConvRows[0]?.turns) ? (fullConvRows[0]!.turns as TimelineTurn[]) : [];
  const { turns: merged, changed } = mergeSession(currentTurns, incoming);

  const hash = docHash || createHash("sha1").update(String(rows.length)).digest("hex");
  const nextCfg = { ...cfg, document_id: docId, _timeline_hash: hash, _timeline_fmt: TIMELINE_FMT_VERSION };
  const patch: Partial<typeof askConversations.$inferInsert> = { config: withoutNul(nextCfg) };

  if (changed) {
    patch.turns = withoutNul(merged);
    patch.messageCount = merged.length;
    patch.updatedAt = new Date().toISOString();
  }
  if (docTitle && !isJunkOrUuidTitle(docTitle, sid) && (isJunkOrUuidTitle(conv.title, sid) || conv.title === "新对话")) {
    patch.title = docTitle.slice(0, 500);
  }

  await db.update(askConversations).set(patch).where(eq(askConversations.id, convId));
  if (changed && conv.userId) {
    if (opts.redis) {
      await cacheDeletePrefix(opts.redis, `ask_conv_list:${conv.userId}:`).catch(() => {});
    }
    publishEvent("ask_conversation_synced", { conversation_id: convId }, conv.userId);
  }
  return changed;
}

export async function syncQuietly(
  db: Db,
  convId: string,
  opts?: { docId?: string | null; sessionId?: string | null; redis?: Redis | null },
): Promise<boolean> {
  try {
    return await syncConversation(db, convId, opts);
  } catch {
    return false;
  }
}

const scheduledSyncs = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleForDocument(db: Db, docId: string, sessionId?: string | null, redis?: Redis | null): void {
  if (!sessionId) return;
  const key = `${docId}:${sessionId}`;
  const prev = scheduledSyncs.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    scheduledSyncs.delete(key);
    void (async () => {
      try {
        const convs = await db
          .select({ id: askConversations.id })
          .from(askConversations)
          .where(
            sql`(${askConversations.config}->>'session_id' = ${sessionId} OR ${askConversations.config}->>'agent_session_id' = ${sessionId} OR ${askConversations.config}->>'document_id' = ${docId})`,
          )
          .limit(5);
        for (const c of convs) {
          await syncQuietly(db, c.id, { docId, sessionId, redis });
        }
      } catch {
        /* ignore */
      }
    })();
  }, SYNC_DEBOUNCE_MS);
  timer.unref?.();
  scheduledSyncs.set(key, timer);
}
