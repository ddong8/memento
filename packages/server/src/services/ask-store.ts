// AskConversation persistence, config inference, session reconciliation & orphaned task recovery
// (server/server/services/ask_store.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { askConversations, deviceTasks, machines } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import { cleanSessionId } from "./agent-ids";
import { storeImages } from "./chat-images";
import { isJunkOrUuidTitle } from "./ingest-service";
import { dropCopiesOfRun, stepsToToolCalls, type TimelineTurn } from "./session-timeline";
import { signMediaUrl, signVideoLinksInText } from "./storage";
import { normalizeDeviceName } from "./user-filter";
import { markUsageLimit } from "./agent-limits";

export type AskConversationRow = typeof askConversations.$inferSelect;

const DEFAULT_TITLE = "新对话";

export function storedTurnCount(conv: { messageCount?: number | null; turns?: unknown }): number {
  if (typeof conv.messageCount === "number" && conv.messageCount > 0) return conv.messageCount;
  return Array.isArray(conv.turns) ? conv.turns.length : 0;
}

export async function turnCount(db: Db, convId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`jsonb_array_length(coalesce(${askConversations.turns}, '[]'::jsonb))::int` })
    .from(askConversations)
    .where(eq(askConversations.id, convId))
    .limit(1);
  return Number(row?.n ?? 0);
}

export async function tailTurns(db: Db, convId: string, limit: number): Promise<TimelineTurn[]> {
  if (limit <= 0) return [];
  const rows = (await db.execute(sql`
    SELECT elem FROM (
      SELECT elem, ord
      FROM ask_conversations, jsonb_array_elements(coalesce(turns, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      WHERE id = ${convId}::uuid
      ORDER BY ord DESC
      LIMIT ${limit}
    ) sub ORDER BY ord ASC
  `)) as unknown as { elem: TimelineTurn }[];
  return rows.map((r) => r.elem);
}

export async function sliceTurns(db: Db, convId: string, before: number | null, limit: number): Promise<{ turns: TimelineTurn[]; total: number; hasMore: boolean; nextBefore: number | null }> {
  const total = await turnCount(db, convId);
  const end = before !== null ? Math.min(Math.max(0, before), total) : total;
  const start = Math.max(0, end - limit);
  if (end <= start) return { turns: [], total, hasMore: false, nextBefore: null };
  const rows = (await db.execute(sql`
    SELECT elem
    FROM ask_conversations, jsonb_array_elements(coalesce(turns, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    WHERE id = ${convId}::uuid AND ord > ${start} AND ord <= ${end}
    ORDER BY ord ASC
  `)) as unknown as { elem: TimelineTurn }[];
  return {
    turns: rows.map((r) => r.elem),
    total,
    hasMore: start > 0,
    nextBefore: start > 0 ? start : null,
  };
}

const MAX_TASK_EVENTS = 800;
const STORED_TASK_EVENTS = 200;
const STORED_EVENT_FIELD_CHARS = 4_000;
const STORED_OUTPUT_CHARS = 40_000;
const SLIM_OUTPUT_CHARS = 20_000;
const RICH_RECENT_TURNS = 40;

export interface AskUserTurnSnippet {
  convId: string;
  title: string;
  projectId: string | null;
  updatedAt: string;
  turnIdx: number;
  content: string;
  createdAt: string | null;
}

/**
 * Lightweight reader for background learning jobs (todos / corrections / dreaming).
 * Step 1 reads only metadata (no TOAST `turns` column) to find updated conversations.
 * Step 2 uses LATERAL jsonb_array_elements inside PostgreSQL to extract ONLY user turns
 * without shipping multi-megabyte assistant toolCalls blobs to Node.js.
 */
