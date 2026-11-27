// Document embeddings, query vector cache & HNSW semantic search (server/server/services/embedding_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { conversationMessages, documentEmbeddings, documents } from "../db/pulled/schema";

export const CHUNK_SIZE = 2000;
export const CHUNK_OVERLAP = 200;
export const MAX_CHUNKS = 20_000;
export const EMBED_CATEGORIES = ["conversation", "memory", "learning", "plan", "identity", "note", "skill", "document"] as const;
export const QUIET_SECONDS = 120;
export const MAX_WAIT_SECONDS = 1800;
export const SLICE = 128;
export const MAX_BACKOFF_MINUTES = 360;
export const HNSW_EF_PER_ROW = 5;
export const CHUNK_COUNT_PENALTY = 0.005;
export const POOL_MIN = 200;
export const POOL_PER_DOC = 20;
export const POOL_MAX = 1000;
export const EMBEDDING_INDEX_DIM = 1024;

const QUERY_CACHE_MAX_SIZE = 512;
const QUERY_REDIS_TTL = 3 * 86400;

const queryEmbedCache = new Map<string, number[]>();
let serverAvailable: boolean | null = null;
let lastCheckTime = 0;

export class EmbeddingRateLimited extends Error {
  constructor(readonly retryAfter: string = "") {
    super(`Embedding rate limited${retryAfter ? `: retry-after=${retryAfter}` : ""}`);
  }
}

export interface DocumentHit {
  documentId: string;
  chunkId: string;
  similarity: number;
}

export function chunkText(text: string, chunkChars = CHUNK_SIZE, overlapChars = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  const seps = ["\n\n", "\n", ". ", "。", "；"];
  while (start < text.length) {
    let end = start + chunkChars;
    if (end < text.length) {
      const minPos = start + Math.floor(chunkChars / 2);
      for (const sep of seps) {
        const sub = text.slice(minPos, end);
        const rel = sub.lastIndexOf(sep);
        if (rel !== -1) {
          end = minPos + rel + sep.length;
          break;
        }
      }
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = end - overlapChars;
  }
  return chunks.filter((c) => c.length > 50);
}

export function changedChunks(chunks: string[], stored: Map<number, string>): number[] {
  const out: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (stored.get(i) !== chunks[i]) out.push(i);
  }
  return out;
}

export function retryDelayMinutes(attempts: number): number {
  return Math.min(2 ** Math.min(Math.max(attempts, 1), 12), MAX_BACKOFF_MINUTES);
}

function normalizeVec(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum) || 1.0;
  return vec.map((x) => x / norm);
}

export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function queryCacheKey(model: string, q: string): string {
  const h = createHash("sha1").update(q, "utf8").digest("hex");
  return `emb:q:v1:${model}:${h}`;
}

function rememberQuery(q: string, vec: number[]): void {
  if (queryEmbedCache.size >= QUERY_CACHE_MAX_SIZE) {
    const first = queryEmbedCache.keys().next().value;
    if (first !== undefined) queryEmbedCache.delete(first);
  }
  queryEmbedCache.set(q, vec);
}

async function cachedQueryVector(redis: Redis | null, settings: Settings, q: string): Promise<number[] | null> {
  const hit = queryEmbedCache.get(q);
  if (hit) return [...hit];
  const packed = await cacheGet(redis, queryCacheKey(settings.embeddingModel, q));
  if (typeof packed !== "string") return null;
  try {
    const raw = Buffer.from(packed, "base64");
    if (raw.length !== EMBEDDING_INDEX_DIM * 4) return null;
    const vec: number[] = new Array(EMBEDDING_INDEX_DIM);
    for (let i = 0; i < EMBEDDING_INDEX_DIM; i++) vec[i] = raw.readFloatLE(i * 4);
    rememberQuery(q, vec);
    return [...vec];
  } catch {
    return null;
  }
}

