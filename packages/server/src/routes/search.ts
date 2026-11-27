// Hybrid search route (server/server/api/search.py): /api/search.
import { and, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { AppEnv } from "../context";
import type { Db } from "../db/client";
import { documents, machines } from "../db/pulled/schema";
import { HttpError, queryInt, queryRequiredString } from "../http";
import { pgToIso } from "../pytime";
import { documentHappenedAt, RRF_K, semanticDocRanks } from "../services/ask-retrieval";
import { useFulltextIndex } from "../services/fulltext";
import { expandQueryForSearch } from "../services/query-expand";
import { tokenizeForQuery } from "../services/tokenize";
import { machineFilter, userMachineIds } from "../services/visibility";

export const searchRoutes = new Hono<AppEnv>();

function parseQueryBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const low = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on", "t", "y"].includes(low)) return true;
  if (["0", "false", "no", "off", "f", "n"].includes(low)) return false;
  throw new HttpError(422, [{ type: "bool_parsing", loc: ["query", "semantic"], msg: "Input should be a valid boolean, unable to interpret input", input: raw }]);
}

searchRoutes.get("/", async (c) => {
  const user = await currentUser(c);
  const { db, settings, redis } = c.var.deps;

  const q = queryRequiredString(c, "q", { minLength: 1, maxLength: 500 });
  const tool = c.req.query("tool") || null;
  const category = c.req.query("category") || null;
  const deviceId = c.req.query("device_id") || null;
  const rawDays = c.req.query("days");
  const days = rawDays !== undefined ? queryInt(c, "days", 1, { ge: 1, le: 3650 }) : null;
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const limit = queryInt(c, "limit", 20, { ge: 1, le: 100 });
  const semantic = parseQueryBool(c.req.query("semantic"), true);

  const cleanQ = q.trim();
  const r = redis();
  const cacheKey = `search:${user.id}:${cleanQ.toLowerCase()}:${tool ?? ""}:${category ?? ""}:${deviceId ?? ""}:${days ?? ""}:${offset}:${limit}:${semantic ? 1 : 0}`;
  const cached = await cacheGet(r, cacheKey);
  if (cached !== null) return c.json(cached);

  const mids = await userMachineIds(db, user, settings);
  const searchTerm = `%${cleanQ}%`;
  const tsquery = tokenizeForQuery(cleanQ);
  const happenedExpr = sql`coalesce(${documents.sourceModifiedAt}, ${documents.syncedAt})`;

  const conds: SQL[] = [ilike(documents.title, searchTerm), ilike(documents.relativePath, searchTerm)];
  if (tsquery) {
    conds.push(sql`${documents.id} IN (SELECT document_id FROM document_search WHERE content_tsv @@ to_tsquery('simple', ${tsquery}))`);
  }

  const filters: SQL[] = [or(...conds)!];
  if (tool) filters.push(eq(documents.toolId, tool));
  if (category) filters.push(eq(documents.category, category));
  if (deviceId) {
    filters.push(sql`${documents.machineId} IN (SELECT id FROM machines WHERE collector_token_hash = ${deviceId})`);
  }
  if (days) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    filters.push(sql`${happenedExpr} >= ${cutoff}::timestamptz`);
  }
  const mf = machineFilter(mids, documents.machineId);
  if (mf) filters.push(mf);

  const fetchPaged = async () => {
    return db.transaction(async (tx) => {
      if (tsquery) await useFulltextIndex(tx as unknown as Db);
      const rows = await tx
        .select({
          id: documents.id,
          toolId: documents.toolId,
          relativePath: documents.relativePath,
          category: documents.category,
          title: documents.title,
          fileSizeBytes: documents.fileSizeBytes,
          syncedAt: documents.syncedAt,
          sourceModifiedAt: documents.sourceModifiedAt,
          _total: sql<number>`count(*) OVER ()::int`,
        })
        .from(documents)
        .where(and(...filters))
        .orderBy(sql`${happenedExpr} DESC`)
        .offset(offset)
        .limit(limit);
      const total = rows.length ? Number(rows[0]!._total) : 0;
      return { docs: rows, total };
    });
  };

  const fetchSem = async () => {
    if (semantic && offset === 0 && !deviceId) {
      const expandedQ = expandQueryForSearch(q);
      return semanticDocRanks(db, settings, r, expandedQ, mids, tool, category, days, limit);
    }
    return { order: [] as string[], snippets: {} as Record<string, string>, similarities: {} as Record<string, number> };
  };

  const [pagedRes, semRes] = await Promise.all([fetchPaged(), fetchSem()]);
  let docs = pagedRes.docs.map(({ _total: _, ...d }) => d);
  let total = pagedRes.total;

  if (semRes.order.length) {
    const kwRank = new Map(docs.map((d, i) => [d.id, i]));
    const semRank = new Map(semRes.order.map((id, i) => [id, i]));
    const missing = semRes.order.filter((id) => !kwRank.has(id));
    if (missing.length) {
      const extraFilters: SQL[] = [inArray(documents.id, missing)];
      if (mf) extraFilters.push(mf);
      const extra = await db
        .select({
          id: documents.id,
          toolId: documents.toolId,
          relativePath: documents.relativePath,
          category: documents.category,
          title: documents.title,
          fileSizeBytes: documents.fileSizeBytes,
          syncedAt: documents.syncedAt,
          sourceModifiedAt: documents.sourceModifiedAt,
        })
        .from(documents)
        .where(and(...extraFilters));
      docs = [...docs, ...extra];
      total += extra.length;
    }

    const cleanQLower = cleanQ.toLowerCase();
    const rrf = (d: (typeof docs)[number]) => {
      let score = 0;
      const kr = kwRank.get(d.id);
      const sr = semRank.get(d.id);
      if (kr !== undefined) score += 1.0 / (RRF_K + kr + 1);
      if (sr !== undefined) score += 1.0 / (RRF_K + sr + 1);
      if (kr !== undefined && sr !== undefined) score *= 1.25;
      const sim = semRes.similarities[d.id] ?? 0;
      if (sim > 0) score += sim * 0.02;
      if (cleanQLower && ((d.title ?? "").toLowerCase().includes(cleanQLower) || d.relativePath.toLowerCase().includes(cleanQLower))) {
        score *= 1.15;
      }
      return score;
    };
    docs.sort((a, b) => rrf(b) - rrf(a));
    docs = docs.slice(0, limit);
  }

  const samples = new Map<string, string>();
  if (docs.length) {
    const sampleRows = await db
      .select({ id: documents.id, sample: sql<string>`substr(${documents.content}, 1, 32768)` })
      .from(documents)
      .where(inArray(documents.id, docs.map((d) => d.id)));
    for (const row of sampleRows) samples.set(row.id, row.sample ?? "");
  }

  const lowerQ = cleanQ.toLowerCase();
  const items = docs.map((d) => {
    let snippet = "";
    const sample = samples.get(d.id) ?? "";
    if (sample) {
      const idx = sample.toLowerCase().indexOf(lowerQ);
      if (idx >= 0) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(sample.length, idx + cleanQ.length + 100);
        snippet = sample.slice(start, end);
        if (start > 0) snippet = `...${snippet}`;
        if (end < (d.fileSizeBytes || sample.length)) snippet = `${snippet}...`;
      }
    }
    if (!snippet) snippet = semRes.snippets[d.id] ?? "";
    return {
      id: d.id,
      tool_id: d.toolId,
      relative_path: d.relativePath,
      category: d.category,
      title: d.title,
      snippet,
      file_size_bytes: d.fileSizeBytes,
      synced_at: pgToIso(d.syncedAt),
      happened_at: documentHappenedAt(d),
      matched_semantically: d.id in semRes.snippets,
    };
  });

  const payload = {
    query: q,
    total,
    offset,
    limit,
    semantic_used: semRes.order.length > 0,
    results: items,
  };
  await cacheSet(r, cacheKey, payload, 300);
  return c.json(payload);
});
