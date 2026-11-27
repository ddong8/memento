// Registered collector devices API: list (ETag/304/lag/audit), discovery, archive/purge, commands, P2P, agent-login & Range file streaming (server/server/api/devices.py).
import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";

import { and, desc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";

import { record as recordAudit } from "../audit";
import { currentUser, currentUserFlexible, optionalUser, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import { auditRequest, type AppEnv, type Deps } from "../context";
import type { Db } from "../db/client";
import {
  accessLogs,
  conversationMessages,
  documentEmbeddings,
  documents,
  documentVersions,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  shareLinks,
  syncState,
  users,
} from "../db/pulled/schema";
import { HttpError, parseJsonObject, pathUuid, queryOptionalInt, queryRequiredString, requiredHeader } from "../http";
import { pgToIso } from "../pytime";
import { loadChatImage, storageKey as chatImageStorageKey } from "../services/chat-images";
import { cluster, PREFIX } from "../services/cluster";
import { ackCommand as redisAckCmd, pendingCommands as redisPendingCmds, pushCommand as redisPushCmd, type DeviceCommand } from "../services/device-commands";
import {
  appendPartChunk,
  cleanDevicePath,
  diskCacheKey,
  fileMatchesSize,
  parseByteRange,
  readLocalSlice,
  SANDBOXED_INLINE_EXTS,
  userCacheScope,
} from "../services/device-files";
import type { MachineRow } from "../services/device-merge";
import { deviceHasFeature, getCachedDeviceCapabilities } from "../services/device-reports";
import { shouldWriteHeartbeat } from "../services/device-service";
import { shareFileSignatureOk } from "../services/storage";
import { findMachineByIdOrHash, normalizeDeviceName } from "../services/user-filter";
import { seesAll, userMachineIds } from "../services/visibility";
import { wsManager } from "../services/ws-manager";

// In-memory fallback command queue (when no Redis)
const localCommandQueue = new Map<string, DeviceCommand[]>();
let localCmdCounter = 0;

async function enqueueCommand(deviceCollectorId: string, action: string, payload?: Record<string, unknown> | null): Promise<number> {
  const r = cluster.redis;
  if (r) {
    try {
      return await redisPushCmd(r, deviceCollectorId, action, payload);
    } catch {
      /* fallback */
    }
  }
  localCmdCounter += 1;
  const cmd: DeviceCommand = { id: localCmdCounter, action, created_at: Date.now() / 1000, ...(payload ? { payload } : {}) };
  const list = localCommandQueue.get(deviceCollectorId) ?? [];
  list.push(cmd);
  localCommandQueue.set(deviceCollectorId, list);
  return localCmdCounter;
}

async function listPendingCommands(deviceCollectorId: string): Promise<DeviceCommand[]> {
  const out = [...(localCommandQueue.get(deviceCollectorId) ?? [])];
  const r = cluster.redis;
  if (r) {
    try {
      out.push(...(await redisPendingCmds(r, deviceCollectorId)));
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function ackDeviceCommand(deviceCollectorId: string, cmdId: number): Promise<void> {
  const q = localCommandQueue.get(deviceCollectorId);
  if (q) localCommandQueue.set(deviceCollectorId, q.filter((c) => c.id !== cmdId));
  const r = cluster.redis;
  if (r) {
    try {
      await redisAckCmd(r, deviceCollectorId, cmdId);
    } catch {
      /* ignore */
    }
  }
}

function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const raw = ifNoneMatch.trim();
  if (raw === "*") return true;
  const clean = etag.replace(/^"+|"+$/g, "").trim();
  for (const part of raw.split(",")) {
    let s = part.trim();
    if (s.startsWith("W/") || s.startsWith("w/")) s = s.slice(2).trim();
    const stripped = s.replace(/^"+|"+$/g, "").trim();
    if (stripped === clean || s === etag) return true;
  }
  return false;
}

function parseBoolParam(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function parsePgTsMs(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const norm = ts.includes("T") ? ts : ts.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

function acpAgentsFor(name: string | null | undefined, user: UserRow, settings: Settings): string[] {
  if (!name) return [];
  const caps = getCachedDeviceCapabilities(name, null, user, settings);
  if (!caps || typeof caps !== "object") return [];
  return Object.entries(caps)
    .filter(([, v]) => Boolean(v && typeof v === "object" && (v as Record<string, unknown>).protocol === "acp"))
    .map(([k]) => k);
}

async function collectMetrics(deps: Deps, machineIds: string[]): Promise<Record<string, Record<string, unknown>>> {
  const key = `devices:collect:${[...machineIds].sort().join(",")}`;
  const cached = (await cacheGet(deps.redis(), key)) as Record<string, Record<string, unknown>> | null;
  if (cached) return cached;

  const out: Record<string, Record<string, unknown>> = {};
  if (!machineIds.length) return out;
  const idArray = sql`ARRAY[${sql.join(
    machineIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;

  const lagRes = await deps.db.execute(sql`
    SELECT d.machine_id, count(*)::int AS cnt,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY x.lag) AS p50,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY x.lag) AS p99,
           max(x.lag) AS mx
    FROM (
      SELECT m.document_id, greatest(extract(epoch from m.created_at - m."timestamp"), 0) AS lag
      FROM conversation_messages m
      WHERE m."timestamp" > now() - interval '24 hours'
    ) x
    JOIN documents d ON d.id = x.document_id
    WHERE d.machine_id = ANY(${idArray}) AND d.tool_id NOT IN ('memento', 'system')
    GROUP BY d.machine_id
  `);
  for (const r of lagRes as unknown as Record<string, unknown>[]) {
    const mid = String(r.machine_id);
    out[mid] ??= {};
    out[mid]!.lag = {
      messages: Number(r.cnt ?? 0),
      p50: Math.round(Number(r.p50 ?? 0) * 10) / 10,
      p99: Math.round(Number(r.p99 ?? 0) * 10) / 10,
      max: Math.round(Number(r.mx ?? 0)),
    };
  }

  const auditRes = await deps.db.execute(sql`
    SELECT d.machine_id, a.outcome, count(*)::int AS cnt,
           coalesce(sum(a.missing), 0)::int AS missing,
           coalesce(sum(a.duplicates), 0)::int AS dups
    FROM message_audit a
    JOIN documents d ON d.id = a.document_id
    WHERE d.machine_id = ANY(${idArray})
    GROUP BY d.machine_id, a.outcome
  `);
  for (const r of auditRes as unknown as Record<string, unknown>[]) {
    const mid = String(r.machine_id);
    const outcome = String(r.outcome ?? "");
    const n = Number(r.cnt ?? 0);
    out[mid] ??= {};
    let audit = out[mid]!.audit as Record<string, number> | undefined;
    if (!audit) {
      audit = { checked: 0, ok: 0, needs_repair: 0, repaired: 0, missing: 0, duplicates: 0 };
      out[mid]!.audit = audit;
    }
    audit.checked! += n;
    if (outcome === "ok" || outcome === "needs_repair" || outcome === "repaired") audit[outcome]! += n;
    if (outcome === "needs_repair" || outcome === "repaired") {
      audit.missing! += Number(r.missing ?? 0);
      audit.duplicates! += Number(r.dups ?? 0);
    }
  }

  await cacheSet(deps.redis(), key, out, 300);
  return out;
}

async function verifyDeviceOwnership(db: Db, settings: Settings, deviceDbId: string, user: UserRow): Promise<MachineRow> {
  const [machine] = await db.select().from(machines).where(eq(machines.id, deviceDbId)).limit(1);
  if (!machine || (!seesAll(user, settings) && machine.userId !== user.id)) {
    throw new HttpError(404, "Device not found");
  }
  return machine;
}

async function purgeDeviceData(db: Db, deviceDbId: string, includeSystem: boolean) {
  const docConds = [eq(documents.machineId, deviceDbId)];
  if (!includeSystem) docConds.push(ne(documents.toolId, "system"));
  const docRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(...docConds));
  const docIds = docRows.map((r) => r.id);

  for (let i = 0; i < docIds.length; i += 500) {
    const batch = docIds.slice(i, i + 500);
    await db.delete(accessLogs).where(inArray(accessLogs.documentId, batch));
    await db.delete(conversationMessages).where(inArray(conversationMessages.documentId, batch));
    await db.delete(documentVersions).where(inArray(documentVersions.documentId, batch));
    await db.delete(documentEmbeddings).where(inArray(documentEmbeddings.documentId, batch));
    await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.sourceDocumentId, batch));
    await db.delete(documents).where(inArray(documents.id, batch));
  }

  const orphanEntities = await db
    .select({ id: knowledgeEntities.id })
    .from(knowledgeEntities)
    .where(
      notInArray(
        knowledgeEntities.id,
        db.select({ entityId: knowledgeObservations.entityId }).from(knowledgeObservations).where(sql`${knowledgeObservations.entityId} IS NOT NULL`),
      ),
    );
  const orphanEntityIds = orphanEntities.map((e) => e.id);
  if (orphanEntityIds.length) {
    await db
      .delete(knowledgeRelations)
      .where(or(inArray(knowledgeRelations.sourceId, orphanEntityIds), inArray(knowledgeRelations.targetId, orphanEntityIds)));
    await db.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, orphanEntityIds));
  }

  const orphanProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      notInArray(
        projects.id,
        db.select({ projectId: documents.projectId }).from(documents).where(sql`${documents.projectId} IS NOT NULL`),
      ),
    );
  const orphanProjectIds = orphanProjects.map((p) => p.id);
  if (orphanProjectIds.length) {
    await db.delete(projects).where(inArray(projects.id, orphanProjectIds));
  }
  await db.delete(syncState).where(eq(syncState.machineId, deviceDbId));
  return {
    documents_deleted: docIds.length,
    orphaned_entities_deleted: orphanEntityIds.length,
    orphaned_projects_deleted: orphanProjectIds.length,
  };
}

async function invalidateDeviceCaches(deps: Deps, userId: string): Promise<void> {
  const r = deps.redis();
  const prefixes = [
    `devices:list:${userId}`,
    `devices:stats:${userId}`,
    `hierarchy:devices:${userId}`,
    `dashboard:${userId}`,
    `tools:list:${userId}`,
    `projects:list:${userId}`,
    `projects:list:v2:${userId}`,
    `project:conv:${userId}:`,
    `project:conv:v2:${userId}:`,
  ];
  await Promise.all(prefixes.map((p) => cacheDeletePrefix(r, p)));
}

// ---------------------------------------------------------------------------
// Media streaming cache & prefetch helpers
// ---------------------------------------------------------------------------
const activePrefetchTasks = new Set<string>();
const knownCacheMap = new Map<string, [number, string]>();
const MAX_KNOWN_CACHE_ENTRIES = 2000;
const initialChunkCache = new Map<string, [Buffer, number]>();
const negativeStatCache = new Map<string, number>();
const fileStatCache = new Map<string, [number, string, number]>();
const FILE_STAT_CACHE_TTL = 600;
const MAX_INITIAL_CHUNKS = 50;
const INITIAL_CHUNK_TTL = 300;
const MAX_DISK_CACHE_BYTES = Number(process.env.MEMENTO_MEDIA_CACHE_MAX_BYTES || 5 * 1024 * 1024 * 1024);
const MAX_CONCURRENT_PREFETCH = 2;
const prefetchReserved = new Map<string, number>();

const SERVER_FILE_ROOTS = ["/data2/memento/images", "/tmp/memento_images", join(tmpdir(), "memento_images")];

function rememberKnownCache(userScope: string, devScope: string, cleanPath: string, totalSize: number, cachedPath: string): void {
  const key = `${userScope}\0${devScope}\0${cleanPath}`;
  knownCacheMap.delete(key);
  knownCacheMap.set(key, [totalSize, cachedPath]);
  while (knownCacheMap.size > MAX_KNOWN_CACHE_ENTRIES) {
    const first = knownCacheMap.keys().next().value;
    if (first !== undefined) knownCacheMap.delete(first);
    else break;
  }
}

function lookupKnownCache(userScope: string, devScope: string, cleanPath: string): [number, string] | null {
  const direct = knownCacheMap.get(`${userScope}\0${devScope}\0${cleanPath}`);
  if (direct) return direct;
  if (devScope === "auto") {
    const prefix = `${userScope}\0`;
    const suffix = `\0${cleanPath}`;
    for (const [k, v] of knownCacheMap.entries()) {
      if (k.startsWith(prefix) && k.endsWith(suffix)) return v;
    }
  }
  return null;
}

async function getCachedStat(path: string, userScope = "global"): Promise<[number, string] | null> {
  const now = Date.now() / 1000;
  const memKey = `${userScope}\0${path}`;
  const mem = fileStatCache.get(memKey);
  if (mem && now - mem[2] < FILE_STAT_CACHE_TTL) return [mem[0], mem[1]];
  const r = cluster.redis;
  if (r) {
    try {
      const digest = createHash("sha256").update(`${userScope}:${path}`, "utf8").digest("hex");
      const val = await r.get(`${PREFIX}fstat:v2:${digest}`);
      if (val) {
        const d = JSON.parse(val) as { size?: number; token?: string };
        const size = Number(d.size ?? 0);
        const token = String(d.token ?? "");
        if (size > 0 && token) {
          fileStatCache.set(memKey, [size, token, now]);
          return [size, token];
        }
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function setCachedStat(path: string, size: number, token: string, userScope = "global"): Promise<void> {
  const now = Date.now() / 1000;
  fileStatCache.set(`${userScope}\0${path}`, [size, token, now]);
  if (fileStatCache.size > 2000) {
    for (const [k, [, , ts]] of [...fileStatCache.entries()]) {
      if (now - ts > FILE_STAT_CACHE_TTL) fileStatCache.delete(k);
    }
  }
  const r = cluster.redis;
  if (r && size > 0 && token) {
    try {
      const digest = createHash("sha256").update(`${userScope}:${path}`, "utf8").digest("hex");
      await r.set(`${PREFIX}fstat:v2:${digest}`, JSON.stringify({ size, token }), "EX", FILE_STAT_CACHE_TTL);
    } catch {
      /* ignore */
    }
  }
}

function setInitialChunk(key: string, data: Buffer): void {
  const now = Date.now() / 1000;
  for (const [k, [, ts]] of [...initialChunkCache.entries()]) {
    if (now - ts > INITIAL_CHUNK_TTL) initialChunkCache.delete(k);
  }
  if (initialChunkCache.size >= MAX_INITIAL_CHUNKS) {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [k, [, ts]] of initialChunkCache.entries()) {
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = k;
      }
    }
    if (oldestKey) initialChunkCache.delete(oldestKey);
  }
  initialChunkCache.set(key, [data, now]);
}

function getInitialChunk(key: string): Buffer | null {
  const entry = initialChunkCache.get(key);
  if (!entry) return null;
  if (Date.now() / 1000 - entry[1] > INITIAL_CHUNK_TTL) {
    initialChunkCache.delete(key);
    return null;
  }
  return entry[0];
}

async function makeRoomFor(cacheDir: string, size: number, maxBytes = MAX_DISK_CACHE_BYTES): Promise<boolean> {
  if (size > Math.floor(maxBytes / 4) || prefetchReserved.size >= MAX_CONCURRENT_PREFETCH) return false;
  let reservedTotal = 0;
  for (const v of prefetchReserved.values()) reservedTotal += v;
  const budget = maxBytes - reservedTotal - size;
  if (budget < 0) return false;

  const files: [string, number, number][] = [];
  let used = 0;
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".test_")) continue;
      if (entry.name.endsWith(".part") && prefetchReserved.has(entry.name.split(".", 1)[0]!)) continue;
      const full = join(cacheDir, entry.name);
      try {
        const st = await stat(full);
        files.push([full, st.size, st.mtimeMs]);
        used += st.size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    return false;
  }
  if (used <= budget) return true;
  files.sort((a, b) => a[2] - b[2]);
  for (const [p, fsize] of files) {
    try {
      await unlink(p);
    } catch {
      continue;
    }
    used -= fsize;
    for (const [k, v] of [...knownCacheMap.entries()]) {
      if (v[1] === p) knownCacheMap.delete(k);
    }
    if (used <= budget) break;
  }
  return used <= budget;
}

async function getMediaCacheDir(): Promise<string> {
  for (const candidate of ["/data2/media_cache", "data/media_cache", join(tmpdir(), "memento_media_cache")]) {
    try {
      await mkdir(candidate, { recursive: true });
      const testFile = join(candidate, `.test_${process.pid}`);
      await writeFile(testFile, "ok");
      await unlink(testFile);
      return candidate;
    } catch {
      continue;
    }
  }
  return tmpdir();
}

async function serverFile(cleanPath: string): Promise<string | null> {
  if (!cleanPath.startsWith("/")) return null;
  let real: string;
  try {
    real = await realpath(cleanPath);
  } catch {
    return null;
  }
  for (const root of SERVER_FILE_ROOTS) {
    let base: string;
    try {
      base = (await realpath(root)).replace(/[/\\]+$/, "") + sep;
    } catch {
      base = root.replace(/[/\\]+$/, "") + sep;
    }
    if (real.startsWith(base)) {
      try {
        const st = await stat(real);
        if (st.isFile()) return real;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function backgroundPrefetchMedia(params: {
  devToken: string;
  deviceId: string;
  targetMachineName: string | null;
  cleanPath: string;
  totalSize: number;
  cachedPath: string;
  cacheKey: string;
  userScope: string;
}): Promise<void> {
  const partPath = `${params.cachedPath}.part`;
  try {
    await new Promise((r) => setTimeout(r, 3500));
    if (await fileMatchesSize(params.cachedPath, params.totalSize)) {
      rememberKnownCache(params.userScope, params.devToken, params.cleanPath, params.totalSize, params.cachedPath);
      return;
    }
    const chunkSize = 2 * 1024 * 1024;
    let curr = 0;
    try {
      const st = await stat(partPath);
      curr = st.size;
      if (curr > params.totalSize) {
        curr = 0;
        await unlink(partPath).catch(() => {});
      }
    } catch {
      curr = 0;
    }
    let firstWrite = curr === 0;
    while (curr < params.totalSize) {
      const readLen = Math.min(chunkSize, params.totalSize - curr);
      let chunk = await wsManager.requestFileChunk(params.devToken, params.cleanPath, curr, readLen);
      if ((!chunk || !chunk.length) && params.deviceId !== params.devToken) {
        chunk = await wsManager.requestFileChunk(params.deviceId, params.cleanPath, curr, readLen);
      }
      if ((!chunk || !chunk.length) && params.targetMachineName) {
        chunk = await wsManager.requestFileChunk(params.targetMachineName, params.cleanPath, curr, readLen);
      }
      if (!chunk || !chunk.length) return;
      await appendPartChunk(partPath, chunk, firstWrite);
      firstWrite = false;
      curr += chunk.length;
      await new Promise((r) => setTimeout(r, 5));
    }
    if (await fileMatchesSize(partPath, params.totalSize)) {
      await rename(partPath, params.cachedPath);
      rememberKnownCache(params.userScope, params.devToken, params.cleanPath, params.totalSize, params.cachedPath);
    }
  } catch {
    /* ignore background prefetch failure */
  } finally {
    activePrefetchTasks.delete(params.cacheKey);
    prefetchReserved.delete(params.cacheKey);
  }
}

async function statOnDevices(
  deps: Deps,
  user: UserRow,
  mids: string[] | null,
  deviceId: string,
  targetMachine: MachineRow | null,
  devToken: string,
  cleanPath: string,
  allowSeesAll = true,
): Promise<[Record<string, unknown>, string]> {
  let st = await wsManager.requestFileStat(devToken, cleanPath);
  const errMsg = String(st.error ?? "").toLowerCase();
  if (!st.exists && (errMsg.includes("not found") || errMsg.includes("enoent"))) return [st, devToken];
  if (!st.exists && deviceId !== devToken) st = await wsManager.requestFileStat(deviceId, cleanPath);
  if (!st.exists && targetMachine?.name) st = await wsManager.requestFileStat(targetMachine.name, cleanPath);

  if (!st.exists && (deviceId === "auto" || !targetMachine)) {
    const canSeeAll = allowSeesAll && seesAll(user, deps.settings);
    const machineList = canSeeAll
      ? await deps.db.select().from(machines)
      : mids && mids.length
        ? await deps.db.select().from(machines).where(inArray(machines.id, mids))
        : [];
    const candidates: string[] = [];
    for (const m of machineList) {
      for (const alias of [m.collectorTokenHash, m.name]) {
        if (alias && !candidates.includes(alias)) candidates.push(alias);
      }
    }
    if (canSeeAll) {
      for (const cid of wsManager.connectedIds()) if (!candidates.includes(cid)) candidates.push(cid);
    }
    for (const cand of candidates) {
      if (wsManager.hasDevice(cand) && cand !== devToken) {
        const cst = await wsManager.requestFileStat(cand, cleanPath, 5);
        if (cst.exists) return [cst, cand];
      }
    }
  }
  return [st, devToken];
}

function guessMime(cleanPath: string): string {
  const ext = extname(cleanPath).toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/mp4",
    ".srt": "text/vtt; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".ppt": "application/vnd.ms-powerpoint",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/vnd.ms-word",
    ".pdf": "application/pdf",
    ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".markdown": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".xml": "application/xml",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function iceServers(settings: Settings): string[] {
  return (settings.stunUrls || "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

const LOGIN_ACTIONS = new Set(["status", "start", "submit", "poll", "cancel"]);
const LOGIN_AGENTS = new Set(["", "claude", "codex", "agy"]);

export const deviceRoutes = new Hono<AppEnv>();

// 1. Device list with L1/L2 caching and ETag 304
deviceRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const incArch = parseBoolParam(c.req.query("include_archived"), false);
  const listCacheKey = `devices:list:${user.id}:${incArch ? "True" : "False"}`;
  const ifNoneMatch = c.req.header("if-none-match");

  const cached = (await cacheGet(c.var.deps.redis(), listCacheKey, 3)) as { etag?: string; data?: string } | null;
  if (cached && typeof cached === "object" && cached.etag && cached.data) {
    if (matchesEtag(ifNoneMatch, cached.etag)) {
      return new Response(null, { status: 304, headers: { ETag: cached.etag, "Cache-Control": "private, no-cache" } });
    }
    return new Response(cached.data, {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: cached.etag, "Cache-Control": "private, no-cache" },
    });
  }

  const conds = [isNull(machines.mergedInto)];
  if (!incArch) conds.push(eq(machines.isArchived, false));
  if (!seesAll(user, settings)) conds.push(eq(machines.userId, user.id));

  const machineList = await db
    .select()
    .from(machines)
    .where(and(...conds))
    .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`));

  const items: Record<string, unknown>[] = [];
  if (machineList.length) {
    const machineIds = machineList.map((m) => m.id);
    const statsCacheKey = `devices:stats:${user.id}:${incArch ? "True" : "False"}`;
    let totalsByName: Record<string, number> = {};
    let toolsByName: Record<string, string[]> = {};
    const cachedStats = (await cacheGet(c.var.deps.redis(), statsCacheKey)) as { totals?: Record<string, number>; tools?: Record<string, string[]> } | null;
    if (cachedStats && typeof cachedStats === "object") {
      totalsByName = cachedStats.totals ?? {};
      toolsByName = cachedStats.tools ?? {};
    } else {
      const statsRows = await db
        .select({ machineId: documents.machineId, toolId: documents.toolId, cnt: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(inArray(documents.machineId, machineIds), ne(documents.toolId, "system")))
        .groupBy(documents.machineId, documents.toolId);
      const nameByMid = new Map(machineList.map((m) => [m.id, m.name]));
      for (const r of statsRows) {
        const mname = r.machineId ? (nameByMid.get(r.machineId) ?? "") : "";
        totalsByName[mname] = (totalsByName[mname] ?? 0) + Number(r.cnt ?? 0);
        const list = (toolsByName[mname] ??= []);
        if (r.toolId && !list.includes(r.toolId)) list.push(r.toolId);
      }
      await cacheSet(c.var.deps.redis(), statsCacheKey, { totals: totalsByName, tools: toolsByName }, 60);
    }

    const collectByMid = await collectMetrics(c.var.deps, machineIds);
    const seenNames = new Set<string>();
    const nowMs = Date.now();
    for (const m of machineList) {
      if (seenNames.has(m.name)) continue;
      seenNames.add(m.name);
      const hbMs = parsePgTsMs(m.lastHeartbeat);
      const ageSec = hbMs !== null ? (nowMs - hbMs) / 1000 : null;
      const candidates = [m.collectorTokenHash, m.name, normalizeDeviceName(m.name), String(m.id)];
      const hasWs = candidates.some((cand) => Boolean(cand && wsManager.hasDevice(cand)));
      const isOnline = hasWs || (ageSec !== null && ageSec < 180);
      const isArch = Boolean(m.isArchived);
      const pStatus = (m.profileStatus && typeof m.profileStatus === "object" ? m.profileStatus : {}) as Record<string, unknown>;
      const cStatus = m.collectStatus && typeof m.collectStatus === "object" && Object.keys(m.collectStatus as object).length ? m.collectStatus : null;

      items.push({
        id: String(m.id),
        name: m.name,
        device_id: m.collectorTokenHash,
        collector_version: m.collectorVersion,
        last_heartbeat: pgToIso(m.lastHeartbeat),
        online: isOnline && !isArch,
        created_at: pgToIso(m.createdAt),
        document_count: totalsByName[m.name] ?? 0,
        tools: toolsByName[m.name] ?? [],
        is_archived: isArch,
        archived_at: pgToIso(m.archivedAt),
        direct_endpoints: Array.isArray(pStatus.direct_endpoints) ? pStatus.direct_endpoints : [],
        blueprint: pStatus.blueprint ?? null,
        agent_login: deviceHasFeature(m.name, "agent_login", user, settings),
        acp_agents: acpAgentsFor(m.name, user, settings),
        mcp: pStatus.mcp ?? null,
        collect: cStatus,
        ...(collectByMid[String(m.id)] ?? {}),
      });
    }
  }

  const serialized = JSON.stringify(items);
  const etag = `"${createHash("md5").update(serialized, "utf8").digest("hex")}"`;
  await cacheSet(c.var.deps.redis(), listCacheKey, { etag, data: serialized }, 5);

  if (matchesEtag(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
  }
  return new Response(serialized, {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag, "Cache-Control": "private, no-cache" },
  });
});

// 2. Collector command polling (must come before /:device_db_id)
deviceRoutes.get("/commands", async (c) => {
  const xDeviceId = requiredHeader(c, "x-device-id");
  const xVersion = c.req.header("x-collector-version") ?? "";
  const [machine] = await c.var.deps.db.select().from(machines).where(eq(machines.collectorTokenHash, xDeviceId)).limit(1);
  if (machine) {
    const patch: Partial<typeof machines.$inferInsert> = {};
    if (shouldWriteHeartbeat(machine.lastHeartbeat, Date.now())) patch.lastHeartbeat = new Date().toISOString();
    if (xVersion && machine.collectorVersion !== xVersion) patch.collectorVersion = xVersion;
    if (Object.keys(patch).length) {
      await c.var.deps.db.update(machines).set(patch).where(eq(machines.id, machine.id));
    }
  }
  return c.json(await listPendingCommands(xDeviceId));
});

deviceRoutes.post("/commands/:cmd_id/ack", async (c) => {
  const xDeviceId = requiredHeader(c, "x-device-id");
  const cmdId = Number(c.req.param("cmd_id"));
  if (!Number.isInteger(cmdId)) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["path", "cmd_id"], msg: "Invalid integer", input: c.req.param("cmd_id") }]);
  }
  await ackDeviceCommand(xDeviceId, cmdId);
  return c.json({ status: "acked", command_id: cmdId });
});