async function storeQueryVector(redis: Redis | null, settings: Settings, q: string, vec: number[]): Promise<void> {
  rememberQuery(q, vec);
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i]!, i * 4);
  await cacheSet(redis, queryCacheKey(settings.embeddingModel, q), buf.toString("base64"), QUERY_REDIS_TTL);
}

async function embedBatch(settings: Settings, batch: string[], timeoutMs: number): Promise<number[][]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (settings.embeddingProvider === "openai") {
      const resp = await fetch(`${settings.embeddingApiUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${settings.embeddingApiKey}`,
        },
        body: JSON.stringify({ model: settings.embeddingModel, input: batch, encoding_format: "float" }),
        signal: ctrl.signal,
      });
      if (resp.status === 429) throw new EmbeddingRateLimited(resp.headers.get("retry-after") ?? "");
      if (!resp.ok) throw new Error(`Embedding API HTTP ${resp.status}`);
      const json = (await resp.json()) as { data?: { index?: number; embedding: number[] }[] };
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return data.map((d) => d.embedding);
    }
    const resp = await fetch(`${settings.embeddingServerUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: batch }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Embedding server HTTP ${resp.status}`);
    const json = (await resp.json()) as { embeddings?: number[][] };
    return json.embeddings ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export async function embedTexts(settings: Settings, texts: string[], timeoutSec = 120): Promise<number[][]> {
  if (!texts.length) return [];
  const batchSize = settings.embeddingProvider === "openai" ? 16 : 10;
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
  const timeoutMs = timeoutSec * 1000;
  if (batches.length === 1) {
    const vecs = await embedBatch(settings, batches[0]!, timeoutMs);
    if (vecs.length !== batches[0]!.length) throw new Error(`got ${vecs.length} vectors for ${batches[0]!.length} texts`);
    return vecs.map(normalizeVec);
  }
  const results: number[][][] = new Array(batches.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, batches.length) }, async () => {
    while (cursor < batches.length) {
      const idx = cursor++;
      const b = batches[idx]!;
      const vecs = await embedBatch(settings, b, timeoutMs);
      if (vecs.length !== b.length) throw new Error(`got ${vecs.length} vectors for ${b.length} texts`);
      results[idx] = vecs.map(normalizeVec);
    }
  });
  await Promise.all(workers);
  return results.flat();
}

export async function callEmbeddingServer(
  settings: Settings,
  redis: Redis | null,
  texts: string[],
  timeoutSec = 120,
): Promise<number[][] | null> {
  const isSingleQuery = texts.length === 1 && texts[0]!.length <= 500;
  if (isSingleQuery) {
    const cached = await cachedQueryVector(redis, settings, texts[0]!);
    if (cached) return [cached];
  }
  if (serverAvailable === false && Date.now() / 1000 - lastCheckTime < 60 && !process.env.VITEST) {
    return null;
  }
  try {
    const vecs = await embedTexts(settings, texts, timeoutSec);
    serverAvailable = true;
    if (isSingleQuery && vecs.length === 1) {
      await storeQueryVector(redis, settings, texts[0]!, vecs[0]!);
    }
    return vecs;
  } catch {
    lastCheckTime = Date.now() / 1000;
    serverAvailable = false;
    return null;
  }
}

export function poolSize(want: number): number {
  return Math.min(POOL_MAX, Math.max(POOL_MIN, want * POOL_PER_DOC));
}

export function rankChunkPool(
  pool: { documentId: string; chunkId: string; dist: number }[],
  counts: Map<string, number>,
  want: number,
): DocumentHit[] {
  const best = new Map<string, DocumentHit>();
  for (const row of pool) {
    const sim = Math.max(0.0, 1.0 - Number(row.dist));
    const prev = best.get(row.documentId);
    if (!prev || sim > prev.similarity) {
      best.set(row.documentId, { documentId: row.documentId, chunkId: row.chunkId, similarity: sim });
    }
  }
  const score = (h: DocumentHit) => h.similarity - CHUNK_COUNT_PENALTY * Math.log(Math.max(1, counts.get(h.documentId) ?? 1));
  return [...best.values()].sort((a, b) => score(b) - score(a)).slice(0, want);
}

