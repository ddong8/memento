// 24/7 Proactive Pulse Service: advances missions, auto-generates business blueprints,
// sends morning briefs, evening recaps and device offline alerts (server/server/services/pulse_service.py).
import { and, asc, count, eq, gte, inArray, isNull, lt, ne, notLike, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import {
  conversationMessages,
  correctionEvents,
  correctionTopics,
  documents,
  machines,
  todos,
  userMemories,
  users,
} from "../db/pulled/schema";
import * as aiHealth from "./ai-health";
import { callPlainChat } from "./ai-provider";
import { autoGenerateBusinessBlueprints } from "./business-blueprint";
import { cluster } from "./cluster";
import { wsAlias } from "./device-dispatch";
import type { MachineRow } from "./device-merge";
import { advanceUserMissions } from "./mission-service";
import { notifyUser } from "./notify";
import { CHAT_MESSAGE_SQL, eveningSummaryText, getProactiveSettings as getUserProactiveSettings, isInQuietHours } from "./pulse";
import { userMachineIds } from "./visibility";

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function activeMachines(deps: Deps, userId: string): Promise<MachineRow[]> {
  return deps.db
    .select()
    .from(machines)
    .where(and(eq(machines.userId, userId), isNull(machines.mergedInto), ne(machines.isArchived, true)));
}

function hbMs(m: MachineRow): number | null {
  if (!m.lastHeartbeat) return null;
  const t = Date.parse(m.lastHeartbeat);
  return Number.isNaN(t) ? null : t;
}

function isOnline(m: MachineRow, nowMs: number): boolean {
  const hb = hbMs(m);
  return Boolean(wsAlias(m.collectorTokenHash, m)) || Boolean(hb !== null && nowMs - hb < 180_000);
}

async function sendMorningBrief(deps: Deps, user: UserRow, localDate: Date): Promise<void> {
  const openTodos = await deps.db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, user.id), eq(todos.status, "open")))
    .orderBy(asc(sql`coalesce(${todos.dueAt}, '9999-12-31'::timestamptz)`))
    .limit(5);
  const mList = await activeMachines(deps, user.id);
  const nowMs = Date.now();
  const onlineCount = mList.filter((m) => isOnline(m, nowMs)).length;
  const todoLines = openTodos.map((t) => {
    const due = t.dueAt ? ` (截止: ${String(t.dueAt).slice(5, 16).replace("-", "/").replace("T", " ")})` : "";
    return `- ${t.title}${due}`;
  });
  const todoText = todoLines.length ? todoLines.join("\n") : "暂无逾期待办事项，今天状态很好！";
  const y = localDate.getUTCFullYear();
  const mo = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(localDate.getUTCDate()).padStart(2, "0");
  const prompt = `你是用户的全天候私人 AI 执事。现在是早上，请为用户撰写今日晨间简报。
语气：沉稳、干练、温暖有力量。不要说废话，控制在 100-140 字内。

【今日信息】
日期：${y}年${mo}月${d}日
在线设备数：${onlineCount} 台 (总设备 ${mList.length} 台)
当前未完成待办：
${todoText}

请直接输出晨报正文，适合手机推送阅读：`;

  const body = ((await callPlainChat(deps.settings, deps.redis(), [{ role: "user", content: prompt }], { background: true, user })) || "").trim();
  if (!body) return;
  const pub = deps.settings.publicUrl.replace(/\/+$/, "");
  await notifyUser(deps, user.id, "todo", `🌅 早上好！今日晨间简报 · ${mo}/${d}`, body, {
    url: pub ? `${pub}/daily` : "/daily",
  });
}

async function sendEveningReflection(deps: Deps, user: UserRow, localDate: Date): Promise<void> {
  const now = new Date();
  const localMidnightMs = Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate());
  const dayStartIso = new Date(now.getTime() - (localDate.getTime() - localMidnightMs)).toISOString();
  const nowIso = now.toISOString();

  const mids = await userMachineIds(deps.db, user, deps.settings);
  const [chatsRow] = await deps.db
    .select({ n: sql<number>`count(distinct ${conversationMessages.documentId})::int` })
    .from(conversationMessages)
    .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
    .where(
      and(
        gte(conversationMessages.timestamp, dayStartIso),
        lt(conversationMessages.timestamp, nowIso),
        CHAT_MESSAGE_SQL,
        notLike(documents.relativePath, "%/subagents/%"),
        mids !== null ? (mids.length ? inArray(documents.machineId, mids) : sql`false`) : undefined,
      ),
    );
  const [corrRow] = await deps.db
    .select({
      total: count(),
      repeats: sql<number>`count(*) filter (where ${correctionEvents.alreadyLearned} is true)::int`,
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
    );
  const [memRow] = await deps.db
    .select({ n: count() })
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), gte(userMemories.createdAt, dayStartIso), lt(userMemories.createdAt, nowIso), eq(userMemories.status, "active")));
  const [doneRow] = await deps.db
    .select({ n: count() })
    .from(todos)
    .where(and(eq(todos.userId, user.id), eq(todos.status, "done"), gte(todos.closedAt, dayStartIso), lt(todos.closedAt, nowIso)));
  const [openRow] = await deps.db.select({ n: count() }).from(todos).where(and(eq(todos.userId, user.id), eq(todos.status, "open")));

  const body = eveningSummaryText({
    chats: Number(chatsRow?.n ?? 0),
    memories: Number(memRow?.n ?? 0),
    corrections: Number(corrRow?.total ?? 0),
    repeats: Number(corrRow?.repeats ?? 0),
    todos_done: Number(doneRow?.n ?? 0),
    todos_open: Number(openRow?.n ?? 0),
  });
  if (!body) return;
  const mo = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(localDate.getUTCDate()).padStart(2, "0");
  const pub = deps.settings.publicUrl.replace(/\/+$/, "");
  await notifyUser(deps, user.id, "learning", `🌙 今日复盘 · ${mo}/${d}`, body, {
    url: pub ? `${pub}/daily` : "/daily",
  });
}

