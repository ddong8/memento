// Daily life rhythm, sleep tracking, screen time & AI lifestyle advice (server/server/services/life_service.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, gte, inArray, isNotNull, lte, ne, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { conversationMessages, documents, todos, userLifeRhythms } from "../db/pulled/schema";
import { callChatCompletion, callPlainChat } from "./ai-provider";
import { userMachineIds } from "./visibility";

export type RhythmRow = typeof userLifeRhythms.$inferSelect;

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude Code",
  claude_code: "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  antigravity: "Antigravity",
  trae: "Trae",
  windsurf: "Windsurf",
  terminal: "Terminal",
  iterm2: "iTerm2",
  chatgpt: "ChatGPT",
  codex: "Codex",
  workbuddy: "WorkBuddy",
  pycharm: "PyCharm",
  intellij: "IntelliJ IDEA",
};

const APP_CATEGORIES: Record<string, string> = {
  cursor: "work", vscode: "work", "visual studio code": "work", xcode: "work", pycharm: "work",
  "intellij idea": "work", antigravity: "work", workbuddy: "work", terminal: "work", iterm2: "work",
  notion: "work", obsidian: "work", feishu: "work", lark: "work", slack: "work", dingtalk: "work",
  钉钉: "work", 企业微信: "work", wps: "work", word: "work", excel: "work", chrome: "work",
  "google chrome": "work", arc: "work", edge: "work", "microsoft edge": "work", postman: "work",
  figma: "work", datagrip: "work", docker: "work", chatgpt: "work", claude: "work",
  wechat: "social", 微信: "social", qq: "social", telegram: "social", whatsapp: "social",
  discord: "social", weibo: "social", 微博: "social",
  douyin: "entertainment", 抖音: "entertainment", tiktok: "entertainment", bilibili: "entertainment",
  哔哩哔哩: "entertainment", xiaohongshu: "entertainment", 小红书: "entertainment",
  kuaishou: "entertainment", 快手: "entertainment", youtube: "entertainment",
  "genshin impact": "entertainment", 原神: "entertainment", "honor of kings": "entertainment",
  王者荣耀: "entertainment", steam: "entertainment", netflix: "entertainment",
  "wechat read": "reading", 微信读书: "reading", kindle: "reading", duolingo: "reading",
  知乎: "reading", zhihu: "reading",
};

const APP_PATTERNS_SORTED = Object.keys(APP_CATEGORIES).sort((a, b) => b.length - a.length);

export function formatToolName(rawName: string): string {
  const norm = rawName.trim().toLowerCase();
  return TOOL_DISPLAY_NAMES[norm] ?? (rawName.trim() || "开发工具");
}

export function classifyApp(appName: string): string {
  const norm = appName.trim().toLowerCase();
  for (const pat of APP_PATTERNS_SORTED) {
    if (norm.includes(pat)) return APP_CATEGORIES[pat]!;
  }
  return "general";
}

function parsePgUtcMs(ts: string): number {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return Date.parse(iso);
}

export interface AppUsageIn {
  name?: string;
  minutes?: number;
  category?: string;
  icon?: string | null;
}