export async function fetchAskUserTurnsSince(
  db: Db,
  userId: string,
  sinceIso: string,
  opts: { untilIso?: string | null; maxConvs?: number; maxTurnsPerConv?: number } = {},
): Promise<{ turns: AskUserTurnSnippet[]; convCount: number; latestUpdatedAt: string | null }> {
  const maxConvs = opts.maxConvs ?? 30;
  const maxTurnsPerConv = opts.maxTurnsPerConv ?? 200;
  const untilCond = opts.untilIso ? sql`AND updated_at <= ${opts.untilIso}::timestamptz` : sql``;

  const metaRows = (await db.execute(sql`
    SELECT id::text AS id, title, config->>'project_id' AS project_id, updated_at
    FROM ask_conversations
    WHERE user_id = ${userId}::uuid
      AND updated_at > ${sinceIso}::timestamptz
      ${untilCond}
    ORDER BY updated_at ASC
    LIMIT ${maxConvs}
  `)) as unknown as { id: string; title: string; project_id: string | null; updated_at: string }[];

  if (!metaRows.length) {
    return { turns: [], convCount: 0, latestUpdatedAt: null };
  }

  const latestUpdatedAt = pgToIso(String(metaRows[metaRows.length - 1]!.updated_at)) ?? String(metaRows[metaRows.length - 1]!.updated_at);
  const metaMap = new Map(metaRows.map((m) => [m.id, m]));
  const ids = metaRows.map((m) => m.id);

  const turnRows = (await db.execute(sql`
    SELECT conv_id, turn_idx, content, created_at
    FROM (
      SELECT
        ac.id::text AS conv_id,
        (t.ord - 1)::int AS turn_idx,
        left(t.elem->>'content', 2000) AS content,
        t.elem->>'created_at' AS created_at,
        row_number() OVER (PARTITION BY ac.id ORDER BY t.ord DESC) AS rn
      FROM ask_conversations ac
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(ac.turns, '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      WHERE ac.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        AND t.elem->>'role' = 'user'
        AND coalesce(t.elem->>'origin', '') = ''
        AND length(coalesce(t.elem->>'content', '')) > 0
    ) sub
    WHERE rn <= ${maxTurnsPerConv}
    ORDER BY conv_id, turn_idx ASC
  `)) as unknown as { conv_id: string; turn_idx: number; content: string; created_at: string | null }[];

  const turns: AskUserTurnSnippet[] = [];
  for (const r of turnRows) {
    const m = metaMap.get(r.conv_id);
    if (!m) continue;
    turns.push({
      convId: r.conv_id,
      title: m.title || "",
      projectId: m.project_id ? String(m.project_id) : null,
      updatedAt: pgToIso(String(m.updated_at)) ?? String(m.updated_at),
      turnIdx: Number(r.turn_idx),
      content: String(r.content ?? ""),
      createdAt: r.created_at ? String(r.created_at) : null,
    });
  }

  return { turns, convCount: metaRows.length, latestUpdatedAt };
}

