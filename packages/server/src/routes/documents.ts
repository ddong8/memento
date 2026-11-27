// /api/documents: view individual documents, backlinks, and safe proxy-fetch (server/server/api/documents.py).
import { lookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import { isIP } from "node:net";

import { and, countDistinct, desc, eq, inArray, ne, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, optionalUser, type UserRow } from "../auth/current-user";
import { requestIp, type AppEnv } from "../context";
import { accessLogs, documents, knowledgeEntities, knowledgeObservations } from "../db/pulled/schema";
import { HttpError, pathUuid, queryInt, queryRequiredString } from "../http";
import { pgToIso } from "../pytime";
import { withPending } from "../services/content-staging";
import { canViewDocument } from "../services/permissions";
import { machineFilter, seesAll, userMachineIds } from "../services/visibility";

export const documentRoutes = new Hono<AppEnv>();

const PROXY_MAX_BYTES = 5 * 1024 * 1024;
const PROXY_MAX_REDIRECTS = 5;
const PROXY_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "text/markdown, text/plain, text/html, */*",
};

function isGlobalIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 shared/CGNAT
  if (a === 127) return false; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // RFC1918 /16 private
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

function isGlobalIp(raw: string): boolean {
  const ip = raw.split("%", 1)[0]!.toLowerCase();
  const ver = isIP(ip);
  if (ver === 4) return isGlobalIpv4(ip);
  if (ver !== 6) return false;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  const v4m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4m) return isGlobalIpv4(v4m[1]!);
  if (ip === "::" || ip === "::1") return false;
  // Normalize first hextet
  const first = ip.startsWith(":") ? 0 : parseInt(ip.split(":", 1)[0]!, 16);
  if (Number.isNaN(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x0100) return false; // 100::/64 discard
  if (first === 0x2001 && ip.startsWith("2001:db8:")) return false; // documentation
  if (first === 0) return false; // unspecified / loopback / ipv4-compatible
  return true;
}

async function publicAddresses(host: string): Promise<string[]> {
  let addrs: string[];
  try {
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (isIP(cleanHost)) {
      addrs = [cleanHost];
    } else {
      const records = await lookup(cleanHost, { all: true, verbatim: true });
      addrs = records.map((r) => r.address);
    }
  } catch {
    throw new HttpError(502, `无法解析域名 ${host}`);
  }
  if (!addrs.length || !addrs.every(isGlobalIp)) {
    throw new HttpError(403, "不允许访问内网地址");
  }
  const unique = [...new Set(addrs)];
  // IPv4 first
  unique.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
  return unique;
}

type PinnedResult = { redirect: string } | { content: string; content_type: string };

