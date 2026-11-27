// Proactive agent settings, morning brief & evening reflection helpers (server/server/services/pulse_service.py).
import { and, count, countDistinct, eq, gte, inArray, isNull, lt, ne, notLike, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import {
  conversationMessages,
  correctionEvents,
  correctionTopics,
  documents,
  machines,
  todos,
  userMemories,
} from "../db/pulled/schema";
import { callPlainChat } from "./ai-provider";
import { notifyUser } from "./notify";
import { userMachineIds } from "./visibility";

export const CHAT_MESSAGE_SQL = sql`(${conversationMessages.role} IN ('user', 'assistant') AND ${conversationMessages.content} NOT LIKE '[Result]%' AND ${conversationMessages.content} NOT LIKE '[Tool:%' AND ${conversationMessages.timestamp} IS NOT NULL)`;

export const DEFAULT_PROACTIVE_SETTINGS = {
  enabled: true,
  morning_brief_enabled: true,
  morning_brief_time: "08:30",
  evening_reflection_enabled: true,
  evening_reflection_time: "22:30",
  device_alert_enabled: true,
  quiet_hours_start: "23:30",
  quiet_hours_end: "07:30",
  timezone_offset_hours: 8,
  auto_approve_safe: true,
};

export function getProactiveSettings(user: Pick<UserRow, "proactiveSettings">): Record<string, unknown> {
  const raw = user.proactiveSettings && typeof user.proactiveSettings === "object" && !Array.isArray(user.proactiveSettings)
    ? (user.proactiveSettings as Record<string, unknown>)
    : {};
  return { ...DEFAULT_PROACTIVE_SETTINGS, ...raw };
}

export function isInQuietHours(userLocalDate: Date, quietStart: string, quietEnd: string): boolean {
  try {
    const [sh, sm] = quietStart.split(":").map(Number);
    const [eh, em] = quietEnd.split(":").map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) return false;
    const curr = userLocalDate.getUTCHours() * 60 + userLocalDate.getUTCMinutes();
    const start = sh! * 60 + sm!;
    const end = eh! * 60 + em!;
    return start <= end ? start <= curr && curr <= end : curr >= start || curr <= end;
  } catch {
    return false;
  }
}

export function eveningSummaryText(stats: {
  chats: number;
  memories: number;
  corrections: number;
  repeats: number;
  todos_done: number;
  todos_open: number;
}): string | null {
  const parts: string[] = [];
  if (stats.chats) parts.push(`今天在 ${stats.chats} 个会话里工作`);
  if (stats.memories) parts.push(`新记下 ${stats.memories} 条记忆`);
  if (stats.corrections) {
    const repeats = stats.repeats ? `（其中 ${stats.repeats} 次是学过还犯）` : "";
    parts.push(`纠正了 AI ${stats.corrections} 次${repeats}`);
  }
  if (stats.todos_done) parts.push(`完成 ${stats.todos_done} 条待办`);
  if (!parts.length) return null;
  if (stats.todos_open) parts.push(`还有 ${stats.todos_open} 条待办没做完`);
  return `${parts.join("；")}。凌晨 3 点会把今天的内容整理进长期记忆，并更新画像草稿。`;
}