// 3. Discovery
deviceRoutes.get("/:device_db_id/discovery", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);
  const [doc] = await c.var.deps.db
    .select()
    .from(documents)
    .where(and(eq(documents.toolId, "system"), eq(documents.category, "discovery"), eq(documents.machineId, deviceDbId)))
    .orderBy(desc(documents.syncedAt))
    .limit(1);
  if (!doc || !doc.content) return c.json({ device_id: deviceDbId, tools: {} });
  let toolsData: unknown = {};
  try {
    toolsData = JSON.parse(doc.content);
  } catch {
    toolsData = {};
  }
  return c.json({ device_id: deviceDbId, device_name: machine.name, synced_at: pgToIso(doc.syncedAt), tools: toolsData });
});

// 4. Delete / Archive / Unarchive / Purge
deviceRoutes.delete("/:device_db_id", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const keepData = parseBoolParam(c.req.query("keep_data"), false);
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);

  if (keepData) {
    await c.var.deps.db
      .update(machines)
      .set({ isArchived: true, archivedAt: new Date().toISOString() })
      .where(eq(machines.id, deviceDbId));
    await invalidateDeviceCaches(c.var.deps, user.id);
    return c.json({
      status: "archived",
      device_id: deviceDbId,
      name: machine.name,
      keep_data: true,
      documents_deleted: 0,
      orphaned_entities_deleted: 0,
      orphaned_projects_deleted: 0,
    });
  }
  const stats = await purgeDeviceData(c.var.deps.db, deviceDbId, true);
  await c.var.deps.db.delete(machines).where(eq(machines.id, deviceDbId));
  await invalidateDeviceCaches(c.var.deps, user.id);
  return c.json({ status: "deleted", device_id: deviceDbId, name: machine.name, keep_data: false, ...stats });
});

