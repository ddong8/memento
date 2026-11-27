// /api/dashboard: aggregated overview for the home page (server/server/api/dashboard.py).
import { and, count, countDistinct, desc, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import { conversationMessages, documents, machines, projects, tools } from "../db/pulled/schema";
import { queryInt } from "../http";
import { pgToIso } from "../pytime";
import { machineFilter, userMachineIds } from "../services/visibility";

export const dashboardRoutes = new Hono<AppEnv>();

const ofDevice = (db: Parameters<typeof userMachineIds>[0], deviceId: string) =>
  inArray(documents.machineId, db.select({ id: machines.id }).from(machines).where(eq(machines.collectorTokenHash, deviceId)));

dashboardRoutes.get("/", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const deviceId = c.req.query("device_id") || null;
  const tzOffset = queryInt(c, "tz_offset", 0);

  const cacheKey = `dashboard:${user.id}:${deviceId || "all"}:${tzOffset}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  const docFilters: (SQL | undefined)[] = [
    deviceId ? ofDevice(db, deviceId) : undefined,
    machineFilter(mids, documents.machineId),
  ];

  // tz_offset is JS getTimezoneOffset() (e.g. -480 for UTC+8)
  const shiftMinutes = -tzOffset;
  const shiftMs = shiftMinutes * 60_000;
  const nowMs = Date.now();
  const localNow = new Date(nowMs + shiftMs);
  const todayStartIso = new Date(
    Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - shiftMs,
  ).toISOString();
  const cutoffIso = new Date(nowMs - 7 * 86400_000).toISOString();

  // Tools with category breakdown & today counts
  const [toolRecords, catAggRows, todayRows] = await Promise.all([
    db.select().from(tools).orderBy(tools.displayName),
    db
      .select({ toolId: documents.toolId, category: documents.category, n: count() })
      .from(documents)
      .where(and(...docFilters))
      .groupBy(documents.toolId, documents.category),
    db
      .select({ toolId: documents.toolId, n: count() })
      .from(documents)
      .where(and(gte(documents.syncedAt, todayStartIso), ...docFilters))
      .groupBy(documents.toolId),
  ]);

  const categoriesByTool = new Map<string, Record<string, number>>();
  for (const r of catAggRows) {
    let map = categoriesByTool.get(r.toolId);
    if (!map) {
      map = {};
      categoriesByTool.set(r.toolId, map);
    }
    map[r.category] = Number(r.n);
  }
  const todayByTool = new Map(todayRows.map((r) => [r.toolId, Number(r.n)]));

  const toolsOut = [];
  for (const t of toolRecords) {
    const categories = categoriesByTool.get(t.id) ?? {};
    const catEntries = Object.values(categories);
    if ((deviceId || mids !== null) && catEntries.length === 0) continue;
    toolsOut.push({
      id: t.id,
      display_name: t.displayName,
      total_files: deviceId || mids !== null ? catEntries.reduce((a, b) => a + b, 0) : t.totalFiles,
      last_sync_at: pgToIso(t.lastSyncAt),
      categories,
      today_count: todayByTool.get(t.id) ?? 0,
      conversation_count: categories.conversation ?? 0,
    });
  }

  // Recent conversations (last 10)
  const convosRows = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      title: documents.title,
      syncedAt: documents.syncedAt,
      projectId: documents.projectId,
      fileSizeBytes: documents.fileSizeBytes,
      projectTitle: projects.title,
    })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .where(and(eq(documents.category, "conversation"), ...docFilters))
    .orderBy(desc(documents.syncedAt))
    .limit(10);

  const msgCounts = new Map<string, number>();
  if (convosRows.length) {
    const msgRows = await db
      .select({ docId: conversationMessages.documentId, n: count() })
      .from(conversationMessages)
      .where(inArray(conversationMessages.documentId, convosRows.map((r) => r.id)))
      .groupBy(conversationMessages.documentId);
    for (const r of msgRows) msgCounts.set(r.docId, Number(r.n));
  }

  const recentConversations = convosRows.map((r) => ({
    id: r.id,
    tool_id: r.toolId,
    title: r.title,
    synced_at: pgToIso(r.syncedAt),
    project_title: r.projectTitle ?? null,
    message_count: msgCounts.get(r.id) ?? 0,
  }));

  // Last 7 days daily + tool_daily
  const dayExpr = sql<string>`CAST((${documents.syncedAt} + make_interval(mins => ${shiftMinutes})) AS date)::text`;

  const [dailyRows, toolDailyRows, machineRows, [todayAgg], [totalAgg]] = await Promise.all([
    db
      .select({ day: dayExpr.as("day"), n: count() })
      .from(documents)
      .where(and(gte(documents.syncedAt, cutoffIso), ...docFilters))
      .groupBy(sql.raw("day"))
      .orderBy(sql.raw("day")),
    db
      .select({ toolId: documents.toolId, day: dayExpr.as("day"), n: count() })
      .from(documents)
      .where(and(gte(documents.syncedAt, cutoffIso), ...docFilters))
      .groupBy(documents.toolId, sql.raw("day"))
      .orderBy(sql.raw("day")),
    mids !== null && mids.length === 0
      ? Promise.resolve([])
      : db
          .select()
          .from(machines)
          .where(and(isNull(machines.mergedInto), eq(machines.isArchived, false), mids !== null ? inArray(machines.id, mids) : undefined))
          .orderBy(machines.name)
          .limit(10),
    db
      .select({
        total: count(),
        conversations: sql<number>`count(*) filter (where ${documents.category} = 'conversation')`,
      })
      .from(documents)
      .where(and(gte(documents.syncedAt, todayStartIso), ...docFilters)),
    db
      .select({
        totalDocs: count(),
        totalProjects: countDistinct(documents.projectId),
      })
      .from(documents)
      .where(and(...docFilters)),
  ]);

  const daily = dailyRows.map((r) => ({ date: r.day, count: Number(r.n) }));
  const toolDaily: Record<string, { date: string; count: number }[]> = {};
  for (const r of toolDailyRows) {
    (toolDaily[r.toolId] ??= []).push({ date: r.day, count: Number(r.n) });
  }

  const devCounts = new Map<string, number>();
  if (machineRows.length) {
    const devRows = await db
      .select({ machineId: documents.machineId, n: count() })
      .from(documents)
      .where(inArray(documents.machineId, machineRows.map((m) => m.id)))
      .groupBy(documents.machineId);
    for (const r of devRows) if (r.machineId) devCounts.set(r.machineId, Number(r.n));
  }

  const devicesOut = machineRows.map((m) => ({
    id: m.id,
    device_id: m.collectorTokenHash,
    name: m.name,
    last_heartbeat: pgToIso(m.lastHeartbeat),
    collector_version: m.collectorVersion,
    total_files: devCounts.get(m.id) ?? 0,
  }));

  const payload = {
    tools: toolsOut,
    recent_conversations: recentConversations,
    daily,
    tool_daily: toolDaily,
    devices: devicesOut,
    stats: {
      total_documents: Number(totalAgg?.totalDocs ?? 0),
      total_projects: Number(totalAgg?.totalProjects ?? 0),
      total_tools: toolsOut.length,
      total_devices: devicesOut.length,
      today_total: Number(todayAgg?.total ?? 0),
      today_conversations: Number(todayAgg?.conversations ?? 0),
    },
  };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});
