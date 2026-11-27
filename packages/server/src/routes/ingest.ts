// Ingest API (server/server/api/ingest.py): /api/ingest/* (/file, /files, /reconcile, /discovery, /heartbeat, /lan-hello).
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Redis } from "ioredis";

import { verifyCollectorToken } from "../auth/current-user";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { machines, syncState } from "../db/pulled/schema";
import { HttpError, parseJsonObject, parseOptionalJsonObject } from "../http";
import { ensureDevice } from "../services/device-service";
import {
  claimSlice,
  ensureProject,
  ingestFile,
  isInvalidProjectName,
  lockSlice,
  OffsetMismatch,
  prettifyProjectName,
} from "../services/ingest-service";
import { droppedSlice, ProjectExcluded } from "../services/project-exclusion";

export const ingestRoutes = new Hono<AppEnv>();

// Cap concurrent ingest handlers at 24 so collector sync storms never starve web UI DB slots
const MAX_CONCURRENT_INGEST = 24;
let activeIngest = 0;
const ingestWaiters: (() => void)[] = [];

async function withIngestSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeIngest >= MAX_CONCURRENT_INGEST) {
    await new Promise<void>((resolve) => ingestWaiters.push(resolve));
  }
  activeIngest++;
  try {
    return await fn();
  } finally {
    activeIngest--;
    const next = ingestWaiters.shift();
    if (next) next();
  }
}

interface IngestFileReq {
  tool: string;
  category: string;
  content_type: string;
  relative_path: string;
  hash: string;
  mode: string;
  offset: number;
  file_size: number;
  sync_strategy: string;
  metadata: Record<string, unknown>;
  timestamp: number | null;
  content: string;
  end_offset: number | null;
}

function parseIngestFileReq(raw: unknown, prefix: (string | number)[] = ["body"]): IngestFileReq {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(422, [{ type: "model_attributes_type", loc: prefix, msg: "Input should be a valid dictionary or object", input: raw }]);
  }
  const b = raw as Record<string, unknown>;
  const reqStr = (k: string): string => {
    if (!(k in b)) throw new HttpError(422, [{ type: "missing", loc: [...prefix, k], msg: "Field required", input: b }]);
    if (typeof b[k] !== "string") throw new HttpError(422, [{ type: "string_type", loc: [...prefix, k], msg: "Input should be a valid string", input: b[k] }]);
    return b[k] as string;
  };
  const optStr = (k: string, def: string): string => {
    if (!(k in b) || b[k] === undefined) return def;
    if (typeof b[k] !== "string") throw new HttpError(422, [{ type: "string_type", loc: [...prefix, k], msg: "Input should be a valid string", input: b[k] }]);
    return b[k] as string;
  };
  const optInt = (k: string, def: number): number => {
    if (!(k in b) || b[k] === undefined) return def;
    if (typeof b[k] !== "number" || !Number.isInteger(b[k])) throw new HttpError(422, [{ type: "int_parsing", loc: [...prefix, k], msg: "Input should be a valid integer", input: b[k] }]);
    return b[k] as number;
  };
  const optNullableInt = (k: string): number | null => {
    if (!(k in b) || b[k] === undefined || b[k] === null) return null;
    if (typeof b[k] !== "number" || !Number.isInteger(b[k])) throw new HttpError(422, [{ type: "int_parsing", loc: [...prefix, k], msg: "Input should be a valid integer", input: b[k] }]);
    return b[k] as number;
  };
  const optNullableNum = (k: string): number | null => {
    if (!(k in b) || b[k] === undefined || b[k] === null) return null;
    if (typeof b[k] !== "number" || !Number.isFinite(b[k])) throw new HttpError(422, [{ type: "float_parsing", loc: [...prefix, k], msg: "Input should be a valid number", input: b[k] }]);
    return b[k] as number;
  };
  let metadata: Record<string, unknown> = {};
  if ("metadata" in b && b.metadata !== undefined) {
    if (!b.metadata || typeof b.metadata !== "object" || Array.isArray(b.metadata)) {
      throw new HttpError(422, [{ type: "dict_type", loc: [...prefix, "metadata"], msg: "Input should be a valid dictionary", input: b.metadata }]);
    }
    metadata = b.metadata as Record<string, unknown>;
  }
  return {
    tool: reqStr("tool"),
    category: reqStr("category"),
    content_type: reqStr("content_type"),
    relative_path: reqStr("relative_path"),
    hash: reqStr("hash"),
    mode: optStr("mode", "full"),
    offset: optInt("offset", 0),
    file_size: optInt("file_size", 0),
    sync_strategy: optStr("sync_strategy", "full"),
    metadata,
    timestamp: optNullableNum("timestamp"),
    content: optStr("content", ""),
    end_offset: optNullableInt("end_offset"),
  };
}