deviceRoutes.post("/:device_db_id/archive", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);
  await c.var.deps.db
    .update(machines)
    .set({ isArchived: true, archivedAt: new Date().toISOString() })
    .where(eq(machines.id, deviceDbId));
  await invalidateDeviceCaches(c.var.deps, user.id);
  return c.json({ status: "archived", device_id: deviceDbId, name: machine.name, keep_data: true });
});

deviceRoutes.post("/:device_db_id/unarchive", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);
  await c.var.deps.db.update(machines).set({ isArchived: false, archivedAt: null }).where(eq(machines.id, deviceDbId));
  await invalidateDeviceCaches(c.var.deps, user.id);
  return c.json({ status: "unarchived", device_id: deviceDbId, name: machine.name });
});

deviceRoutes.delete("/:device_db_id/purge", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);
  const stats = await purgeDeviceData(c.var.deps.db, deviceDbId, false);
  await invalidateDeviceCaches(c.var.deps, user.id);
  return c.json({ status: "purged", device_id: deviceDbId, name: machine.name, ...stats });
});

// 5. Queue command to device
deviceRoutes.post("/:device_db_id/command", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const action = c.req.query("action") || "resync";
  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);

  if (action === "resync") {
    const docRows = await c.var.deps.db.select({ id: documents.id }).from(documents).where(eq(documents.machineId, deviceDbId));
    const docIds = docRows.map((r) => r.id);
    for (let i = 0; i < docIds.length; i += 500) {
      const batch = docIds.slice(i, i + 500);
      await c.var.deps.db.delete(documentEmbeddings).where(inArray(documentEmbeddings.documentId, batch));
      await c.var.deps.db.delete(knowledgeObservations).where(inArray(knowledgeObservations.sourceDocumentId, batch));
    }
    if (docIds.length) {
      await c.var.deps.db.execute(sql`UPDATE documents SET metadata = metadata - '_graph_hash' WHERE machine_id = ${deviceDbId}::uuid AND metadata ? '_graph_hash'`);
    }
  }

  const cmdId = await enqueueCommand(machine.collectorTokenHash, action);
  await wsManager.sendJson(machine.collectorTokenHash, { type: "commands_pending" }).catch(() => {});
  return c.json({ status: "queued", command_id: cmdId, action, device: machine.name });
});