export async function recordDailyRhythm(
  db: Db,
  redis: Redis | null,
  user: UserRow,
  opts: {
    logDate: string;
    appUsages: AppUsageIn[];
    wakeupTime?: string | null;
    bedtime?: string | null;
    sleepHours?: number | null;
  },
): Promise<RhythmRow> {
  const processed = opts.appUsages.map((item) => {
    const name = String(item.name ?? "Unknown").trim();
    const minutes = Math.trunc(Number(item.minutes ?? 0)) || 0;
    const category = item.category || classifyApp(name);
    return { name, category, minutes, icon: item.icon ?? null };
  });

  let sleepHours = opts.sleepHours ?? null;
  if (opts.wakeupTime && opts.bedtime && sleepHours == null) {
    const bp = opts.bedtime.split(":").map(Number);
    const wp = opts.wakeupTime.split(":").map(Number);
    if (bp.length === 2 && wp.length === 2 && bp.every(Number.isFinite) && wp.every(Number.isFinite)) {
      const bTot = bp[0]! * 60 + bp[1]!;
      const wTot = wp[0]! * 60 + wp[1]!;
      const dur = wTot < bTot ? 1440 - bTot + wTot : wTot - bTot;
      sleepHours = Math.round((dur / 60) * 10) / 10;
    }
  }

  const [existing] = await db
    .select()
    .from(userLifeRhythms)
    .where(and(eq(userLifeRhythms.userId, user.id), eq(userLifeRhythms.logDate, opts.logDate)))
    .limit(1);

  let record: RhythmRow;
  if (existing) {
    const appMap = new Map<string, Record<string, unknown>>();
    if (Array.isArray(existing.appUsages)) {
      for (const old of existing.appUsages as Record<string, unknown>[]) {
        if (old && typeof old === "object" && typeof old.name === "string" && old.name) {
          appMap.set(old.name, { ...old });
        }
      }
    }
    for (const nu of processed) {
      const prev = appMap.get(nu.name);
      if (prev) {
        prev.minutes = Math.max(Math.trunc(Number(prev.minutes ?? 0)), nu.minutes);
        if (nu.category) prev.category = nu.category;
      } else {
        appMap.set(nu.name, { ...nu });
      }
    }
    const merged = [...appMap.values()].sort((a, b) => Number(b.minutes ?? 0) - Number(a.minutes ?? 0));
    const totalScreen = merged.reduce((s, a) => s + Math.trunc(Number(a.minutes ?? 0)), 0);
    const prod = merged.filter((a) => a.category === "work" || a.category === "reading").reduce((s, a) => s + Math.trunc(Number(a.minutes ?? 0)), 0);
    const dist = merged.filter((a) => a.category === "entertainment" || a.category === "social").reduce((s, a) => s + Math.trunc(Number(a.minutes ?? 0)), 0);

    const [updated] = await db
      .update(userLifeRhythms)
      .set({
        ...(opts.wakeupTime ? { wakeupTime: opts.wakeupTime } : {}),
        ...(opts.bedtime ? { bedtime: opts.bedtime } : {}),
        ...(sleepHours !== null ? { sleepHours } : {}),
        totalScreenMinutes: totalScreen,
        productiveMinutes: prod,
        distractionMinutes: dist,
        appUsages: withoutNul(merged),
        updatedAt: sql`now()` as unknown as string,
      })
      .where(eq(userLifeRhythms.id, existing.id))
      .returning();
    record = updated!;
  } else {
    processed.sort((a, b) => b.minutes - a.minutes);
    const totalScreen = processed.reduce((s, a) => s + a.minutes, 0);
    const prod = processed.filter((a) => a.category === "work" || a.category === "reading").reduce((s, a) => s + a.minutes, 0);
    const dist = processed.filter((a) => a.category === "entertainment" || a.category === "social").reduce((s, a) => s + a.minutes, 0);

    const [inserted] = await db
      .insert(userLifeRhythms)
      .values({
        id: randomUUID(),
        userId: user.id,
        logDate: opts.logDate,
        wakeupTime: opts.wakeupTime ?? null,
        bedtime: opts.bedtime ?? null,
        sleepHours,
        totalScreenMinutes: totalScreen,
        productiveMinutes: prod,
        distractionMinutes: dist,
        appUsages: withoutNul(processed),
      })
      .returning();
    record = inserted!;
  }

  await cacheDeletePrefix(redis, `life:rhythm:${user.id}:`);
  return record;
}

