// /api/hierarchy: Device -> Tool -> Project -> Conversation drill-down (server/server/api/hierarchy.py).
import { and, count, desc, eq, inArray, isNull, max, ne, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { documents, machines, projects, tools } from "../db/pulled/schema";
import { normalizeUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { resolveMerged, type MachineRow } from "../services/device-merge";
import { seesAll } from "../services/visibility";

export const hierarchyRoutes = new Hono<AppEnv>();

function checkMachineAccess(machine: MachineRow | null, user: UserRow, settings: Settings): MachineRow | null {
  if (!machine) return null;
  if (seesAll(user, settings)) return machine;
  return machine.userId === user.id ? machine : null;
}

async function findMachine(db: Db, deviceId: string): Promise<MachineRow | null> {
  const [byHash] = await db.select().from(machines).where(eq(machines.collectorTokenHash, deviceId)).limit(1);
  if (byHash) return resolveMerged(db, byHash);
  const uid = normalizeUuid(deviceId);
  if (!uid) return null;
  const [byId] = await db.select().from(machines).where(eq(machines.id, uid)).limit(1);
  return resolveMerged(db, byId);
}

hierarchyRoutes.get("/devices", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const cacheKey = `hierarchy:devices:${user.id}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const conds: (SQL | undefined)[] = [isNull(machines.mergedInto), eq(machines.isArchived, false)];
  if (!seesAll(user, settings)) conds.push(eq(machines.userId, user.id));
  const machinesList = await db
    .select()
    .from(machines)
    .where(and(...conds))
    .orderBy(machines.name);
  if (!machinesList.length) return c.json([]);

  const mids = machinesList.map((m) => m.id);
  const toolRows = await db
    .select({ machineId: documents.machineId, toolId: documents.toolId, cnt: count() })
    .from(documents)
    .where(and(inArray(documents.machineId, mids), ne(documents.toolId, "system")))
    .groupBy(documents.machineId, documents.toolId);

  const byMid = new Map<string, Map<string, number>>();
  for (const r of toolRows) {
    if (!r.machineId) continue;
    let map = byMid.get(r.machineId);
    if (!map) {
      map = new Map();
      byMid.set(r.machineId, map);
    }
    map.set(r.toolId, Number(r.cnt));
  }

  const items = machinesList.map((m) => {
    const tc = byMid.get(m.id) ?? new Map<string, number>();
    let total = 0;
    const toolsList = [...tc.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, cnt]) => {
        total += cnt;
        return { id, file_count: cnt };
      });
    return {
      id: m.id,
      device_id: m.collectorTokenHash,
      name: m.name,
      last_heartbeat: pgToIso(m.lastHeartbeat),
      total_files: total,
      tools: toolsList,
    };
  });
  await cacheSet(redis, cacheKey, items, 30);
  return c.json(items);
});

hierarchyRoutes.get("/devices/:deviceId/tools", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const m = checkMachineAccess(await findMachine(db, c.req.param("deviceId")), user, settings);
  if (!m) return c.json([]);

  const rows = await db
    .select({
      toolId: documents.toolId,
      displayName: tools.displayName,
      category: documents.category,
      cnt: count(),
    })
    .from(documents)
    .leftJoin(tools, eq(documents.toolId, tools.id))
    .where(and(eq(documents.machineId, m.id), ne(documents.toolId, "system")))
    .groupBy(documents.toolId, tools.displayName, documents.category);

  const toolData = new Map<string, { id: string; display_name: string; categories: Record<string, number>; total_files: number }>();
  for (const r of rows) {
    let entry = toolData.get(r.toolId);
    if (!entry) {
      entry = {
        id: r.toolId,
        display_name: r.displayName || r.toolId,
        categories: {},
        total_files: 0,
      };
      toolData.set(r.toolId, entry);
    }
    const n = Number(r.cnt);
    entry.categories[r.category] = n;
    entry.total_files += n;
  }

  return c.json([...toolData.values()].sort((a, b) => b.total_files - a.total_files));
});

hierarchyRoutes.get("/devices/:deviceId/tools/:toolId/projects", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const m = checkMachineAccess(await findMachine(db, c.req.param("deviceId")), user, settings);
  if (!m) return c.json([]);

  const toolId = c.req.param("toolId");
  const rows = await db
    .select({
      projectId: documents.projectId,
      cnt: count(),
      last: max(documents.syncedAt),
    })
    .from(documents)
    .where(and(eq(documents.machineId, m.id), eq(documents.toolId, toolId)))
    .groupBy(documents.projectId);

  const projectIds = rows.map((r) => r.projectId).filter((x): x is string => Boolean(x));
  const projectMap = new Map<string, { title: string; slug: string }>();
  if (projectIds.length) {
    const pRows = await db
      .select({ id: projects.id, title: projects.title, slug: projects.slug })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of pRows) projectMap.set(p.id, { title: p.title, slug: p.slug });
  }

  const items = rows.map((r) => {
    if (r.projectId) {
      const p = projectMap.get(r.projectId);
      return {
        id: r.projectId,
        title: p ? p.title : "Unknown",
        slug: p ? p.slug : "",
        file_count: Number(r.cnt),
        last_sync: pgToIso(r.last),
      };
    }
    return {
      id: "none",
      title: "(No Project)",
      slug: "",
      file_count: Number(r.cnt),
      last_sync: pgToIso(r.last),
    };
  });

  return c.json(items.sort((a, b) => b.file_count - a.file_count));
});

hierarchyRoutes.get("/devices/:deviceId/tools/:toolId/files", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 50, { ge: 1, le: 200 });
  const m = checkMachineAccess(await findMachine(db, c.req.param("deviceId")), user, settings);
  if (!m) return c.json({ total: 0, files: [] });

  const toolId = c.req.param("toolId");
  const projectId = c.req.query("project_id") || null;
  const category = c.req.query("category") || null;

  const conds: (SQL | undefined)[] = [eq(documents.machineId, m.id), eq(documents.toolId, toolId)];
  if (projectId && projectId !== "none") {
    const uid = normalizeUuid(projectId);
    if (!uid) return c.json({ total: 0, files: [] });
    conds.push(eq(documents.projectId, uid));
  } else if (projectId === "none") {
    conds.push(isNull(documents.projectId));
  }
  if (category) conds.push(eq(documents.category, category));

  const where = and(...conds);
  const [[tot], docs] = await Promise.all([
    db.select({ n: count() }).from(documents).where(where),
    db
      .select({
        id: documents.id,
        title: documents.title,
        relativePath: documents.relativePath,
        category: documents.category,
        contentType: documents.contentType,
        fileSizeBytes: documents.fileSizeBytes,
        syncedAt: documents.syncedAt,
      })
      .from(documents)
      .where(where)
      .orderBy(desc(documents.syncedAt))
      .offset(offset)
      .limit(limit),
  ]);

  return c.json({
    total: Number(tot?.n ?? 0),
    files: docs.map((d) => ({
      id: d.id,
      title: d.title,
      relative_path: d.relativePath,
      category: d.category,
      content_type: d.contentType,
      file_size_bytes: d.fileSizeBytes,
      synced_at: pgToIso(d.syncedAt),
    })),
  });
});