// 6. File locate & P2P offer & Agent CLI login
async function authorizedMachine(c: { var: { deps: Deps }; req: { path: string; method: string; header: (k: string) => string | undefined; raw: Request } }, deviceId: string, user: UserRow) {
  const { db, settings } = c.var.deps;
  const targetMachine = await findMachineByIdOrHash(db, settings, deviceId, user);
  const mids = await userMachineIds(db, user, settings);
  if (!seesAll(user, settings) && targetMachine && mids !== null && !mids.includes(targetMachine.id)) {
    throw new HttpError(403, "Device access denied");
  }
  if (targetMachine && targetMachine.userId && targetMachine.userId !== user.id) {
    await recordAudit(db, user, "device.access_other_user", auditRequest(c as never), {
      targetUserId: targetMachine.userId,
      detail: { device: targetMachine.name },
    });
  }
  return { targetMachine, mids };
}

deviceRoutes.get("/:device_id/files/locate", async (c) => {
  const user = await currentUser(c);
  const deviceId = c.req.param("device_id");
  const pathParam = queryRequiredString(c, "path");
  const { targetMachine, mids } = await authorizedMachine(c, deviceId, user);
  const cleanPath = cleanDevicePath(pathParam);
  const userScope = userCacheScope(user);
  const devScope = targetMachine?.collectorTokenHash || deviceId;

  if (
    (await serverFile(cleanPath)) ||
    lookupKnownCache(userScope, devScope, cleanPath) !== null ||
    (chatImageStorageKey(user.id, cleanPath) && (await loadChatImage(c.var.deps.settings, user.id, cleanPath)))
  ) {
    return c.json({ local: true });
  }
  const cached = await getCachedStat(cleanPath, userScope);
  if (cached && cached[0] > 0 && (deviceId === "auto" || !targetMachine)) {
    return c.json({ device: cached[1], size: cached[0], ice_servers: iceServers(c.var.deps.settings) });
  }
  const initialToken = targetMachine ? targetMachine.collectorTokenHash : deviceId;
  const [st, devToken] = await statOnDevices(c.var.deps, user, mids, deviceId, targetMachine, initialToken, cleanPath);
  if (!st.exists) {
    throw new HttpError(404, `File not found on any online device: ${String(st.error || "offline")}`);
  }
  const size = Number(st.size ?? st.total_size ?? 0);
  if (size > 0) await setCachedStat(cleanPath, size, devToken, userScope);
  return c.json({ device: devToken, size, ice_servers: iceServers(c.var.deps.settings) });
});