export async function syncRhythmsFromCollector(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  days = 7,
  tzOffset = 0,
): Promise<RhythmRow[]> {
  const mids = await userMachineIds(db, user, settings);
  if (mids !== null && !mids.length) return [];

  const tzDeltaMs = -tzOffset * 60_000;
  const userNow = new Date(Date.now() + tzDeltaMs);
  const startDateMs = Date.UTC(userNow.getUTCFullYear(), userNow.getUTCMonth(), userNow.getUTCDate()) - (days + 2) * 86400_000;
  const startCutoffIso = new Date(startDateMs + 4 * 3600_000 - tzDeltaMs).toISOString();

  const msgConds: (SQL | undefined)[] = [
    gte(conversationMessages.timestamp, startCutoffIso),
    isNotNull(conversationMessages.timestamp),
    ne(documents.toolId, "system"),
    mids !== null ? inArray(documents.machineId, mids) : undefined,
  ];
  const docConds: (SQL | undefined)[] = [
    gte(documents.syncedAt, startCutoffIso),
    isNotNull(documents.syncedAt),
    ne(documents.toolId, "system"),
    mids !== null ? inArray(documents.machineId, mids) : undefined,
  ];

  const [msgRows, docRows] = await Promise.all([
    db
      .select({ ts: conversationMessages.timestamp, tool: documents.toolId })
      .from(conversationMessages)
      .innerJoin(documents, eq(conversationMessages.documentId, documents.id))
      .where(and(...msgConds)),
    db
      .select({ ts: documents.syncedAt, tool: documents.toolId })
      .from(documents)
      .where(and(...docConds)),
  ]);

  const localEvents: { localMs: number; tool: string }[] = [];
  for (const r of msgRows) {
    if (!r.ts) continue;
    const ms = parsePgUtcMs(r.ts);
    if (Number.isFinite(ms)) localEvents.push({ localMs: ms + tzDeltaMs, tool: r.tool || "unknown" });
  }
  for (const r of docRows) {
    if (!r.ts) continue;
    const ms = parsePgUtcMs(r.ts);
    if (Number.isFinite(ms)) localEvents.push({ localMs: ms + tzDeltaMs, tool: r.tool || "unknown" });
  }
  if (!localEvents.length) return [];

  localEvents.sort((a, b) => a.localMs - b.localMs);

  const daysEvents = new Map<string, { localMs: number; tool: string }[]>();
  for (const ev of localEvents) {
    const d = new Date(ev.localMs);
    const workMs = d.getUTCHours() < 4 ? ev.localMs - 86400_000 : ev.localMs;
    const key = new Date(workMs).toISOString().slice(0, 10);
    const list = daysEvents.get(key) ?? [];
    list.push(ev);
    daysEvents.set(key, list);
  }

  const sortedDates = [...daysEvents.keys()].sort();
  const saved: RhythmRow[] = [];
  let lastEventOfPrevDay: number | null = null;
  const SESSION_GAP_MS = 20 * 60_000;
  const BASE_INTERACTION_MINUTES = 3;

  const hhmm = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  };

  for (const wDate of sortedDates) {
    const evs = daysEvents.get(wDate)!;
    if (!evs.length) continue;
    const firstMs = evs[0]!.localMs;
    const lastMs = evs[evs.length - 1]!.localMs;
    let sleepHrs: number | null = null;
    if (lastEventOfPrevDay !== null) {
      const gapHrs = (firstMs - lastEventOfPrevDay) / 3600_000;
      if (gapHrs >= 3 && gapHrs <= 16) sleepHrs = Math.round(gapHrs * 10) / 10;
    }
    lastEventOfPrevDay = lastMs;

    const toolMinutes = new Map<string, number>();
    if (evs.length === 1) {
      toolMinutes.set(formatToolName(evs[0]!.tool), BASE_INTERACTION_MINUTES);
    } else {
      let i = 0;
      while (i < evs.length) {
        const tool = formatToolName(evs[i]!.tool);
        const start = evs[i]!.localMs;
        let end = start;
        while (i + 1 < evs.length && evs[i + 1]!.localMs - end <= SESSION_GAP_MS) {
          i++;
          end = evs[i]!.localMs;
        }
        const dur = Math.max(BASE_INTERACTION_MINUTES, Math.floor((end - start) / 60_000));
        toolMinutes.set(tool, (toolMinutes.get(tool) ?? 0) + dur);
        i++;
      }
    }

    const appUsages = [...toolMinutes.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, minutes]) => ({ name, category: "work", minutes, icon: name.toLowerCase().replaceAll(" ", "") }));

    saved.push(
      await recordDailyRhythm(db, redis, user, {
        logDate: wDate,
        appUsages,
        wakeupTime: hhmm(firstMs),
        bedtime: hhmm(lastMs),
        sleepHours: sleepHrs,
      }),
    );
  }
  return saved;
}