async function ingestOne(db: Db, redis: Redis | null, f: IngestFileReq, machineId: string, userId: string): Promise<[string, number | null]> {
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as Db;
    if (await droppedSlice(tdb, userId, machineId, f.tool, f.relative_path, f.hash, f.offset, f.end_offset)) {
      return ["", f.end_offset];
    }
    if (f.end_offset !== null) {
      const claimed = await claimSlice(tdb, f.tool, f.relative_path, machineId, f.mode, f.offset, f.end_offset);
      if (claimed) return [claimed[0], claimed[1]];
    } else {
      await lockSlice(tdb, machineId, f.tool, f.relative_path);
    }
    try {
      const doc = await ingestFile({
        db: tdb,
        redis,
        toolId: f.tool,
        category: f.category,
        contentType: f.content_type,
        relativePath: f.relative_path,
        content: f.content,
        contentHash: f.hash,
        fileSize: f.file_size || Buffer.byteLength(f.content, "utf8"),
        mode: f.mode,
        offset: f.offset,
        metadata: f.metadata,
        timestamp: f.timestamp,
        machineId,
        userId,
        endOffset: f.end_offset,
      });
      return [doc.id, f.end_offset];
    } catch (e) {
      if (e instanceof ProjectExcluded) return ["", f.end_offset];
      throw e;
    }
  });
}

ingestRoutes.post("/file", async (c) => {
  const user = await verifyCollectorToken(c);
  const { db, redis } = c.var.deps;
  const body = await parseJsonObject(c);
  const req = parseIngestFileReq(body);
  const deviceId = c.req.header("x-device-id") ?? "unknown";
  const deviceName = c.req.header("x-device-name") ?? "unknown";
  const devicePlatform = c.req.header("x-device-platform") ?? "unknown";

  return withIngestSlot(async () => {
    const machine = await ensureDevice(db, deviceId, deviceName, devicePlatform, user.id);
    try {
      const [docId, nextOffset] = await ingestOne(db, redis(), req, machine.id, user.id);
      return c.json({ status: "ok", document_id: docId, message: "Ingested successfully", next_offset: nextOffset });
    } catch (e) {
      if (e instanceof OffsetMismatch) {
        throw new HttpError(409, { expected_offset: e.expected });
      }
      throw e;
    }
  });
});

ingestRoutes.post("/files", async (c) => {
  const user = await verifyCollectorToken(c);
  const { db, redis } = c.var.deps;
  const body = await parseJsonObject(c);
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 100) {
    throw new HttpError(422, [{ type: "list_type", loc: ["body", "files"], msg: "files must be a list of 1..100 items", input: body.files }]);
  }
  const files = body.files.map((item, i) => parseIngestFileReq(item, ["body", "files", i]));
  const deviceId = c.req.header("x-device-id") ?? "unknown";
  const deviceName = c.req.header("x-device-name") ?? "unknown";
  const devicePlatform = c.req.header("x-device-platform") ?? "unknown";

  return withIngestSlot(async () => {
    const machine = await ensureDevice(db, deviceId, deviceName, devicePlatform, user.id);
    const results: Record<string, unknown>[] = [];
    const r = redis();
    for (const f of files) {
      try {
        const [docId, nextOffset] = await ingestOne(db, r, f, machine.id, user.id);
        results.push({ ok: true, document_id: docId, next_offset: nextOffset });
      } catch (e) {
        if (e instanceof OffsetMismatch) {
          results.push({ ok: false, expected_offset: e.expected });
        } else {
          results.push({ ok: false, error: String(e).slice(0, 200) });
        }
      }
    }
    return c.json({ status: "ok", results });
  });
});