deviceRoutes.post("/:device_id/p2p/offer", async (c) => {
  const user = await currentUser(c);
  const deviceId = c.req.param("device_id");
  const body = await parseJsonObject(c);
  if (typeof body.sdp !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", "sdp"], msg: "Input should be a valid string", input: body.sdp }]);
  }
  const { targetMachine } = await authorizedMachine(c, deviceId, user);
  if (!targetMachine && !seesAll(user, c.var.deps.settings)) throw new HttpError(404, "Unknown device");
  const token = targetMachine?.collectorTokenHash || deviceId;
  if (!wsManager.hasDevice(token)) throw new HttpError(409, "Device is offline");
  const res = await wsManager.requestP2pAnswer(token, body.sdp, iceServers(c.var.deps.settings));
  if (res.error || !res.sdp) throw new HttpError(502, String(res.error || "no answer from device"));
  return c.json({ sdp: res.sdp });
});

deviceRoutes.post("/:device_db_id/agent-login", async (c) => {
  const user = await currentUser(c);
  const deviceDbId = pathUuid(c, "device_db_id");
  const body = await parseJsonObject(c);
  const action = typeof body.action === "string" ? body.action : "status";
  const agent = typeof body.agent === "string" ? body.agent : "";
  const code = typeof body.code === "string" ? body.code : "";
  if (!LOGIN_ACTIONS.has(action) || !LOGIN_AGENTS.has(agent) || (action !== "status" && !agent)) {
    throw new HttpError(400, "Bad action or agent");
  }
  if (code.length > 4096) throw new HttpError(400, "Code too long");

  const machine = await verifyDeviceOwnership(c.var.deps.db, c.var.deps.settings, deviceDbId, user);
  const token = [machine.collectorTokenHash, machine.name, normalizeDeviceName(machine.name)].find((x) => Boolean(x && wsManager.hasDevice(x)));
  if (!token) throw new HttpError(409, "设备不在线");
  if (!deviceHasFeature(machine.name, "agent_login", user, c.var.deps.settings)) {
    throw new HttpError(409, "这台设备的 Memento 还不支持在网页上登录智能体，升级到 1.0.106 及以上");
  }
  const timeoutSec = action === "start" ? 30 : action === "submit" ? 60 : 40;
  const res = await wsManager.requestDevice(token, { type: "agent_login_req", action, agent, code }, timeoutSec);
  if (res.error) throw new HttpError(res.code === "timeout" ? 504 : 502, String(res.error));
  const out = { ...res };
  delete out.type;
  delete out.req_id;
  return c.json(out);
});