export function rhythmOut(r: RhythmRow) {
  return {
    id: r.id,
    date: r.logDate,
    wakeup_time: r.wakeupTime,
    bedtime: r.bedtime,
    sleep_hours: r.sleepHours,
    total_screen_minutes: r.totalScreenMinutes,
    productive_minutes: r.productiveMinutes,
    distraction_minutes: r.distractionMinutes,
    app_usages: r.appUsages,
    ai_advice: r.aiAdvice,
  };
}

export async function getRecentRhythms(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  days = 7,
  tzOffset = 0,
  syncCollector = true,
) {
  const cacheKey = `life:rhythm:${user.id}:${days}:${tzOffset}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return cached;

  if (syncCollector) {
    const cooldownKey = `life:sync_cooldown:${user.id}:${days}`;
    if ((await cacheGet(redis, cooldownKey)) == null) {
      await syncRhythmsFromCollector(db, settings, redis, user, days, tzOffset).catch(() => {});
      await cacheSet(redis, cooldownKey, "1", 300);
    }
  }

  const userTodayMs = Date.now() - tzOffset * 60_000;
  const startDate = new Date(userTodayMs - days * 86400_000).toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(userLifeRhythms)
    .where(and(eq(userLifeRhythms.userId, user.id), gte(userLifeRhythms.logDate, startDate)))
    .orderBy(desc(userLifeRhythms.logDate));

  const payload = rows.map(rhythmOut);
  await cacheSet(redis, cacheKey, payload, 60);
  return payload;
}

export async function generateLifeDecisionAdvice(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  targetDate: string,
): Promise<string> {
  const minDate = new Date(Date.parse(`${targetDate}T00:00:00Z`) - 7 * 86400_000).toISOString().slice(0, 10);
  const rhythms = await db
    .select()
    .from(userLifeRhythms)
    .where(and(eq(userLifeRhythms.userId, user.id), lte(userLifeRhythms.logDate, targetDate), gte(userLifeRhythms.logDate, minDate)))
    .orderBy(desc(userLifeRhythms.logDate));
  if (!rhythms.length) return "暂无足够的作息与屏幕时间数据供 AI 分析建议。";
  const target = rhythms[0]!;
  const openTodos = await db.select({ title: todos.title }).from(todos).where(and(eq(todos.userId, user.id), eq(todos.status, "open"))).limit(5);
  const todoTitles = openTodos.map((t) => t.title);

  const history = rhythms.map((r) => {
    const apps = Array.isArray(r.appUsages) ? (r.appUsages as { name?: string; minutes?: number }[]) : [];
    const topApps = apps.slice(0, 4).map((a) => `${a.name}(${a.minutes}m)`).join(", ");
    return `- ${r.logDate}: 起床 ${r.wakeupTime || "未知"}, 入睡 ${r.bedtime || "未知"}, 睡眠 ${r.sleepHours ?? "未知"}h, 总屏幕 ${r.totalScreenMinutes}m (工作专注 ${r.productiveMinutes}m, 娱乐社交 ${r.distractionMinutes}m). 主要应用: ${topApps}`;
  });

  const prompt =
    `你是一名世界级的个人精力管理与生活决策 AI 导师。\n` +
    `请根据用户近期的真实作息记录、手机与电脑 App 时间分配以及待办任务，为用户提供极其深刻、真实、具有实际决策指导意义的生活顾问建议。\n\n` +
    `【用户近期作息与屏幕时间数据】\n${history.join("\n")}\n\n` +
    `【当前重要待办事项】\n${todoTitles.length ? JSON.stringify(todoTitles) : "无紧急待办"}\n\n` +
    `请严格按照以下 3 大模块输出专业分析与生活决策建议（语气真诚、客观、直击痛点，拒绝虚头巴脑的客套）：\n` +
    `1) 【作息与精力状态诊断】客观评估睡眠规律度与精力起伏（是否存在晚睡拖延、睡眠债或作息紊乱）；\n` +
    `2) 【时间黑洞与注意力审计】指出吞噬用户时间的典型 App 或碎片化分心时段（量化分析生产力与娱乐比例）；\n` +
    `3) 【生活决策行动指南（今日与明日本周）】给出 2~3 条立即可执行的精准决策（例如：调整就寝时间、晚间电子屏幕断网阈值、根据精力高低峰重排今日关键工作任务、设立专注时段等）。\n\n` +
    `控制在 350 字以内，排版清晰美观：`;

  try {
    const advice = (await callPlainChat(settings, redis, [{ role: "user", content: prompt }], { background: true, user }))?.trim() ?? "";
    await db.update(userLifeRhythms).set({ aiAdvice: advice }).where(eq(userLifeRhythms.id, target.id));
    await cacheDeletePrefix(redis, `life:rhythm:${user.id}:`);
    return advice;
  } catch {
    return "AI 决策建议生成暂不可用，已记录今日基础作息数据。";
  }
}

export async function clearUserRhythms(db: Db, redis: Redis | null, user: UserRow, logDate?: string | null): Promise<number> {
  const conds: (SQL | undefined)[] = [eq(userLifeRhythms.userId, user.id), logDate ? eq(userLifeRhythms.logDate, logDate) : undefined];
  const deleted = await db.delete(userLifeRhythms).where(and(...conds)).returning({ id: userLifeRhythms.id });
  await cacheDeletePrefix(redis, `life:rhythm:${user.id}:`);
  return deleted.length;
}

export async function parseScreenTimeScreenshot(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  imageBase64: string,
) {
  const imageUrl = imageBase64.startsWith("data:image") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
  const prompt =
    "这是一张手机系统的「屏幕使用时间」或应用时长统计截图。\n" +
    "请仔细识别并提取出：\n" +
    "1. 截图对应的日期（如果截图显示今天或未显示年份，请使用当天的 YYYY-MM-DD）；\n" +
    "2. 出现的每个具体的应用名称（App Name）及其实际使用时长（请务必统一换算为整数总分钟数，如 1小时15分 -> 75）；\n" +
    "3. 屏幕总使用时间（换算为分钟数）；\n" +
    "4. 将每个 App 归入类别：work (生产力/工作/研发), social (社交/通讯), entertainment (娱乐/游戏/视频), reading (阅读/图书), general (其他系统工具)。\n\n" +
    "请严格只返回 JSON 格式，不要返回任何额外 Markdown 或说明：\n" +
    '{"log_date": "YYYY-MM-DD", "total_screen_minutes": 180, "app_usages": [{"name": "微信", "minutes": 65, "category": "social"}, {"name": "抖音", "minutes": 40, "category": "entertainment"}]}';

  const [data] = await callChatCompletion(
    settings,
    redis,
    [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageUrl } }] }],
    { temperature: 0.1, maxTokens: 1500, user },
  );
  const choices = Array.isArray(data.choices) ? (data.choices as Record<string, unknown>[]) : [];
  let clean = String(((choices[0]?.message as Record<string, unknown> | undefined)?.content) ?? "").trim();
  if (clean.includes("```json")) clean = clean.split("```json", 2)[1]!.split("```", 1)[0]!.trim();
  else if (clean.includes("```")) clean = clean.split("```", 2)[1]!.split("```", 1)[0]!.trim();
  const parsed = JSON.parse(clean) as { log_date?: string; app_usages?: AppUsageIn[] };
  const targetDate = parsed.log_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.log_date) ? parsed.log_date : new Date().toISOString().slice(0, 10);
  const record = await recordDailyRhythm(db, redis, user, { logDate: targetDate, appUsages: parsed.app_usages ?? [] });
  return {
    status: "ok",
    log_date: record.logDate,
    apps_count: Array.isArray(record.appUsages) ? record.appUsages.length : 0,
    total_screen_minutes: record.totalScreenMinutes,
    apps: record.appUsages,
  };
}