export async function widenHnswScan(db: Db, rows: number): Promise<void> {
  const ef = Math.max(40, Math.min(Math.trunc(rows) * HNSW_EF_PER_ROW, 1000));
  await db.execute(sql.raw(`SET LOCAL hnsw.ef_search = ${ef}`));
  await db.execute(sql.raw(`SET LOCAL hnsw.iterative_scan = strict_order`));
}

export async function chunkCounts(db: Db, documentIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!documentIds.length) return out;
  const rows = (await db.execute(sql`
    SELECT d.id, (
      SELECT de.chunk_index FROM document_embeddings de
      WHERE de.document_id = d.id ORDER BY de.chunk_index DESC LIMIT 1
    ) AS last_idx
    FROM documents d WHERE d.id IN (${sql.join(documentIds.map((id) => sql`${id}::uuid`), sql`, `)})
  `)) as unknown as { id: string; last_idx: number | null }[];
  for (const r of rows) out.set(String(r.id), Number(r.last_idx ?? 0) + 1);
  return out;
}

export async function chunkTexts(db: Db, chunkIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!chunkIds.length) return out;
  const rows = await db
    .select({ id: documentEmbeddings.id, chunkText: documentEmbeddings.chunkText })
    .from(documentEmbeddings)
    .where(inArray(documentEmbeddings.id, chunkIds));
  for (const r of rows) out.set(r.id, r.chunkText);
  return out;
}

export async function semanticDocumentHits(
  db: Db,
  qvec: number[],
  want: number,
  opts: { mids?: string[] | null; tool?: string | null; category?: string | null; days?: number | null } = {},
): Promise<DocumentHit[]> {
  const size = poolSize(want);
  const vecLit = toVectorLiteral(qvec);
  const conds: SQL[] = [];
  const needJoin = Boolean(opts.tool || opts.category || opts.days || opts.mids !== null && opts.mids !== undefined);
  if (opts.tool) conds.push(sql`d.tool_id = ${opts.tool}`);
  if (opts.category) conds.push(sql`d.category = ${opts.category}`);
  if (opts.days) {
    const cutoff = new Date(Date.now() - opts.days * 86400_000).toISOString();
    conds.push(sql`coalesce(d.source_modified_at, d.synced_at) >= ${cutoff}::timestamptz`);
  }
  if (opts.mids !== null && opts.mids !== undefined) {
    if (!opts.mids.length) return [];
    conds.push(sql`d.machine_id IN (${sql.join(opts.mids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  const joinSql = needJoin ? sql`JOIN documents d ON de.document_id = d.id` : sql``;
  const whereSql = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;

  const pool = await db.transaction(async (tx) => {
    await widenHnswScan(tx as unknown as Db, size);
    const rows = (await tx.execute(sql`
      SELECT de.document_id, de.id AS chunk_id,
             (de.embedding <=> ${vecLit}::halfvec(${sql.raw(String(EMBEDDING_INDEX_DIM))})) AS dist
      FROM document_embeddings de
      ${joinSql}
      ${whereSql}
      ORDER BY (de.embedding::halfvec(${sql.raw(String(EMBEDDING_INDEX_DIM))}) <=> ${vecLit}::halfvec(${sql.raw(String(EMBEDDING_INDEX_DIM))})) ASC
      LIMIT ${size}
    `)) as unknown as { document_id: string; chunk_id: string; dist: number }[];
    return rows.map((r) => ({ documentId: String(r.document_id), chunkId: String(r.chunk_id), dist: Number(r.dist) }));
  });
  if (!pool.length) return [];
  const docIds = [...new Set(pool.map((r) => r.documentId))];
  const counts = await chunkCounts(db, docIds);
  return rankChunkPool(pool, counts, want);
}

async function documentTextForEmbed(db: Db, docId: string, category: string): Promise<string> {
  if (category === "conversation") {
    const msgs = await db
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.documentId, docId), inArray(conversationMessages.role, ["user", "assistant"])))
      .orderBy(asc(conversationMessages.lineNumber));
    const lines = msgs
      .filter((m) => m.content && m.content.trim())
      .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content.trim()}`);
    if (lines.length) return lines.join("\n\n");
  }
  const [row] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, docId)).limit(1);
  return row?.content ?? "";
}