function capEventRecord(ev: unknown): unknown {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return ev;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > STORED_EVENT_FIELD_CHARS) {
      out[k] = `${v.slice(0, STORED_EVENT_FIELD_CHARS)}…[truncated]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function compactToolCallForStorage(tc: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeToolCallEntry(tc);
  const res = sanitized.result;
  if (!res || typeof res !== "object" || Array.isArray(res)) return sanitized;
  const nextRes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(res as Record<string, unknown>)) {
    if (k === "events" && Array.isArray(v)) {
      nextRes[k] = v.slice(-STORED_TASK_EVENTS).map(capEventRecord);
    } else if ((k === "stdout" || k === "stderr" || k === "content") && typeof v === "string" && v.length > STORED_OUTPUT_CHARS) {
      nextRes[k] = v.slice(-STORED_OUTPUT_CHARS);
    } else {
      nextRes[k] = v;
    }
  }
  return { ...sanitized, result: nextRes };
}

export function extractThinkingFromEvents(events: unknown): string {
  if (!Array.isArray(events) || !events.length) return "";
  const parts: string[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const rec = ev as Record<string, unknown>;
    if (rec.kind === "thinking" && typeof rec.text === "string" && rec.text) {
      if (parts.length && parts[parts.length - 1] === rec.text) continue;
      parts.push(rec.text);
    }
  }
  if (!parts.length) return "";
  const allSeparateParagraphs = parts.length > 1 && parts.every((p) => !p.endsWith("\n") && p.length > 24);
  return (allSeparateParagraphs ? parts.join("\n\n") : parts.join("")).trim();
}

export function sanitizeToolCallEntry(tc: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...tc };
  if (copy.args && typeof copy.args === "object" && !Array.isArray(copy.args)) {
    const args = { ...(copy.args as Record<string, unknown>) };
    if ("images" in args) {
      if (Array.isArray(args.images)) {
        args.images = args.images.map((_, i) => `<image attachment ${i + 1}>`);
      } else {
        delete args.images;
      }
    }
    copy.args = args;
  }
  return copy;
}

function slimToolCallEntry(tc: Record<string, unknown>): Record<string, unknown> {
  const res = tc.result;
  if (!res || typeof res !== "object" || Array.isArray(res)) return tc;
  const slimRes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(res as Record<string, unknown>)) {
    if (k === "events") continue;
    if ((k === "stdout" || k === "stderr") && typeof v === "string" && v.length > SLIM_OUTPUT_CHARS) {
      slimRes[k] = v.slice(-SLIM_OUTPUT_CHARS);
    } else {
      slimRes[k] = v;
    }
  }
  return { ...tc, result: slimRes };
}

export function buildToolCallFromDeviceTask(
  task: typeof deviceTasks.$inferSelect,
  deviceName?: string | null,
): { toolCall: Record<string, unknown>; thinking: string } {
  const pl = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  const cleanPl: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pl)) {
    if (k === "images" || k === "system_prompt_append") continue;
    cleanPl[k] = v;
  }
  const callId = `direct_${String(task.id).replaceAll("-", "").slice(0, 8)}`;
  const events = Array.isArray(task.events) ? task.events.slice(-MAX_TASK_EVENTS) : [];
  const devDisplay = deviceName || task.deviceId || "auto";
  const result = markUsageLimit({
    task_id: String(task.id),
    device_id: task.deviceId,
    device_name: devDisplay,
    action: task.action,
    ...(typeof pl.binary === "string" && pl.binary ? { binary: pl.binary } : {}),
    status: task.status,
    exit_code: task.exitCode,
    stdout: task.stdout || "",
    stderr: task.stderr || "",
    error: task.error,
    session_id: task.sessionId,
    alerts: Array.isArray(task.alerts) ? task.alerts : [],
    events,
  });
  const toolCall: Record<string, unknown> = {
    id: callId,
    tool_call_id: callId,
    name: "run_on_device",
    device_name: devDisplay,
    args: cleanPl,
    action: task.action,
    ...(typeof pl.binary === "string" && pl.binary ? { binary: pl.binary } : {}),
    status: result.status === "succeeded" || result.status === "still_running" ? "executed" : "failed",
    result,
  };
  return { toolCall, thinking: extractThinkingFromEvents(events) };
}

export function sanitizeTurnsForResponse(turns: unknown, secretKey?: string): TimelineTurn[] {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t): t is TimelineTurn => Boolean(t && typeof t === "object"))
    .map((t, idx) => {
      const out: TimelineTurn = { ...t };
      if (Array.isArray(out.images)) {
        const imgs = out.images.filter((img): img is string => typeof img === "string" && !img.startsWith("data:")).slice(0, 12);
        out.images = secretKey ? imgs.map((img) => signMediaUrl(img, secretKey)) : imgs;
      }
      if (secretKey && typeof out.content === "string") {
        out.content = signVideoLinksInText(out.content, secretKey);
      }
      if (Array.isArray(out.toolCalls) && out.toolCalls.length) {
        out.toolCalls = out.toolCalls.map((tc) => (tc && typeof tc === "object" ? sanitizeToolCallEntry(tc as Record<string, unknown>) : tc));
      } else if (Array.isArray(out.steps) && out.steps.length) {
        // Legacy TS turns saved with `steps` instead of `toolCalls`: normalize on read so ExecutionCard renders them.
        out.toolCalls = stepsToToolCalls(out.steps, {
          idPrefix: `legacy_${idx}`,
          origin: typeof out.execution_mode === "string" && out.execution_mode ? out.execution_mode : "agent",
          stdout: typeof out.content === "string" ? out.content : "",
        });
      }
      return out;
    });
}

export function extractRealAssistantContent(rawStdout: string | null | undefined, events?: unknown[]): string {
  const stdout = (rawStdout || "").trim();
  if (stdout) return stdout;
  if (!Array.isArray(events) || !events.length) return "";
  const texts: string[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const rec = ev as Record<string, unknown>;
    const t = String(rec.type ?? "");
    if ((t === "text" || t === "delta" || t === "assistant" || t === "message" || t === "result") && typeof rec.text === "string" && rec.text.trim()) {
      texts.push(rec.text.trim());
    } else if (typeof rec.content === "string" && (t === "assistant" || t === "message") && rec.content.trim()) {
      texts.push(rec.content.trim());
    }
  }
  return texts.join("\n\n").trim();
}

export function inferConversationConfig(conv: { deviceId?: string | null; cwd?: string | null; config?: unknown; turns?: unknown }): Record<string, unknown> {
  const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
  if (conv.deviceId && !cfg.device_id) cfg.device_id = conv.deviceId;
  if (conv.cwd && !cfg.cwd) cfg.cwd = conv.cwd;
  const turns = Array.isArray(conv.turns) ? (conv.turns as TimelineTurn[]) : [];
  if (!cfg.session_id && !cfg.agent_session_id) {
    for (let i = turns.length - 1; i >= 0; i--) {
      const sid = cleanSessionId(turns[i]?.agent_session_id);
      if (sid) {
        cfg.session_id = sid;
        break;
      }
    }
  }
  return cfg;
}

export async function resolveConcreteDeviceForConv(
  db: Db,
  user: UserRow,
  requestedDevice: string | null | undefined,
  conv?: { deviceId?: string | null; config?: unknown } | null,
): Promise<{ deviceId: string | null; machineId: string | null; deviceName: string | null }> {
  const raw = (requestedDevice || conv?.deviceId || (conv?.config as Record<string, unknown> | undefined)?.device_id || "") as string;
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed === "auto" || trimmed === "cloud") {
    return { deviceId: null, machineId: null, deviceName: null };
  }
  const userMachines = await db
    .select()
    .from(machines)
    .where(and(eq(machines.userId, user.id), eq(machines.isArchived, false)))
    .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`));

  const normReq = normalizeDeviceName(trimmed);
  for (const m of userMachines) {
    if (
      m.id === trimmed ||
      m.collectorTokenHash === trimmed ||
      m.name === trimmed ||
      normalizeDeviceName(m.name) === normReq
    ) {
      return { deviceId: m.collectorTokenHash || m.name, machineId: m.id, deviceName: m.name };
    }
  }
  return { deviceId: trimmed, machineId: null, deviceName: trimmed };
}