function fetchPinned(parsed: URL, ip: string, port: number, hostHeader: string): Promise<PinnedResult> {
  return new Promise((resolve, reject) => {
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        host: ip,
        port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        timeout: 15_000,
        headers: { ...PROXY_HEADERS, Host: hostHeader },
        ...(isHttps ? { servername: parsed.hostname.replace(/^\[|\]$/g, "") } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.resume();
          resolve({ redirect: loc });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new HttpError(502, `对方网站返回 HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const buf = Buffer.concat(chunks).subarray(0, PROXY_MAX_BYTES);
          resolve({
            content: buf.toString("utf8"),
            content_type: String(res.headers["content-type"] || "text/markdown"),
          });
        };
        res.on("data", (chunk: Buffer) => {
          if (done) return;
          chunks.push(chunk);
          total += chunk.length;
          if (total >= PROXY_MAX_BYTES) {
            res.destroy();
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", (err) => {
          if (!done) reject(err);
        });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("ConnectTimeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end();
  });
}

documentRoutes.get("/proxy-fetch", async (c) => {
  await currentUser(c);
  const rawUrl = queryRequiredString(c, "url");
  let current = rawUrl.trim();

  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw new HttpError(400, "只支持 http / https 地址");
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
      throw new HttpError(400, "只支持 http / https 地址");
    }
    if (parsed.username || parsed.password) {
      throw new HttpError(400, "地址里不能带用户名密码");
    }
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    const addrs = await publicAddresses(parsed.hostname);
    const hostHeader = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    let result: PinnedResult | null = null;
    let lastError: unknown = null;
    for (const ip of addrs.slice(0, 4)) {
      try {
        result = await fetchPinned(parsed, ip, port, hostHeader);
        break;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        const code = (e as { code?: string })?.code ?? "";
        if (["ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET"].includes(code)) {
          lastError = e;
          continue;
        }
        throw new HttpError(502, `读取对方网站失败：${(e as Error)?.name || "Error"} ${(e as Error)?.message || e}`);
      }
    }
    if (!result) {
      throw new HttpError(502, `连不上对方网站：${(lastError as Error)?.name || "ConnectError"}`);
    }
    if ("redirect" in result) {
      current = new URL(result.redirect, current).toString();
      continue;
    }
    return c.json({ url: current, content: result.content, content_type: result.content_type });
  }
  throw new HttpError(502, "重定向次数过多");
});

async function getDocWithPermission(
  c: Parameters<typeof currentUser>[0],
  docId: string,
  user: UserRow | null,
  mids: string[] | null,
  includeContent = true,
) {
  const { db, settings } = c.var.deps;
  const cols = {
    id: documents.id,
    toolId: documents.toolId,
    projectId: documents.projectId,
    machineId: documents.machineId,
    relativePath: documents.relativePath,
    category: documents.category,
    contentType: documents.contentType,
    title: documents.title,
    contentHash: documents.contentHash,
    fileSizeBytes: documents.fileSizeBytes,
    aiSummary: documents.aiSummary,
    visibility: documents.visibility,
    syncedAt: documents.syncedAt,
    createdAt: documents.createdAt,
    updatedAt: documents.updatedAt,
    ...(includeContent ? { content: documents.content, metadata: documents.metadata } : {}),
  };
  const [doc] = await db.select(cols).from(documents).where(eq(documents.id, docId)).limit(1);
  if (!doc) throw new HttpError(404, "Not Found");
  if (!(await canViewDocument(db, settings, user, doc))) throw new HttpError(404, "Not Found");
  if (mids !== null && (!doc.machineId || !mids.includes(doc.machineId))) throw new HttpError(404, "Not Found");
  return doc;
}

documentRoutes.get("/:docId", async (c) => {
  const { db, settings } = c.var.deps;
  const authUser = await currentUser(c);
  const optUser = await optionalUser(c);
  const docId = pathUuid(c, "docId");
  const mids = await userMachineIds(db, authUser, settings);
  const doc = await getDocWithPermission(c, docId, optUser, mids, true);

  await db.insert(accessLogs).values({
    userId: optUser?.id ?? null,
    documentId: doc.id,
    action: "view_document",
    ipAddress: requestIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    metadata: { path: c.req.path, method: c.req.method },
  });

  return c.json({
    id: doc.id,
    tool_id: doc.toolId,
    project_id: doc.projectId ?? null,
    relative_path: doc.relativePath,
    category: doc.category,
    content_type: doc.contentType,
    title: doc.title,
    content: await withPending(db, doc.id, "content" in doc ? (doc.content as string | null) : null),
    content_hash: doc.contentHash,
    file_size_bytes: doc.fileSizeBytes,
    metadata: "metadata" in doc ? doc.metadata : {},
    ai_summary: doc.aiSummary,
    synced_at: pgToIso(doc.syncedAt),
    created_at: pgToIso(doc.createdAt),
    updated_at: pgToIso(doc.updatedAt),
  });
});

documentRoutes.get("/:docId/backlinks", async (c) => {
  const { db, settings } = c.var.deps;
  const authUser = await currentUser(c);
  const optUser = await optionalUser(c);
  const docId = pathUuid(c, "docId");
  const limit = queryInt(c, "limit", 50, { ge: 1, le: 200 });
  const mids = await userMachineIds(db, authUser, settings);
  await getDocWithPermission(c, docId, optUser, mids, false);

  const entConds: (SQL | undefined)[] = [eq(knowledgeObservations.sourceDocumentId, docId)];
  if (!seesAll(authUser, settings)) entConds.push(eq(knowledgeEntities.userId, authUser.id));

  const entRows = await db
    .selectDistinct({
      id: knowledgeEntities.id,
      name: knowledgeEntities.name,
      entityType: knowledgeEntities.entityType,
    })
    .from(knowledgeEntities)
    .innerJoin(knowledgeObservations, eq(knowledgeObservations.entityId, knowledgeEntities.id))
    .where(and(...entConds))
    .limit(limit);

  if (!entRows.length) return c.json({ entities: [], related_documents: [] });

  const entIds = entRows.map((e) => e.id);
  const sharedExpr = countDistinct(knowledgeObservations.entityId);
  const relRows = await db
    .select({
      id: documents.id,
      title: documents.title,
      relativePath: documents.relativePath,
      toolId: documents.toolId,
      category: documents.category,
      syncedAt: documents.syncedAt,
      shared: sharedExpr,
    })
    .from(documents)
    .innerJoin(knowledgeObservations, eq(knowledgeObservations.sourceDocumentId, documents.id))
    .where(and(inArray(knowledgeObservations.entityId, entIds), ne(documents.id, docId), machineFilter(mids, documents.machineId)))
    .groupBy(documents.id, documents.title, documents.relativePath, documents.toolId, documents.category, documents.syncedAt)
    .orderBy(desc(sharedExpr), desc(documents.syncedAt))
    .limit(limit);

  return c.json({
    entities: entRows.map((e) => ({ id: e.id, name: e.name, type: e.entityType })),
    related_documents: relRows.map((r) => ({
      id: r.id,
      title: r.title || (r.relativePath ? r.relativePath.split("/").pop() ?? "" : ""),
      relative_path: r.relativePath,
      tool_id: r.toolId,
      category: r.category,
      synced_at: pgToIso(r.syncedAt),
      shared_entities: Number(r.shared),
    })),
  });
});