export async function sendMorningBrief(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  user: UserRow,
  userNowLocal: Date,
): Promise<void> {
  const openTodos = await deps.db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, user.id), eq(todos.status, "open")))
    .orderBy(sql`${todos.dueAt} ASC NULLS LAST`)
    .limit(5);

  const activeMachines = await deps.db
    .select()
    .from(machines)
    .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), ne(machines.isArchived, true)));

  const nowMs = Date.now();
  const onlineCount = activeMachines.filter((m) => {
    if (!m.lastHeartbeat) return false;
    const hb = Date.parse(m.lastHeartbeat.includes("T") ? m.lastHeartbeat : m.lastHeartbeat.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    return Number.isFinite(hb) && (nowMs - hb) / 1000 < 180;
  }).length;

  const todoLines = openTodos.map((t) => {
    let due = "";
    if (t.dueAt) {
      const d = new Date(Date.parse(t.dueAt.includes("T") ? t.dueAt : t.dueAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")));
      if (Number.isFinite(d.getTime())) {
        due = ` (截止: ${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")})`;
      }
    }
    return `- ${t.title}${due}`;
  });
  const todoText = todoLines.length ? todoLines.join("\n") : "暂无逾期待办事项，今天状态很好！";
  const y = userNowLocal.getUTCFullYear();
  const mo = String(userNowLocal.getUTCMonth() + 1).padStart(2, "0");
  const da = String(userNowLocal.getUTCDate()).padStart(2, "0");

  const prompt =
    `你是用户的全天候私人 AI 执事。现在是早上，请为用户撰写今日晨间简报。\n` +
    `语气：沉稳、干练、温暖有力量。不要说废话，控制在 100-140 字内。\n\n` +
    `【今日信息】\n日期：${y}年${mo}月${da}日\n在线设备数：${onlineCount} 台 (总设备 ${activeMachines.length} 台)\n` +
    `当前未完成待办：\n${todoText}\n\n请直接输出晨报正文，适合手机推送阅读：`;

  const body = (await callPlainChat(deps.settings, deps.redis(), [{ role: "user", content: prompt }], { background: true, user }))?.trim();
  if (!body) return;
  const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
  await notifyUser(deps, user.id, "todo", `🌅 早上好！今日晨间简报 · ${mo}/${da}`, body, { url: base ? `${base}/daily` : "/daily" });
}

export async function sendEveningReflection(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  user: UserRow,
  userNowLocal: Date,
): Promise<string | null> {
  const now = new Date();
  const localMidnightMs = Date.UTC(userNowLocal.getUTCFullYear(), userNowLocal.getUTCMonth(), userNowLocal.getUTCDate());
  const dayStart = new Date(now.getTime() - (userNowLocal.getTime() - localMidnightMs));
  const dayStartIso = dayStart.toISOString();
  const nowIso = now.toISOString();

  const mids = await userMachineIds(deps.db, user, deps.settings);
  const chatConds: (SQL | undefined)[] = [
    gte(conversationMessages.timestamp, dayStartIso),
    lt(conversationMessages.timestamp, nowIso),
    CHAT_MESSAGE_SQL,
    notLike(documents.relativePath, "%/subagents/%"),
    mids !== null ? (mids.length ? inArray(documents.machineId, mids) : sql`false`) : undefined,
  ];

  const [[chatsRow], [corrRow], [memRow], [doneRow], [openRow]] = await Promise.all([
    deps.db
      .select({ n: countDistinct(conversationMessages.documentId) })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(and(...chatConds)),
    deps.db
      .select({
        total: count(),
        repeats: sql<number>`count(*) filter (where ${correctionEvents.alreadyLearned} IS TRUE)`,
      })
      .from(correctionEvents)
      .innerJoin(correctionTopics, eq(correctionTopics.id, correctionEvents.topicId))
      .where(
        and(
          eq(correctionEvents.userId, user.id),
          gte(correctionEvents.saidAt, dayStartIso),
          lt(correctionEvents.saidAt, nowIso),
          ne(correctionTopics.status, "dismissed"),
        ),
      ),
    deps.db
      .select({ n: count() })
      .from(userMemories)
      .where(
        and(
          eq(userMemories.userId, user.id),
          gte(userMemories.createdAt, dayStartIso),
          lt(userMemories.createdAt, nowIso),
          eq(userMemories.status, "active"),
        ),
      ),
    deps.db
      .select({ n: count() })
      .from(todos)
      .where(
        and(
          eq(todos.userId, user.id),
          eq(todos.status, "done"),
          gte(todos.closedAt, dayStartIso),
          lt(todos.closedAt, nowIso),
        ),
      ),
    deps.db.select({ n: count() }).from(todos).where(and(eq(todos.userId, user.id), eq(todos.status, "open"))),
  ]);

  const body = eveningSummaryText({
    chats: Number(chatsRow?.n ?? 0),
    memories: Number(memRow?.n ?? 0),
    corrections: Number(corrRow?.total ?? 0),
    repeats: Number(corrRow?.repeats ?? 0),
    todos_done: Number(doneRow?.n ?? 0),
    todos_open: Number(openRow?.n ?? 0),
  });
  if (!body) return null;
  const mo = String(userNowLocal.getUTCMonth() + 1).padStart(2, "0");
  const da = String(userNowLocal.getUTCDate()).padStart(2, "0");
  const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
  await notifyUser(deps, user.id, "learning", `🌙 今日复盘 · ${mo}/${da}`, body, { url: base ? `${base}/daily` : "/daily" });
  return body;
}