async function checkDeviceAlerts(deps: Deps, user: UserRow, nowMs: number): Promise<void> {
  const pub = deps.settings.publicUrl.replace(/\/+$/, "");
  for (const m of await activeMachines(deps, user.id)) {
    const hb = hbMs(m);
    if (hb === null) continue;
    const diffSec = (nowMs - hb) / 1000;
    if (!(diffSec > 300 && diffSec < 900)) continue;
    if (wsAlias(m.collectorTokenHash, m)) continue;
    const key = `alert:device_offline:${m.id}:${Math.floor(hb / 1000)}`;
    if (await aiHealth.getJson(deps.redis(), key)) continue;
    await aiHealth.putJson(deps.redis(), key, { alerted_at: new Date(nowMs).toISOString() }, 24 * 3600);
    await notifyUser(
      deps,
      user.id,
      "health",
      "⚠️ 设备离线提醒",
      `终端设备「${m.name}」已超过 5 分钟未上报心跳，部分后台任务可能挂起。`,
      { url: pub ? `${pub}/profile?tab=devices` : "/profile?tab=devices" },
    ).catch(() => {});
  }
}

async function pulseUser(deps: Deps, user: UserRow, nowMs: number): Promise<void> {
  const prefs = getUserProactiveSettings(user);
  if (prefs.enabled === false) return;
  const offsetHours = Number(prefs.timezone_offset_hours ?? 8);
  const localDate = new Date(nowMs + offsetHours * 3600_000);
  const dateStr = localDate.toISOString().slice(0, 10);
  const timeStr = localDate.toISOString().slice(11, 16);

  await advanceUserMissions(deps, user.id);

  try {
    if (await aiHealth.claimAlert(deps.redis(), `business-blueprint-auto-pass:${user.id}`, 3600)) {
      await autoGenerateBusinessBlueprints(deps, user);
    }
  } catch {
    /* non-blocking */
  }

  if (isInQuietHours(localDate, String(prefs.quiet_hours_start || "23:30"), String(prefs.quiet_hours_end || "07:30"))) {
    return;
  }

  if (prefs.morning_brief_enabled !== false) {
    const target = String(prefs.morning_brief_time || "08:30");
    if (timeStr >= target && timeStr <= "11:30") {
      const key = `proactive:morning:${user.id}:${dateStr}`;
      if (!(await aiHealth.getJson(deps.redis(), key))) {
        await aiHealth.putJson(deps.redis(), key, { sent_at: new Date(nowMs).toISOString() });
        await sendMorningBrief(deps, user, localDate).catch(() => {});
      }
    }
  }

  if (prefs.evening_reflection_enabled !== false) {
    const target = String(prefs.evening_reflection_time || "22:30");
    if (timeStr >= target && timeStr <= "23:59") {
      const key = `proactive:evening:${user.id}:${dateStr}`;
      if (!(await aiHealth.getJson(deps.redis(), key))) {
        await aiHealth.putJson(deps.redis(), key, { sent_at: new Date(nowMs).toISOString() });
        await sendEveningReflection(deps, user, localDate).catch(() => {});
      }
    }
  }

  if (prefs.device_alert_enabled !== false) {
    await checkDeviceAlerts(deps, user, nowMs);
  }
}

async function executePulseCycle(deps: Deps): Promise<void> {
  const userRows = await deps.db.select().from(users).where(inArray(users.status, ["active", "pending"]));
  const nowMs = Date.now();
  for (const user of userRows) {
    try {
      await pulseUser(deps, user, nowMs);
    } catch {
      /* user isolation */
    }
  }
}

export function startProactivePulse(deps: Deps): void {
  if (running || !deps.settings.enableScheduler) return;
  running = true;
  const schedule = (delayMs: number) => {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        if (await cluster.holdLease("pulse", 120)) {
          await executePulseCycle(deps);
        }
      } catch {
        /* ignore */
      } finally {
        schedule(60_000);
      }
    }, delayMs);
    timer.unref?.();
  };
  schedule(15_000);
}

export function stopProactivePulse(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
