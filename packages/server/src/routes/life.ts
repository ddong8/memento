// /api/life: daily life rhythm, sleep tracking, screen time & AI lifestyle advice (server/server/api/life_rhythm.py).
import { Hono } from "hono";

import { currentUser, currentUserOrCollector } from "../auth/current-user";
import { cacheSet } from "../cache";
import type { AppEnv } from "../context";
import { HttpError, parseJsonObject, parseOptionalJsonObject, queryInt } from "../http";
import { pyDateFromIso } from "../pytime";
import {
  clearUserRhythms,
  generateLifeDecisionAdvice,
  getRecentRhythms,
  parseScreenTimeScreenshot,
  recordDailyRhythm,
  rhythmOut,
  syncRhythmsFromCollector,
  type AppUsageIn,
} from "../services/life";

export const lifeRoutes = new Hono<AppEnv>();

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseDateParam(raw: string | null | undefined): string {
  if (!raw) return todayIso();
  const parsed = pyDateFromIso(raw);
  if (!parsed) throw new HttpError(400, "Invalid date format");
  return parsed;
}

lifeRoutes.get("/rhythm", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const days = queryInt(c, "days", 7, { ge: 1, le: 90 });
  const tzOffset = queryInt(c, "tz_offset", 0);
  return c.json(await getRecentRhythms(db, settings, c.var.deps.redis(), user, days, tzOffset));
});

lifeRoutes.post("/rhythm/sync", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const body = (await parseOptionalJsonObject(c)) ?? {};
  const days = typeof body.days === "number" && Number.isInteger(body.days) ? body.days : 7;
  const tzOffset = typeof body.tz_offset === "number" && Number.isInteger(body.tz_offset) ? body.tz_offset : 0;
  const synced = await syncRhythmsFromCollector(db, settings, redis, user, days, tzOffset);
  await cacheSet(redis, `life:sync_cooldown:${user.id}:${days}`, "1", 300);
  return c.json({ status: "ok", synced_days: synced.length, records: synced.map(rhythmOut) });
});

lifeRoutes.post("/rhythm", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUserOrCollector(c);
  const body = await parseJsonObject(c);
  const logDate = parseDateParam(typeof body.log_date === "string" ? body.log_date : null);
  const appUsages = Array.isArray(body.app_usages) ? (body.app_usages as AppUsageIn[]) : [];
  const record = await recordDailyRhythm(db, c.var.deps.redis(), user, {
    logDate,
    appUsages,
    wakeupTime: typeof body.wakeup_time === "string" ? body.wakeup_time : null,
    bedtime: typeof body.bedtime === "string" ? body.bedtime : null,
    sleepHours: typeof body.sleep_hours === "number" ? body.sleep_hours : null,
  });
  return c.json({
    status: "ok",
    id: record.id,
    log_date: record.logDate,
    total_screen_minutes: record.totalScreenMinutes,
    productive_minutes: record.productiveMinutes,
    distraction_minutes: record.distractionMinutes,
  });
});

const parseImageHandler = async (c: Parameters<typeof currentUser>[0]) => {
  const { db, settings } = c.var.deps;
  const user = await currentUserOrCollector(c);
  const body = await parseJsonObject(c);
  if (typeof body.image !== "string") {
    throw new HttpError(422, [{ type: "missing", loc: ["body", "image"], msg: "Field required", input: body }]);
  }
  return c.json(await parseScreenTimeScreenshot(db, settings, c.var.deps.redis(), user, body.image));
};

lifeRoutes.post("/rhythm/parse-image", parseImageHandler);
lifeRoutes.post("/rhythm/ocr", parseImageHandler);

const clearHandler = async (c: Parameters<typeof currentUser>[0]) => {
  const user = await currentUser(c);
  const rawDate = c.req.query("log_date");
  const target = rawDate ? parseDateParam(rawDate) : null;
  const deleted = await clearUserRhythms(c.var.deps.db, c.var.deps.redis(), user, target);
  return c.json({ status: "ok", deleted_count: deleted });
};

lifeRoutes.post("/rhythm/clear", clearHandler);
lifeRoutes.delete("/rhythm", clearHandler);

lifeRoutes.post("/rhythm/advice", async (c) => {
  const user = await currentUser(c);
  const target = parseDateParam(c.req.query("log_date"));
  const advice = await generateLifeDecisionAdvice(c.var.deps.db, c.var.deps.settings, c.var.deps.redis(), user, target);
  return c.json({ status: "ok", advice });
});

lifeRoutes.post("/rhythm/sample", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const today = todayIso();
  const todayMs = Date.parse(`${today}T00:00:00Z`);

  const sampleDays = [
    {
      offset: 0,
      wakeup: "07:30",
      bed: "00:45",
      apps: [
        { name: "VS Code", minutes: 260, category: "work" },
        { name: "Chrome (研发文档)", minutes: 140, category: "work" },
        { name: "微信", minutes: 95, category: "social" },
        { name: "哔哩哔哩", minutes: 55, category: "entertainment" },
        { name: "微信读书", minutes: 35, category: "reading" },
        { name: "抖音", minutes: 40, category: "entertainment" },
      ],
    },
    {
      offset: 1,
      wakeup: "07:45",
      bed: "01:15",
      apps: [
        { name: "VS Code", minutes: 220, category: "work" },
        { name: "Terminal", minutes: 80, category: "work" },
        { name: "微信", minutes: 110, category: "social" },
        { name: "抖音", minutes: 85, category: "entertainment" },
        { name: "小红书", minutes: 45, category: "entertainment" },
      ],
    },
    {
      offset: 2,
      wakeup: "07:15",
      bed: "23:45",
      apps: [
        { name: "Cursor", minutes: 310, category: "work" },
        { name: "飞书", minutes: 90, category: "work" },
        { name: "微信读书", minutes: 60, category: "reading" },
        { name: "微信", minutes: 70, category: "social" },
        { name: "哔哩哔哩", minutes: 30, category: "entertainment" },
      ],
    },
  ];

  for (const item of sampleDays) {
    const d = new Date(todayMs - item.offset * 86400_000).toISOString().slice(0, 10);
    await recordDailyRhythm(db, redis, user, {
      logDate: d,
      appUsages: item.apps,
      wakeupTime: item.wakeup,
      bedtime: item.bed,
    });
  }
  const advice = await generateLifeDecisionAdvice(db, settings, redis, user, today);
  return c.json({ status: "ok", message: "已生成示例作息与时间分配数据", advice });
});