async function finishEmbed(db: Db, docId: string, status: string, seenSyncedAt: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(documents)
    .set({ embeddedAt: now, embeddingAttempts: 0, embeddingNextAt: null })
    .where(eq(documents.id, docId));
  await db
    .update(documents)
    .set({ embeddingStatus: status })
    .where(and(eq(documents.id, docId), eq(documents.syncedAt, seenSyncedAt)));
}

export async function embedDocument(
  db: Db,
  settings: Settings,
  doc: { id: string; category: string; contentType: string; syncedAt: string },
  deadlineMs?: number,
): Promise<{ status: "ok" | "skipped" | "partial"; sent: number }> {
  if (["sqlite", "sqlite_export", "binary"].includes(doc.contentType)) {
    await db.delete(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    await finishEmbed(db, doc.id, "skipped", doc.syncedAt);
    return { status: "skipped", sent: 0 };
  }
  const body = await documentTextForEmbed(db, doc.id, doc.category);
  const chunks = body.length >= 100 ? chunkText(body).slice(0, MAX_CHUNKS) : [];
  if (!chunks.length) {
    await db.delete(documentEmbeddings).where(eq(documentEmbeddings.documentId, doc.id));
    await finishEmbed(db, doc.id, "skipped", doc.syncedAt);
    return { status: "skipped", sent: 0 };
  }

  const storedRows = await db
    .select({ chunkIndex: documentEmbeddings.chunkIndex, chunkText: documentEmbeddings.chunkText })
    .from(documentEmbeddings)
    .where(eq(documentEmbeddings.documentId, doc.id));
  const stored = new Map<number, string>(storedRows.map((r) => [r.chunkIndex, r.chunkText]));
  const todo = changedChunks(chunks, stored);

  let sent = 0;
  for (let start = 0; start < todo.length; start += SLICE) {
    if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
      return { status: "partial", sent };
    }
    const idx = todo.slice(start, start + SLICE);
    const vecs = await embedTexts(settings, idx.map((i) => chunks[i]!));
    if (vecs[0] && vecs[0].length !== settings.embeddingDim) {
      throw new Error(`embedding dim ${vecs[0].length}, expected ${settings.embeddingDim}`);
    }
    for (let k = 0; k < idx.length; k++) {
      const ci = idx[k]!;
      const lit = toVectorLiteral(vecs[k]!);
      await db.execute(sql`
        INSERT INTO document_embeddings (id, document_id, chunk_index, chunk_text, embedding)
        VALUES (${randomUUID()}::uuid, ${doc.id}::uuid, ${ci}, ${chunks[ci]!}, ${lit}::halfvec(${sql.raw(String(EMBEDDING_INDEX_DIM))}))
        ON CONFLICT (document_id, chunk_index)
        DO UPDATE SET chunk_text = EXCLUDED.chunk_text, embedding = EXCLUDED.embedding
      `);
    }
    sent += idx.length;
  }

  let hasTail = false;
  for (const k of stored.keys()) if (k >= chunks.length) { hasTail = true; break; }
  if (hasTail) {
    await db
      .delete(documentEmbeddings)
      .where(and(eq(documentEmbeddings.documentId, doc.id), gte(documentEmbeddings.chunkIndex, chunks.length)));
  }
  await finishEmbed(db, doc.id, "ok", doc.syncedAt);
  return { status: "ok", sent };
}
