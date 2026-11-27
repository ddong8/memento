// /api/tools: AI tools and their files, optionally for one device (api/tools.py); /api/public/stats.
import { and, count, countDistinct, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import { conversationMessages, documents, machines, tools } from "../db/pulled/schema";
import { queryInt } from "../http";
import { pgToIso } from "../pytime";
import { machineFilter, userMachineIds } from "../services/visibility";

export const toolRoutes = new Hono<AppEnv>();
export const publicRoutes = new Hono<AppEnv>();

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  claude_code: "Claude Code", openclaw: "OpenClaw", codex: "Codex", antigravity: "Antigravity", workbuddy: "WorkBuddy",
  obsidian: "Obsidian", cursor: "Cursor", windsurf: "Windsurf", vscode: "VS Code", hermes: "Hermes",
};

const ofDevice = (db: Parameters<typeof userMachineIds>[0], deviceId: string) =>
  inArray(documents.machineId, db.select({ id: machines.id }).from(machines).where(eq(machines.collectorTokenHash, deviceId)));

const summary = (t: typeof tools.$inferSelect, totalFiles: number, totalSize: number) => ({
  id: t.id,
  display_name: t.displayName,
  icon: t.icon,
  total_files: totalFiles,
  total_size_bytes: totalSize,
  last_sync_at: pgToIso(t.lastSyncAt),
});

toolRoutes.get("/", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const deviceId = c.req.query("device_id") || null;
  const key = `tools:list:${user.id}:${deviceId || "all"}`;
  const cached = await cacheGet(redis, key);
  if (cached != null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  const all = await db.select().from(tools).orderBy(tools.displayName);
  let res;
  if (!deviceId && mids === null) {
    res = all.map((t) => summary(t, t.totalFiles, t.totalSizeBytes));
  } else {
    const conds: (SQL | undefined)[] = [deviceId ? ofDevice(db, deviceId) : undefined, machineFilter(mids, documents.machineId)];
    const rows = await db.select({ tool: documents.toolId, n: count() }).from(documents).where(and(...conds)).groupBy(documents.toolId);
    const counts = new Map(rows.map((r) => [r.tool, Number(r.n)]));
    res = all.filter((t) => counts.has(t.id)).map((t) => summary(t, counts.get(t.id)!, 0));
  }
  await cacheSet(redis, key, res, 30);
  return c.json(res);
});

toolRoutes.get("/:toolId", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const toolId = c.req.param("toolId");
  const deviceId = c.req.query("device_id") || null;
  const mids = await userMachineIds(db, user, settings);
  const [tool] = await db.select().from(tools).where(eq(tools.id, toolId)).limit(1);
  if (!tool) {
    return c.json({ id: toolId, display_name: TOOL_DISPLAY_NAMES[toolId] ?? toolId, total_files: 0, total_size_bytes: 0, last_sync_at: null, categories: {} });
  }
  const rows = await db
    .select({ category: documents.category, n: count() })
    .from(documents)
    .where(and(eq(documents.toolId, toolId), deviceId ? ofDevice(db, deviceId) : undefined, machineFilter(mids, documents.machineId)))
    .groupBy(documents.category);
  const categories = Object.fromEntries(rows.map((r) => [r.category, Number(r.n)]));
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  return c.json({
    id: tool.id,
    display_name: tool.displayName,
    total_files: deviceId || mids !== null ? total : tool.totalFiles,
    total_size_bytes: tool.totalSizeBytes,
    last_sync_at: pgToIso(tool.lastSyncAt),
    categories,
  });
});

toolRoutes.get("/:toolId/files", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 50, { ge: 1, le: 200 });
  const toolId = c.req.param("toolId");
  const category = c.req.query("category") || null;
  const deviceId = c.req.query("device_id") || null;
  const mids = await userMachineIds(db, user, settings);
  const docs = await db
    .select({
      id: documents.id,
      relativePath: documents.relativePath,
      category: documents.category,
      contentType: documents.contentType,
      title: documents.title,
      fileSizeBytes: documents.fileSizeBytes,
      syncedAt: documents.syncedAt,
      aiSummary: documents.aiSummary,
      machineId: documents.machineId,
    })
    .from(documents)
    .where(and(eq(documents.toolId, toolId), category ? eq(documents.category, category) : undefined, deviceId ? ofDevice(db, deviceId) : undefined, machineFilter(mids, documents.machineId)))
    .orderBy(desc(documents.syncedAt))
    .offset(offset)
    .limit(limit);
  const ids = [...new Set(docs.map((d) => d.machineId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) for (const m of await db.select({ id: machines.id, name: machines.name }).from(machines).where(inArray(machines.id, ids))) names.set(m.id, m.name);
  return c.json(
    docs.map((d) => ({
      id: d.id,
      relative_path: d.relativePath,
      category: d.category,
      content_type: d.contentType,
      title: d.title,
      file_size_bytes: d.fileSizeBytes,
      synced_at: pgToIso(d.syncedAt),
      ai_summary: d.aiSummary,
      device_name: d.machineId ? (names.get(d.machineId) ?? null) : null,
    })),
  );
});

publicRoutes.get("/stats", async (c) => {
  const { db } = c.var.deps;
  const [[docs], [msgs], [devices], [toolsN]] = await Promise.all([
    db.select({ n: count(documents.id) }).from(documents).where(ne(documents.toolId, "system")),
    db.select({ n: count(conversationMessages.id) }).from(conversationMessages),
    db.select({ n: count(machines.id) }).from(machines).where(isNull(machines.mergedInto)),
    db.select({ n: countDistinct(documents.toolId) }).from(documents).where(ne(documents.toolId, "system")),
  ]);
  return c.json({
    total_documents: Number(docs?.n ?? 0),
    total_messages: Number(msgs?.n ?? 0),
    total_devices: Number(devices?.n ?? 0),
    total_tools: Number(toolsN?.n ?? 0),
  });
});