ingestRoutes.post("/reconcile", async (c) => {
  const user = await verifyCollectorToken(c);
  const { db } = c.var.deps;
  const body = await parseJsonObject(c);
  if (!Array.isArray(body.files) || body.files.length > 1000) {
    throw new HttpError(422, [{ type: "list_type", loc: ["body", "files"], msg: "files must be a list of at most 1000 items", input: body.files }]);
  }
  const rawFiles = body.files;
  const deviceId = c.req.header("x-device-id") ?? "unknown";
  const deviceName = c.req.header("x-device-name") ?? "unknown";
  const devicePlatform = c.req.header("x-device-platform") ?? "unknown";

  return withIngestSlot(async () => {
    const machine = await ensureDevice(db, deviceId, deviceName, devicePlatform, user.id);
    const wanted = new Map<string, number>();
    const pairs: [string, string][] = [];
    for (let i = 0; i < rawFiles.length; i++) {
      const f = rawFiles[i];
      if (!f || typeof f !== "object" || Array.isArray(f)) {
        throw new HttpError(422, [{ type: "model_attributes_type", loc: ["body", "files", i], msg: "Invalid item", input: f }]);
      }
      const rec = f as Record<string, unknown>;
      if (typeof rec.tool !== "string" || typeof rec.relative_path !== "string" || typeof rec.offset !== "number" || !Number.isInteger(rec.offset)) {
        throw new HttpError(422, [{ type: "value_error", loc: ["body", "files", i], msg: "tool, relative_path and integer offset required", input: f }]);
      }
      const key = `${rec.tool}\x00${rec.relative_path}`;
      if (!wanted.has(key)) pairs.push([rec.tool, rec.relative_path]);
      wanted.set(key, rec.offset);
    }

    const out: { tool: string; relative_path: string; expected_offset: number }[] = [];
    if (pairs.length) {
      const tuples = sql.join(
        pairs.map(([t, p]) => sql`(${t}, ${p})`),
        sql`, `,
      );
      const rows = await db
        .select({ toolId: syncState.toolId, relativePath: syncState.relativePath, lastEndOffset: syncState.lastEndOffset })
        .from(syncState)
        .where(and(eq(syncState.machineId, machine.id), isNotNull(syncState.lastEndOffset), sql`(${syncState.toolId}, ${syncState.relativePath}) IN (${tuples})`));
      for (const r of rows) {
        if (r.toolId && r.lastEndOffset !== null && wanted.get(`${r.toolId}\x00${r.relativePath}`) !== r.lastEndOffset) {
          out.push({ tool: r.toolId, relative_path: r.relativePath, expected_offset: r.lastEndOffset });
        }
      }
    }
    return c.json({ status: "ok", files: out });
  });
});