export async function getOrCreateConversation(
  db: Db,
  user: UserRow,
  opts: {
    conversationId?: string | null;
    title?: string | null;
    deviceId?: string | null;
    cwd?: string | null;
    config?: Record<string, unknown> | null;
  } = {},
): Promise<AskConversationRow> {
  const cid = normalizeUuid(opts.conversationId);
  if (cid) {
    const [existing] = await db
      .select()
      .from(askConversations)
      .where(and(eq(askConversations.id, cid), eq(askConversations.userId, user.id)))
      .limit(1);
    if (existing) {
      const nextCfg = {
        ...((existing.config && typeof existing.config === "object" ? existing.config : {}) as Record<string, unknown>),
        ...(opts.config || {}),
      };
      const patch: Partial<typeof askConversations.$inferInsert> = {};
      if (opts.deviceId && opts.deviceId !== existing.deviceId) patch.deviceId = opts.deviceId.slice(0, 255);
      if (opts.cwd && opts.cwd !== existing.cwd) patch.cwd = opts.cwd.slice(0, 500);
      if (opts.config && Object.keys(opts.config).length) patch.config = withoutNul(nextCfg);
      if (Object.keys(patch).length) {
        const [updated] = await db.update(askConversations).set(patch).where(eq(askConversations.id, existing.id)).returning();
        return updated ?? existing;
      }
      return existing;
    }
  }

  const rawTitle = (opts.title || "").trim().split("\n")[0]!.slice(0, 80);
  const title = rawTitle && !isJunkOrUuidTitle(rawTitle) ? rawTitle : DEFAULT_TITLE;
  const nowIso = new Date().toISOString();
  const [created] = await db
    .insert(askConversations)
    .values({
      id: cid ?? randomUUID(),
      userId: user.id,
      title,
      turns: [],
      messageCount: 0,
      deviceId: opts.deviceId?.slice(0, 255) ?? null,
      cwd: opts.cwd?.slice(0, 500) ?? null,
      config: withoutNul(opts.config ?? {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .returning();
  return created!;
}

export async function appendConversationTurns(
  db: Db,
  convId: string,
  opts: {
    settings?: Settings;
    userId?: string | null;
    question: string;
    answer: string;
    thinking?: string | null;
    toolCalls?: Record<string, unknown>[] | null;
    steps?: Record<string, unknown>[] | null;
    sources?: Record<string, unknown>[] | null;
    images?: string[] | null;
    userCreatedAt?: string | null;
    startedAt?: string | null;
    assistantCreatedAt?: string | null;
    durationMs?: number | null;
    taskId?: string | null;
    agentSessionId?: string | null;
    model?: string | null;
    executionMode?: string | null;
    forgetSession?: boolean;
    configPatch?: Record<string, unknown> | null;
    deviceId?: string | null;
    cwd?: string | null;
    titleHint?: string | null;
  },
): Promise<{ assistantCreatedAt: string; messageCount: number }> {
  const [conv] = await db.select().from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  const nowIso = new Date().toISOString();
  const assistantAt = opts.assistantCreatedAt || nowIso;
  if (!conv) return { assistantCreatedAt: assistantAt, messageCount: 0 };

  let storedImgs: string[] | undefined;
  if (opts.images?.length) {
    try {
      const uid = opts.userId || conv.userId;
      storedImgs = opts.settings && uid ? await storeImages(opts.settings, uid, convId, opts.images) : opts.images.filter((s) => !s.startsWith("data:"));
    } catch {
      storedImgs = opts.images.filter((s) => !s.startsWith("data:"));
    }
  }

  const existingTurns = Array.isArray(conv.turns) ? (conv.turns as TimelineTurn[]) : [];
  const startMs = opts.userCreatedAt ? Date.parse(opts.userCreatedAt) : Date.now();
  const baseTurns = dropCopiesOfRun(existingTurns, opts.question, opts.answer, Number.isFinite(startMs) ? startMs : null);

  const cleanToolCalls = Array.isArray(opts.toolCalls) && opts.toolCalls.length
    ? opts.toolCalls.map((tc) => compactToolCallForStorage(tc))
    : Array.isArray(opts.steps) && opts.steps.length
      ? stepsToToolCalls(opts.steps, {
          idPrefix: `run_${randomUUID().slice(0, 8)}`,
          origin: opts.executionMode || "agent",
          prompt: opts.question,
          stdout: opts.answer,
        }).map((tc) => compactToolCallForStorage(tc))
      : [];

  // Keep the most recent RICH_RECENT_TURNS turns intact; slim older historical toolCalls (strip raw events)
  // so long-running conversations never snowball into 100MB+ JSONB blobs.
  const keepRichFrom = Math.max(0, baseTurns.length - RICH_RECENT_TURNS);
  const compactedBase = baseTurns.map((turn, idx) => {
    if (idx >= keepRichFrom || !Array.isArray(turn.toolCalls) || !turn.toolCalls.length) return turn;
    return {
      ...turn,
      toolCalls: turn.toolCalls.map((tc) => (tc && typeof tc === "object" ? slimToolCallEntry(tc as Record<string, unknown>) : tc)),
    };
  });

  const userAt = opts.userCreatedAt || nowIso;
  const userTurn: TimelineTurn = {
    role: "user",
    content: opts.question,
    created_at: userAt,
    ...(storedImgs?.length ? { images: storedImgs } : {}),
  };
  const buildAssistTurn = (calls: Record<string, unknown>[]): TimelineTurn => ({
    role: "assistant",
    content: opts.answer,
    started_at: opts.startedAt || userAt,
    created_at: assistantAt,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(calls.length ? { toolCalls: calls } : {}),
    ...(opts.sources?.length ? { sources: opts.sources } : {}),
    ...(opts.durationMs != null ? { duration_ms: opts.durationMs } : {}),
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ...(opts.agentSessionId ? { agent_session_id: opts.agentSessionId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.executionMode ? { execution_mode: opts.executionMode } : {}),
  });

  const curCfg = (conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>;
  const nextCfg: Record<string, unknown> = {
    ...curCfg,
    ...(opts.configPatch || {}),
    ...(opts.forgetSession
      ? { session_id: "", agent_session_id: "" }
      : opts.agentSessionId
        ? { session_id: opts.agentSessionId, agent_session_id: opts.agentSessionId }
        : {}),
    compact_mode: false,
  };

  let nextTitle = conv.title;
  if (!nextTitle || nextTitle === DEFAULT_TITLE || isJunkOrUuidTitle(nextTitle)) {
    const cand = (opts.titleHint || opts.question || "").trim().split("\n")[0]!.slice(0, 60);
    if (cand && !isJunkOrUuidTitle(cand)) nextTitle = cand;
  }

  const writeTurns = async (calls: Record<string, unknown>[]) => {
    const nextTurns = [...compactedBase, userTurn, buildAssistTurn(calls)];
    await db
      .update(askConversations)
      .set({
        title: nextTitle,
        turns: withoutNul(nextTurns),
        messageCount: nextTurns.length,
        config: withoutNul(nextCfg),
        ...(opts.deviceId ? { deviceId: opts.deviceId.slice(0, 255) } : {}),
        ...(opts.cwd ? { cwd: opts.cwd.slice(0, 500) } : {}),
        updatedAt: nowIso,
      })
      .where(eq(askConversations.id, convId));
    return nextTurns.length;
  };

  try {
    const messageCount = await writeTurns(cleanToolCalls);
    return { assistantCreatedAt: assistantAt, messageCount };
  } catch {
    // Fallback without heavy event logs so the reply itself is never lost.
    const messageCount = await writeTurns(cleanToolCalls.map(slimToolCallEntry));
    return { assistantCreatedAt: assistantAt, messageCount };
  }
}

export async function reconcileSession(db: Db, convId: string, sessionId: string | null | undefined, binary?: string | null): Promise<void> {
  const clean = cleanSessionId(sessionId, binary);
  if (!clean) return;
  const [conv] = await db.select({ config: askConversations.config }).from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  if (!conv) return;
  const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
  if (cfg.session_id === clean && cfg.agent_session_id === clean) return;
  cfg.session_id = clean;
  cfg.agent_session_id = clean;
  await db.update(askConversations).set({ config: withoutNul(cfg) }).where(eq(askConversations.id, convId));
}

export async function recordStoppedOrphans(
  db: Db,
  convId: string,
  taskIds: string[],
  reason = "任务已被用户停止。",
): Promise<void> {
  if (!taskIds.length) return;
  const [conv] = await db.select().from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  if (!conv) return;
  const turns = Array.isArray(conv.turns) ? [...(conv.turns as TimelineTurn[])] : [];
  const recorded = new Set<string>();
  for (const t of turns) {
    if (t.task_id) recorded.add(t.task_id);
    if (Array.isArray(t.toolCalls)) {
      for (const tc of t.toolCalls) {
        const tid = (tc?.result as Record<string, unknown> | undefined)?.task_id;
        if (typeof tid === "string" && tid) recorded.add(tid);
      }
    }
  }
  let changed = false;
  for (const tid of taskIds) {
    if (recorded.has(tid)) continue;
    const [task] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
    if (!task) continue;
    const payload = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
    const prompt = String(payload.user_question || payload.prompt || payload.command || "").trim();
    const out = extractRealAssistantContent(task.stdout, Array.isArray(task.events) ? task.events : []);
    const startIso = pgToIso(task.dispatchedAt || task.createdAt) || new Date().toISOString();
    const endIso = pgToIso(task.finishedAt) || new Date().toISOString();
    const { toolCall, thinking } = buildToolCallFromDeviceTask(task);
    if (prompt) turns.push({ role: "user", content: prompt, created_at: startIso, task_id: tid });
    turns.push({
      role: "assistant",
      content: out ? `${out}\n\n> ⏹ ${reason}` : `⏹ ${reason}`,
      started_at: startIso,
      created_at: endIso,
      ...(thinking ? { thinking } : {}),
      toolCalls: [toolCall],
      task_id: tid,
      ...(task.sessionId ? { agent_session_id: task.sessionId } : {}),
      ...(typeof payload.model === "string" && payload.model ? { model: payload.model } : {}),
      execution_mode: typeof payload.execution_mode === "string" ? payload.execution_mode : typeof payload.binary === "string" ? payload.binary : task.action,
    });
    changed = true;
  }
  if (changed) {
    await db
      .update(askConversations)
      .set({ turns: withoutNul(turns), messageCount: turns.length, updatedAt: new Date().toISOString() })
      .where(eq(askConversations.id, convId));
  }
}

export async function recoverOrphanedTasksForConv(db: Db, convId: string): Promise<number> {
  const [conv] = await db.select().from(askConversations).where(eq(askConversations.id, convId)).limit(1);
  if (!conv) return 0;
  const turns = Array.isArray(conv.turns) ? [...(conv.turns as TimelineTurn[])] : [];
  const existingTaskIds = new Set<string>();
  for (const t of turns) {
    if (t.task_id) existingTaskIds.add(t.task_id);
    if (Array.isArray(t.toolCalls)) {
      for (const tc of t.toolCalls) {
        const tid = (tc?.result as Record<string, unknown> | undefined)?.task_id;
        if (typeof tid === "string" && tid) existingTaskIds.add(tid);
      }
    }
  }

  const tasks = await db
    .select()
    .from(deviceTasks)
    .where(
      and(
        sql`${deviceTasks.payload}->>'conversation_id' = ${convId}`,
        inArray(deviceTasks.status, ["succeeded", "failed", "timeout", "cancelled", "still_running"]),
      ),
    )
    .orderBy(desc(deviceTasks.finishedAt))
    .limit(10);

  let recovered = 0;
  let nextSession: string | null = null;
  for (const t of tasks.reverse()) {
    if (existingTaskIds.has(t.id)) continue;
    const pl = (t.payload && typeof t.payload === "object" ? t.payload : {}) as Record<string, unknown>;
    const prompt = String(pl.user_question || pl.prompt || pl.command || "").trim();
    const answer = extractRealAssistantContent(t.stdout, Array.isArray(t.events) ? t.events : []) || t.error || `任务状态：${t.status}`;
    const startIso = pgToIso(t.dispatchedAt || t.createdAt) || new Date().toISOString();
    const endIso = pgToIso(t.finishedAt) || new Date().toISOString();
    const durMs = Math.max(0, Date.parse(endIso) - Date.parse(startIso));
    const { toolCall, thinking } = buildToolCallFromDeviceTask(t);
    if (prompt && !turns.slice(-4).some((x) => x.role === "user" && x.content.trim() === prompt)) {
      turns.push({ role: "user", content: prompt, created_at: startIso, task_id: t.id });
    }
    turns.push({
      role: "assistant",
      content: answer,
      started_at: startIso,
      created_at: endIso,
      ...(Number.isFinite(durMs) ? { duration_ms: durMs } : {}),
      ...(thinking ? { thinking } : {}),
      toolCalls: [toolCall],
      task_id: t.id,
      ...(t.sessionId ? { agent_session_id: t.sessionId } : {}),
      ...(typeof pl.model === "string" && pl.model ? { model: pl.model } : {}),
      execution_mode: typeof pl.execution_mode === "string" ? pl.execution_mode : typeof pl.binary === "string" ? pl.binary : t.action,
    });
    if (t.sessionId) nextSession = t.sessionId;
    existingTaskIds.add(t.id);
    recovered++;
  }

  if (recovered > 0) {
    const cfg = { ...((conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>) };
    if (nextSession) {
      cfg.session_id = nextSession;
      cfg.agent_session_id = nextSession;
    }
    await db
      .update(askConversations)
      .set({
        turns: withoutNul(turns),
        messageCount: turns.length,
        config: withoutNul(cfg),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(askConversations.id, convId));
  }
  return recovered;
}

export async function recoverFinishedTaskHook(db: Db, taskId: string, watched: boolean): Promise<void> {
  if (watched) return;
  const tid = normalizeUuid(taskId);
  if (!tid) return;
  const [task] = await db.select({ payload: deviceTasks.payload }).from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  const pl = (task?.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  const convId = normalizeUuid(typeof pl.conversation_id === "string" ? pl.conversation_id : null);
  if (convId) await recoverOrphanedTasksForConv(db, convId);
}
