// Merge CLI/IDE transcripts (ConversationMessage) into AskConversation.turns
// (server/server/services/session_timeline.py).
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { withoutNul, type Db } from "../db/client";
import { askConversations, conversationMessages, documents, machines } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { isJunkOrUuidTitle, stripInjectedContext } from "./ingest-service";
import { cleanText } from "./session-compactor";

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
  line_number?: number;
  thinking?: string;
  steps?: Record<string, unknown>[];
  images?: string[];
  duration_ms?: number | null;
  task_id?: string | null;
  agent_session_id?: string | null;
  [k: string]: unknown;
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

function parseToolCall(content: string, meta: Record<string, unknown>): Record<string, unknown> {
  const toolName = String(meta.tool_name || content.replace(/^\[Tool:\s*|^\[|\]$/g, "").split("\n")[0] || "tool").trim();
  let detail = typeof meta.tool_input === "string" ? meta.tool_input : meta.tool_input ? JSON.stringify(meta.tool_input) : "";
  if (!detail && content.includes("\n")) detail = content.slice(content.indexOf("\n") + 1);
  return {
    type: "tool_call",
    tool: toolName,
    name: toolName,
    detail: detail.slice(0, TOOL_DETAIL_MAX),
  };
}

export function foldExchange(msgs: RawMessageRow[]): TimelineTurn[] {
  const turns: TimelineTurn[] = [];
  let curAssistant: TimelineTurn | null = null;
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
    };
    if (assistLine !== undefined) turn.line_number = assistLine;
    if (thinking) turn.thinking = thinking;
    if (stepsBuf.length) turn.steps = stepsBuf;
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
        const body = raw.slice("[Result]".length).trim();
        if (stepsBuf.length) {
          const last = stepsBuf[stepsBuf.length - 1]!;
          if (!last.output) last.output = body.slice(0, TOOL_OUTPUT_MAX);
        } else {
          stepsBuf.push({ type: "tool_result", output: body.slice(0, TOOL_OUTPUT_MAX) });
        }
        continue;
      }
      flushAssistant();
      const cleaned = stripInjectedContext(raw).trim();
      if (!cleaned) continue;
      turns.push({ role: "user", content: cleaned, created_at: ts, line_number: m.lineNumber });
      continue;
    }

    if (role === "tool") {
      if (mtype === "tool_call") {
        if (!assistTs) assistTs = ts;
        if (assistLine === undefined) assistLine = m.lineNumber;
        stepsBuf.push(parseToolCall(raw, meta));
      } else {
        const body = raw.slice(0, TOOL_OUTPUT_MAX);
        if (stepsBuf.length && !stepsBuf[stepsBuf.length - 1]!.output) {
          stepsBuf[stepsBuf.length - 1]!.output = body;
        } else {
          stepsBuf.push({ type: "tool_result", output: body });
        }
      }
      continue;
    }

    if (role === "assistant") {
      if (!assistTs) assistTs = ts;
      if (assistLine === undefined) assistLine = m.lineNumber;
      if (THINKING_TYPES.has(mtype)) {
        if (raw.trim()) thinkingBuf.push(raw.trim());
        continue;
      }
      if (meta.tool_name) {
        stepsBuf.push(parseToolCall(raw, meta));
      }
      const parts = raw.split(/\[Tool: ([^\]]+)\]\n?/);
      const lead = parts[0]?.trim();
      if (lead) textBuf.push(lead);
      for (let i = 1; i < parts.length - 1; i += 2) {
        stepsBuf.push({ type: "tool_call", tool: parts[i]!.trim(), name: parts[i]!.trim(), detail: (parts[i + 1] || "").slice(0, TOOL_DETAIL_MAX) });
      }
      curAssistant = { role: "assistant", content: "" };
    }
  }
  if (curAssistant || textBuf.length || thinkingBuf.length || stepsBuf.length) flushAssistant();
  return turns;
}

export function messagesToTurns(msgs: RawMessageRow[]): TimelineTurn[] {
  return foldExchange(msgs);
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
      if ((inc.content?.length ?? 0) > (cur.content?.length ?? 0) || ((inc.steps?.length ?? 0) > (cur.steps?.length ?? 0))) {
        merged[idx] = { ...cur, ...inc, images: cur.images ?? inc.images, task_id: cur.task_id ?? inc.task_id };
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
          const betterSteps = (nextInc.steps?.length ?? 0) > (nextCur.steps?.length ?? 0);
          if (betterContent || betterSteps) {
            merged[match.idx + 1] = {
              ...nextCur,
              ...(betterContent ? { content: nextInc.content } : {}),
              ...(betterSteps ? { steps: nextInc.steps } : {}),
              ...(nextInc.thinking && !nextCur.thinking ? { thinking: nextInc.thinking } : {}),
              line_number: nextInc.line_number ?? nextCur.line_number,
            };
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
  opts: { docId?: string | null; sessionId?: string | null; machineId?: string | null } = {},
): Promise<boolean> {
  const [conv] = await db.select().from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  if (!conv) return false;
  const cfg = (conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>;
  const sid = opts.sessionId || (typeof cfg.session_id === "string" ? cfg.session_id : null) || (typeof cfg.agent_session_id === "string" ? cfg.agent_session_id : null);

  let docId = opts.docId ?? (typeof cfg.document_id === "string" ? cfg.document_id : null);
  let docTitle: string | null = null;
  let docHash: string | null = null;

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
      .select({ id: documents.id, title: documents.title, contentHash: documents.contentHash })
      .from(documents)
      .where(and(...conds))
      .orderBy(desc(documents.syncedAt))
      .limit(1);
    if (doc) {
      docId = doc.id;
      docTitle = doc.title;
      docHash = doc.contentHash;
    }
  } else if (docId) {
    const [doc] = await db
      .select({ id: documents.id, title: documents.title, contentHash: documents.contentHash })
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    if (doc) {
      docTitle = doc.title;
      docHash = doc.contentHash;
    }
  }

  if (!docId) return false;
  if (docHash && cfg._timeline_hash === docHash) return false;

  const rows = await db
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
    .orderBy(asc(conversationMessages.lineNumber));

  if (!rows.length) return false;
  const incoming = messagesToTurns(rows);
  const currentTurns = Array.isArray(conv.turns) ? (conv.turns as TimelineTurn[]) : [];
  const { turns: merged, changed } = mergeSession(currentTurns, incoming);

  const hash = docHash || createHash("sha1").update(String(rows.length)).digest("hex");
  const nextCfg = { ...cfg, document_id: docId, _timeline_hash: hash };
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
  return changed;
}

export async function syncQuietly(db: Db, convId: string, opts?: { docId?: string | null; sessionId?: string | null }): Promise<boolean> {
  try {
    return await syncConversation(db, convId, opts);
  } catch {
    return false;
  }
}

const scheduledSyncs = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleForDocument(db: Db, docId: string, sessionId?: string | null): void {
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
          await syncQuietly(db, c.id, { docId, sessionId });
        }
      } catch {
        /* ignore */
      }
    })();
  }, SYNC_DEBOUNCE_MS);
  timer.unref?.();
  scheduledSyncs.set(key, timer);
}
