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
import { dropCopiesOfRun, type TimelineTurn } from "./session-timeline";
import { signMediaUrl, signVideoLinksInText } from "./storage";
import { normalizeDeviceName } from "./user-filter";

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

export function sanitizeTurnsForResponse(turns: unknown, secretKey?: string): TimelineTurn[] {
  if (!Array.isArray(turns)) return [];
  return turns
    .filter((t): t is TimelineTurn => Boolean(t && typeof t === "object"))
    .map((t) => {
      const out: TimelineTurn = { ...t };
      if (Array.isArray(out.images)) {
        const imgs = out.images.filter((img): img is string => typeof img === "string" && !img.startsWith("data:")).slice(0, 12);
        out.images = secretKey ? imgs.map((img) => signMediaUrl(img, secretKey)) : imgs;
      }
      if (secretKey && typeof out.content === "string") {
        out.content = signVideoLinksInText(out.content, secretKey);
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
    steps?: Record<string, unknown>[] | null;
    sources?: Record<string, unknown>[] | null;
    images?: string[] | null;
    userCreatedAt?: string | null;
    assistantCreatedAt?: string | null;
    durationMs?: number | null;
    taskId?: string | null;
    agentSessionId?: string | null;
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

  const userTurn: TimelineTurn = {
    role: "user",
    content: opts.question,
    created_at: opts.userCreatedAt || nowIso,
    ...(storedImgs?.length ? { images: storedImgs } : {}),
  };
  const assistTurn: TimelineTurn = {
    role: "assistant",
    content: opts.answer,
    created_at: assistantAt,
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.steps?.length ? { steps: opts.steps } : {}),
    ...(opts.sources?.length ? { sources: opts.sources } : {}),
    ...(opts.durationMs != null ? { duration_ms: opts.durationMs } : {}),
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ...(opts.agentSessionId ? { agent_session_id: opts.agentSessionId } : {}),
  };

  const nextTurns = [...baseTurns, userTurn, assistTurn];
  const curCfg = (conv.config && typeof conv.config === "object" ? conv.config : {}) as Record<string, unknown>;
  const nextCfg: Record<string, unknown> = {
    ...curCfg,
    ...(opts.configPatch || {}),
    ...(opts.agentSessionId ? { session_id: opts.agentSessionId, agent_session_id: opts.agentSessionId } : {}),
    compact_mode: false,
  };

  let nextTitle = conv.title;
  if (!nextTitle || nextTitle === DEFAULT_TITLE || isJunkOrUuidTitle(nextTitle)) {
    const cand = (opts.titleHint || opts.question || "").trim().split("\n")[0]!.slice(0, 60);
    if (cand && !isJunkOrUuidTitle(cand)) nextTitle = cand;
  }

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

  return { assistantCreatedAt: assistantAt, messageCount: nextTurns.length };
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
  const recorded = new Set(turns.map((t) => t.task_id).filter(Boolean));
  let changed = false;
  for (const tid of taskIds) {
    if (recorded.has(tid)) continue;
    const [task] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
    if (!task) continue;
    const payload = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
    const prompt = String(payload.prompt || payload.command || "").trim();
    const out = extractRealAssistantContent(task.stdout, Array.isArray(task.events) ? task.events : []);
    if (prompt) turns.push({ role: "user", content: prompt, created_at: pgToIso(task.createdAt), task_id: tid });
    turns.push({
      role: "assistant",
      content: out ? `${out}\n\n> ⏹ ${reason}` : `⏹ ${reason}`,
      created_at: pgToIso(task.finishedAt) || new Date().toISOString(),
      task_id: tid,
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
  const existingTaskIds = new Set(turns.map((t) => t.task_id).filter(Boolean));

  const tasks = await db
    .select()
    .from(deviceTasks)
    .where(
      and(
        sql`${deviceTasks.payload}->>'conversation_id' = ${convId}`,
        inArray(deviceTasks.status, ["succeeded", "failed", "timeout", "cancelled"]),
      ),
    )
    .orderBy(desc(deviceTasks.finishedAt))
    .limit(10);

  let recovered = 0;
  for (const t of tasks.reverse()) {
    if (existingTaskIds.has(t.id)) continue;
    const pl = (t.payload && typeof t.payload === "object" ? t.payload : {}) as Record<string, unknown>;
    const prompt = String(pl.prompt || pl.command || "").trim();
    const answer = extractRealAssistantContent(t.stdout, Array.isArray(t.events) ? t.events : []) || t.error || `任务状态：${t.status}`;
    if (prompt && !turns.slice(-4).some((x) => x.role === "user" && x.content.trim() === prompt)) {
      turns.push({ role: "user", content: prompt, created_at: pgToIso(t.createdAt), task_id: t.id });
    }
    turns.push({
      role: "assistant",
      content: answer,
      created_at: pgToIso(t.finishedAt) || new Date().toISOString(),
      task_id: t.id,
      ...(t.sessionId ? { agent_session_id: t.sessionId } : {}),
    });
    existingTaskIds.add(t.id);
    recovered++;
  }

  if (recovered > 0) {
    await db
      .update(askConversations)
      .set({ turns: withoutNul(turns), messageCount: turns.length, updatedAt: new Date().toISOString() })
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