// 7. File streaming (GET & HEAD, with or without /:filename)
async function handleStreamDeviceFile(c: Context<AppEnv>, filenameParam?: string): Promise<Response> {
  const { db, settings } = c.var.deps;
  const deviceId = c.req.param("device_id") ?? "";
  const pathParam = queryRequiredString(c, "path");
  const shareToken = c.req.query("share_token") ?? null;
  const fileExp = queryOptionalInt(c, "file_exp");
  const fileSig = c.req.query("file_sig") ?? null;

  let cleanPath = cleanDevicePath(pathParam);
  const rawCleanPath = cleanPath;
  let isShareAccess = false;
  let user: UserRow | null = await optionalUser(c);

  if (!user) {
    const effectiveToken = shareToken || c.req.query("token") || null;
    if (effectiveToken) {
      const [stLink] = await db
        .select()
        .from(shareLinks)
        .where(and(eq(shareLinks.token, effectiveToken), isNull(shareLinks.revokedAt)))
        .limit(1);
      if (stLink) {
        const expMs = parsePgTsMs(stLink.expiresAt);
        const expired = expMs !== null && expMs <= Date.now();
        if (expired || stLink.targetUserId !== null) throw new HttpError(403, "Share link expired or restricted");
        if (deviceId === "auto" || !shareFileSignatureOk(settings.secretKey, effectiveToken, deviceId, rawCleanPath, fileExp, fileSig)) {
          throw new HttpError(403, "Share file link expired or not signed");
        }
        const [owner] = await db.select().from(users).where(eq(users.id, stLink.ownerUserId)).limit(1);
        if (!owner || owner.status !== "active") throw new HttpError(403, "Share owner inactive");
        user = owner;
        isShareAccess = true;
      }
    }
  }
  if (!user) user = await currentUserFlexible(c);

  const targetMachine = await findMachineByIdOrHash(db, settings, deviceId, user);
  const mids = await userMachineIds(db, user, settings);
  const allowSeesAll = !isShareAccess && seesAll(user, settings);
  if (!allowSeesAll) {
    if (targetMachine && mids !== null && !mids.includes(targetMachine.id)) throw new HttpError(403, "Device access denied");
    if (isShareAccess && (!targetMachine || (mids !== null && !mids.includes(targetMachine.id)))) {
      throw new HttpError(403, "Device access denied");
    }
  }

  const ext = extname(cleanPath).toLowerCase();
  const mimeType = guessMime(cleanPath);

  const kept = await loadChatImage(settings, user.id, rawCleanPath);
  if (kept) {
    const [data, keptType] = kept;
    return new Response(c.req.method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": keptType,
        "Content-Length": String(data.length),
        "Cache-Control": "private, max-age=86400",
        "Accept-Ranges": "none",
      },
    });
  }

  const userScope = userCacheScope(user);
  let devToken = targetMachine ? targetMachine.collectorTokenHash : deviceId;
  let cacheKey = "";
  let totalSize = 0;

  let srvCopy = await serverFile(cleanPath);
  if (!srvCopy && cleanPath.includes("_720p")) srvCopy = await serverFile(cleanPath.replace("_720p", ""));
  let isLocal = srvCopy !== null;
  if (srvCopy) cleanPath = srvCopy;

  const cacheDir = await getMediaCacheDir();
  if (!isLocal) {
    const known = lookupKnownCache(userScope, devToken, rawCleanPath);
    if (known && (await fileMatchesSize(known[1], known[0]))) {
      cleanPath = known[1];
      isLocal = true;
      totalSize = known[0];
    }
  }

  if (isLocal) {
    if (totalSize <= 0) totalSize = (await stat(cleanPath)).size;
  } else {
    const cachedStat = await getCachedStat(rawCleanPath, userScope);
    if (cachedStat && cachedStat[0] > 0) {
      totalSize = cachedStat[0];
      if (!isShareAccess && (deviceId === "auto" || !targetMachine)) devToken = cachedStat[1];
    }
    if (totalSize <= 0) {
      const negKey = `${userScope}:${devToken}:${rawCleanPath}`;
      const negTs = negativeStatCache.get(negKey);
      if (negTs !== undefined && Date.now() / 1000 - negTs < 60) {
        throw new HttpError(404, `File not found on device (cached 404): ${rawCleanPath}`);
      }
      const [st, resolvedToken] = await statOnDevices(c.var.deps, user, mids, deviceId, targetMachine, devToken, cleanPath, allowSeesAll);
      devToken = resolvedToken;
      const errMsg = String(st.error ?? "");
      if (!st.exists && (errMsg.toLowerCase().includes("not found") || errMsg.toLowerCase().includes("enoent"))) {
        negativeStatCache.set(negKey, Date.now() / 1000);
        if (negativeStatCache.size > 2000) {
          const now = Date.now() / 1000;
          for (const [k, ts] of [...negativeStatCache.entries()]) if (now - ts > 60) negativeStatCache.delete(k);
        }
      }
      if (!st.exists) {
        const msg = errMsg || "offline";
        if (msg === "offline") throw new HttpError(404, `Target device is offline or disconnected from WebSocket: ${deviceId}`);
        throw new HttpError(404, `File not found on device (${cleanPath}): ${msg}`);
      }
      totalSize = Number(st.size ?? st.total_size ?? 0);
      if (totalSize > 0 && devToken) await setCachedStat(rawCleanPath, totalSize, devToken, userScope);
    }

    if (totalSize > 0) {
      cacheKey = diskCacheKey(userScope, devToken, rawCleanPath, totalSize);
      const cachedFilePath = join(cacheDir, `${cacheKey}${ext}`);
      if (await fileMatchesSize(cachedFilePath, totalSize)) {
        cleanPath = cachedFilePath;
        isLocal = true;
        rememberKnownCache(userScope, devToken, rawCleanPath, totalSize, cachedFilePath);
      }
    }
  }

  const etagKey = createHash("sha256").update(`${userScope}:${devToken}:${rawCleanPath}:${totalSize}`, "utf8").digest("hex").slice(0, 24);
  const etag = `"${etagKey}"`;
  const rangeHeader = c.req.header("range");
  const ifNoneMatch = c.req.header("if-none-match");
  if (ifNoneMatch && ifNoneMatch.replace(/^[ "]+|[ "]+$/g, "") === etagKey && !rangeHeader) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const [start, end, statusCode] = parseByteRange(rangeHeader, totalSize);
  const contentLength = totalSize > 0 ? end - start + 1 : 0;

  if (!isLocal && totalSize > 0 && totalSize <= 250 * 1024 * 1024) {
    cacheKey = diskCacheKey(userScope, devToken, rawCleanPath, totalSize);
    const cachedFilePath = join(cacheDir, `${cacheKey}${ext}`);
    const isProbe = start === 0 && end <= 1;
    if (!isProbe && !activePrefetchTasks.has(cacheKey) && (await makeRoomFor(cacheDir, totalSize))) {
      prefetchReserved.set(cacheKey, totalSize);
      activePrefetchTasks.add(cacheKey);
      cluster.spawn(() =>
        backgroundPrefetchMedia({
          devToken,
          deviceId,
          targetMachineName: targetMachine?.name ?? null,
          cleanPath: rawCleanPath,
          totalSize,
          cachedPath: cachedFilePath,
          cacheKey,
          userScope,
        }),
      );
    }
  }

  const quotedFname = encodeURIComponent(filenameParam || basename(rawCleanPath) || "media-file");
  const headers: Record<string, string> = {
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Content-Length": String(contentLength),
    "Content-Disposition": `inline; filename="${quotedFname}"; filename*=UTF-8''${quotedFname}`,
    ETag: etag,
    "Cache-Control": "private, max-age=604800, stale-while-revalidate=86400",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range, Authorization, Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Disposition, ETag, Cache-Control",
  };
  if (SANDBOXED_INLINE_EXTS.has(ext) || mimeType.startsWith("text/html") || mimeType.startsWith("image/svg") || mimeType.startsWith("application/xhtml")) {
    headers["Content-Security-Policy"] = "sandbox";
  }
  if (statusCode === 206) headers["Content-Range"] = `bytes ${start}-${end}/${totalSize}`;

  if (c.req.method === "HEAD") return new Response(null, { status: statusCode, headers });

  const localCopy = isLocal;
  const streamPath = cleanPath;
  const finalDevToken = devToken;
  const finalCacheKey = cacheKey;
  const finalTargetName = targetMachine?.name ?? null;

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let curr = start;
      try {
        if (localCopy) {
          const chunkSize = 1024 * 1024;
          while (curr <= end && totalSize > 0 && !cancelled) {
            const readLen = Math.min(chunkSize, end - curr + 1);
            const data = await readLocalSlice(streamPath, curr, readLen);
            if (!data.length) break;
            curr += data.length;
            controller.enqueue(new Uint8Array(data));
          }
        } else {
          const chunkSize = 512 * 1024;
          const fetchChunk = async (offset: number, length: number): Promise<Buffer | null> => {
            let ch = await wsManager.requestFileChunk(finalDevToken, streamPath, offset, length);
            if ((!ch || !ch.length) && deviceId !== finalDevToken) ch = await wsManager.requestFileChunk(deviceId, streamPath, offset, length);
            if ((!ch || !ch.length) && finalTargetName) ch = await wsManager.requestFileChunk(finalTargetName, streamPath, offset, length);
            return ch;
          };

          if (curr === 0 && end <= 1 && totalSize > 0) {
            const probe = await fetchChunk(0, Math.min(chunkSize, totalSize));
            if (probe && probe.length) {
              if (finalCacheKey) setInitialChunk(finalCacheKey, probe);
              controller.enqueue(new Uint8Array(probe.subarray(0, end + 1)));
              controller.close();
              return;
            }
          }

          let nextPromise: Promise<Buffer | null> | null = null;
          const init = finalCacheKey ? getInitialChunk(finalCacheKey) : null;
          if (init && curr === 0 && totalSize > 0) {
            const avail = Math.min(init.length, end - curr + 1);
            if (avail > 0) {
              controller.enqueue(new Uint8Array(init.subarray(0, avail)));
              curr += avail;
              if (curr > end) {
                controller.close();
                return;
              }
              nextPromise = fetchChunk(curr, Math.min(chunkSize, end - curr + 1));
            }
          }

          while (curr <= end && totalSize > 0 && !cancelled) {
            const readLen = Math.min(chunkSize, end - curr + 1);
            const chunk = nextPromise ? await nextPromise.catch(() => null) : await fetchChunk(curr, readLen).catch(() => null);
            nextPromise = null;
            if (!chunk || !chunk.length) break;
            curr += chunk.length;
            if (curr <= end && !cancelled) {
              nextPromise = fetchChunk(curr, Math.min(chunkSize, end - curr + 1));
            }
            controller.enqueue(new Uint8Array(chunk));
          }
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      } catch {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(body, { status: statusCode, headers });
}

deviceRoutes.get("/:device_id/files/stream", (c) => handleStreamDeviceFile(c));
deviceRoutes.on("HEAD", "/:device_id/files/stream", (c) => handleStreamDeviceFile(c));
deviceRoutes.get("/:device_id/files/stream/:filename", (c) => handleStreamDeviceFile(c, c.req.param("filename")));
deviceRoutes.on("HEAD", "/:device_id/files/stream/:filename", (c) => handleStreamDeviceFile(c, c.req.param("filename")));