ingestRoutes.post("/discovery", async (c) => {
  const user = await verifyCollectorToken(c);
  const { db, redis } = c.var.deps;
  const req = await parseJsonObject(c);
  const deviceId = typeof req.device_id === "string" ? req.device_id : "unknown";
  const deviceName = typeof req.device_name === "string" ? req.device_name : "";
  const platform = typeof req.platform === "string" ? req.platform : "";

  return withIngestSlot(async () => {
    const machine = await ensureDevice(db, deviceId, deviceName, platform, user.id);
    const toolsData = (req.tools && typeof req.tools === "object" && !Array.isArray(req.tools) ? structuredClone(req.tools) : {}) as Record<string, unknown>;

    for (const [tId, info] of Object.entries(toolsData)) {
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      const toolInfo = info as Record<string, unknown>;
      if (typeof toolInfo.root === "string") {
        let r = toolInfo.root;
        try {
          r = decodeURIComponent(r);
        } catch {
          /* ignore */
        }
        toolInfo.root = r.replace(/^\\\\?\?\\/, "");
      }
      if (Array.isArray(toolInfo.projects)) {
        for (const proj of toolInfo.projects) {
          if (!proj || typeof proj !== "object" || Array.isArray(proj)) continue;
          const pr = proj as Record<string, unknown>;
          if (typeof pr.path === "string") {
            let p = pr.path;
            try {
              p = decodeURIComponent(p);
            } catch {
              /* ignore */
            }
            pr.path = p.replace(/^\\\\?\?\\/, "");
          }
          const pPath = typeof pr.path === "string" ? pr.path : null;
          const pName = (typeof pr.name === "string" && pr.name) || (pPath || "").replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || "";
          if (pName) {
            const cleanName = prettifyProjectName(pName);
            if (cleanName && !isInvalidProjectName(cleanName)) {
              try {
                await ensureProject(db, tId, cleanName, pPath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    }

    const discoveryContent = JSON.stringify(toolsData, null, 2);
    const contentHash = createHash("sha256").update(discoveryContent, "utf8").digest("hex");
    await ingestFile({
      db,
      redis: redis(),
      toolId: "system",
      category: "discovery",
      contentType: "json",
      relativePath: `discovery/${deviceId}.json`,
      content: discoveryContent,
      contentHash,
      fileSize: discoveryContent.length,
      mode: "full",
      offset: 0,
      metadata: { device_id: deviceId, device_name: deviceName, platform, tool_count: Object.keys(toolsData).length },
      machineId: machine.id,
      userId: user.id,
    });
    return c.json({ status: "ok", tools_discovered: Object.keys(toolsData).length });
  });
});

function lanKey(secretKey: string, deviceId: string): string {
  return createHmac("sha256", secretKey).update(`lan:${deviceId}`, "utf8").digest("hex");
}

function isPrivateOrLoopback(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/i, "");
  const v = isIP(clean);
  if (v === 4) {
    const [a, b] = clean.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (v === 6) {
    const low = clean.toLowerCase();
    return low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80:");
  }
  return false;
}

function cameFromLan(xff: string | undefined, remoteAddr: string | null): boolean {
  const hops = (xff ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (!hops.length && remoteAddr) hops.push(remoteAddr);
  return hops.length > 0 && hops.every(isPrivateOrLoopback);
}

ingestRoutes.post("/heartbeat", async (c) => {
  const user = await verifyCollectorToken(c);
  const { db, settings } = c.var.deps;
  const deviceId = c.req.header("x-device-id") ?? "unknown";
  const deviceName = c.req.header("x-device-name") ?? "unknown";
  const devicePlatform = c.req.header("x-device-platform") ?? "unknown";

  return withIngestSlot(async () => {
    let machine = await ensureDevice(db, deviceId, deviceName, devicePlatform, user.id);
    let body: Record<string, unknown> | null = null;
    try {
      body = await parseOptionalJsonObject(c);
    } catch {
      body = null;
    }
    const collect = body?.collect;
    if (collect && typeof collect === "object" && !Array.isArray(collect) && JSON.stringify(collect).length <= 16_000) {
      const nextStatus = { ...(collect as Record<string, unknown>), reported_at: new Date().toISOString().replace("Z", "+00:00") };
      const [updated] = await db.update(machines).set({ collectStatus: nextStatus }).where(eq(machines.id, machine.id)).returning();
      if (updated) machine = updated;
    }

    const resp: Record<string, unknown> = {
      status: "ok",
      device_id: machine.id,
      received_at: new Date().toISOString().replace("Z", "+00:00"),
    };
    const lanUrls = settings.lanUrls
      .split(",")
      .map((u) => u.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    if (lanUrls.length) {
      resp.lan = { urls: lanUrls, key: lanKey(settings.secretKey, deviceId) };
    }
    if (settings.remoteExec) {
      let key = machine.remoteExecKey;
      if (!key) {
        key = randomBytes(32).toString("base64url");
        await db.update(machines).set({ remoteExecKey: key }).where(eq(machines.id, machine.id));
      }
      resp.remote_exec_key = key;
    }
    return c.json(resp);
  });
});

ingestRoutes.get("/lan-hello", (c) => {
  const device = c.req.query("device");
  const challenge = c.req.query("challenge");
  if (device === undefined) {
    throw new HttpError(422, [{ type: "missing", loc: ["query", "device"], msg: "Field required", input: null }]);
  }
  if (challenge === undefined) {
    throw new HttpError(422, [{ type: "missing", loc: ["query", "challenge"], msg: "Field required", input: null }]);
  }
  const xff = c.req.header("x-forwarded-for");
  const remoteAddr = c.env?.incoming?.socket?.remoteAddress ?? null;
  if (!cameFromLan(xff, remoteAddr) || challenge.length < 8 || challenge.length > 128) {
    throw new HttpError(404, "Not Found");
  }
  const proof = createHmac("sha256", lanKey(c.var.deps.settings.secretKey, device)).update(challenge, "utf8").digest("hex");
  return c.json({ proof });
});
