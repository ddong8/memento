// Hybrid retrieval & Ebbinghaus core-memory recall for /api/ask (server/server/services/ask_retrieval.py).
import { createHash } from "node:crypto";
import path from "node:path";

import { and, desc, eq, gte, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { documents, documentSearch, projects, userMemories } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import { iterJsonObjects, parseConversationLine } from "./conversation-parser";
import { callEmbeddingServer, chunkTexts, semanticDocumentHits, toVectorLiteral } from "./embedding";
import { keywordMatch, useFulltextIndex } from "./fulltext";
import { isJunkOrUuidTitle } from "./ingest-service";
import { queryTerms } from "./tokenize";
import { machineFilter, userMachineIds } from "./visibility";

export const RRF_K = 60;
export const TOP_K = 6;
export const CHARS_PER_DOC = 1500;

const EXACT_TOKEN_RES = [/\b\d{2,7}-\d{2}-\d\b/, /\b[0-9a-f]{7,40}\b/, /\b[\w-]+\.(?:py|tsx?|jsx?|rs|go|ya?ml|json|md)\b/];

export interface DocCandidate {
  id: string;
  toolId: string;
  title: string | null;
  relativePath: string;
  category: string;
  content: string | null;
  syncedAt: string;
  sourceModifiedAt: string | null;
  fileSizeBytes: number;
}

export function documentHappenedAt(doc: { sourceModifiedAt?: string | null; syncedAt?: string | null }): string | null {
  return pgToIso(doc.sourceModifiedAt || doc.syncedAt || null);
}

export async function semanticDocRanks(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  q: string,
  mids: string[] | null,
  tool: string | null,
  category: string | null,
  days: number | null,
  want: number,
): Promise<{ order: string[]; snippets: Record<string, string>; similarities: Record<string, number> }> {
  try {
    const embeds = await callEmbeddingServer(settings, redis, [q], 30);
    if (!embeds || !embeds[0]) return { order: [], snippets: {}, similarities: {} };
    const hits = await semanticDocumentHits(db, embeds[0], want, { mids, tool, category, days });
    const texts = await chunkTexts(db, hits.map((h) => h.chunkId));
    const order = hits.map((h) => h.documentId);
    const snippets: Record<string, string> = {};
    const similarities: Record<string, number> = {};
    for (const h of hits) {
      snippets[h.documentId] = (texts.get(h.chunkId) ?? "").slice(0, 400);
      similarities[h.documentId] = h.similarity;
    }
    return { order, snippets, similarities };
  } catch {
    return { order: [], snippets: {}, similarities: {} };
  }
}

export function fuseRanks<T extends { id: string; title: string | null; relativePath: string }>(
  docs: T[],
  kwIds: string[],
  semIds: string[],
  q: string,
): T[] {
  const kwRank = new Map<string, number>(kwIds.map((id, i) => [id, i]));
  const semRank = new Map<string, number>(semIds.map((id, i) => [id, i]));
  const exact = EXACT_TOKEN_RES.some((r) => r.test(q));
  const [kwW, semW] = exact ? [1.6, 0.7] : [1.0, 1.0];
  const qLower = q.toLowerCase().trim();

  const score = (d: T): number => {
    let s = 0;
    const kr = kwRank.get(d.id);
    const sr = semRank.get(d.id);
    if (kr !== undefined) s += kwW / (RRF_K + kr + 1);
    if (sr !== undefined) s += semW / (RRF_K + sr + 1);
    if (kr !== undefined && sr !== undefined) s *= 1.3;
    if (qLower && ((d.title ?? "").toLowerCase().includes(qLower) || (d.relativePath ?? "").toLowerCase().includes(qLower))) {
      s *= 1.2;
    }
    return s;
  };
  return [...docs].sort((a, b) => score(b) - score(a));
}

export async function hybridRank(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  q: string,
  tool: string | null,
  days: number | null,
  k = TOP_K,
): Promise<{ docs: DocCandidate[]; kwOrder: string[]; semOrder: string[]; semSnippets: Record<string, string> }> {
  const cleanQ = q.trim();
  const qHash = createHash("sha256").update(cleanQ.toLowerCase(), "utf8").digest("hex").slice(0, 16);
  const cacheKey = `hybrid_rank:v2:${user.id}:${tool || "all"}:${days || "all"}:${k}:${qHash}`;
  const cached = (await cacheGet(redis, cacheKey)) as Record<string, unknown> | null;
  if (cached && typeof cached === "object") {
    try {
      const docIds = Array.isArray(cached.doc_ids) ? (cached.doc_ids as string[]) : [];
      const kwOrder = Array.isArray(cached.kw_order) ? (cached.kw_order as string[]) : [];
      const semOrder = Array.isArray(cached.sem_order) ? (cached.sem_order as string[]) : [];
      const semSnippets = (cached.sem_snippets && typeof cached.sem_snippets === "object" ? cached.sem_snippets : {}) as Record<string, string>;
      if (docIds.length) {
        const rows = await db
          .select({
            id: documents.id,
            toolId: documents.toolId,
            title: documents.title,
            relativePath: documents.relativePath,
            category: documents.category,
            content: documents.content,
            syncedAt: documents.syncedAt,
            sourceModifiedAt: documents.sourceModifiedAt,
            fileSizeBytes: documents.fileSizeBytes,
          })
          .from(documents)
          .where(inArray(documents.id, docIds));
        const byId = new Map(rows.map((r) => [r.id, r]));
        const sorted = docIds.map((id) => byId.get(id)).filter((x): x is DocCandidate => Boolean(x));
        if (sorted.length === docIds.length) return { docs: sorted.slice(0, k), kwOrder, semOrder, semSnippets };
      }
    } catch {
      /* recompute */
    }
  }

  const mids = await userMachineIds(db, user, settings);
  const terms = queryTerms(q);
  const term = `%${q}%`;
  const happenedExpr = sql`coalesce(${documents.sourceModifiedAt}, ${documents.syncedAt})`;

  const baseConds: SQL[] = [];
  if (tool) baseConds.push(eq(documents.toolId, tool));
  if (days) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    baseConds.push(sql`${happenedExpr} >= ${cutoff}::timestamptz`);
  }
  const mf = machineFilter(mids, documents.machineId);
  if (mf) baseConds.push(mf);

  const fetchKw = async (): Promise<DocCandidate[]> => {
    return db.transaction(async (tx) => {
      const conds: SQL[] = [ilike(documents.title, term), ilike(documents.relativePath, term)];
      let orderCols: SQL[] = [sql`${happenedExpr} DESC`];
      if (terms.length) {
        await useFulltextIndex(tx as unknown as Db);
        const { tsquery, rankExpr } = await keywordMatch(tx as unknown as Db, terms);
        conds.push(sql`${documents.id} IN (SELECT document_id FROM document_search WHERE content_tsv @@ to_tsquery('simple', ${tsquery}))`);
        orderCols = [sql`${rankExpr} DESC`, sql`${happenedExpr} DESC`];
      }
      return tx
        .select({
          id: documents.id,
          toolId: documents.toolId,
          title: documents.title,
          relativePath: documents.relativePath,
          category: documents.category,
          content: documents.content,
          syncedAt: documents.syncedAt,
          sourceModifiedAt: documents.sourceModifiedAt,
          fileSizeBytes: documents.fileSizeBytes,
        })
        .from(documents)
        .leftJoin(documentSearch, eq(documentSearch.documentId, documents.id))
        .where(and(...baseConds, or(...conds)!))
        .orderBy(...orderCols)
        .limit(k);
    });
  };

  const [semRes, kwDocs] = await Promise.all([
    semanticDocRanks(db, settings, redis, q, mids, tool, null, days, k),
    fetchKw(),
  ]);

  const kwIds = kwDocs.map((d) => d.id);
  const kwSet = new Set(kwIds);
  let docs = [...kwDocs];
  const missing = semRes.order.filter((id) => !kwSet.has(id));
  if (missing.length) {
    const extraConds: SQL[] = [inArray(documents.id, missing)];
    if (mf) extraConds.push(mf);
    const extra = await db
      .select({
        id: documents.id,
        toolId: documents.toolId,
        title: documents.title,
        relativePath: documents.relativePath,
        category: documents.category,
        content: documents.content,
        syncedAt: documents.syncedAt,
        sourceModifiedAt: documents.sourceModifiedAt,
        fileSizeBytes: documents.fileSizeBytes,
      })
      .from(documents)
      .where(and(...extraConds));
    docs = [...docs, ...extra];
  }

  docs = fuseRanks(docs, kwIds, semRes.order, q);
  await cacheSet(
    redis,
    cacheKey,
    {
      doc_ids: docs.map((d) => d.id),
      kw_order: kwIds,
      sem_order: semRes.order,
      sem_snippets: semRes.snippets,
    },
    60,
  );
  return { docs: docs.slice(0, k), kwOrder: kwIds, semOrder: semRes.order, semSnippets: semRes.snippets };
}

export function cleanConversationExcerpt(text: string, toolId?: string | null): string {
  if (!text) return "";
  const cleanedParts: string[] = [];
  if (text.includes("{") && text.includes("}")) {
    for (const rawObjStr of iterJsonObjects(text)) {
      const s = rawObjStr.trim();
      if (!s) continue;
      let norm = parseConversationLine(s, toolId || "antigravity");
      if (!norm && toolId !== "codex") norm = parseConversationLine(s, "codex");
      if (!norm && toolId !== "claude_code") norm = parseConversationLine(s, "claude_code");
      if (norm && (norm.role === "user" || norm.role === "assistant")) {
        const label = norm.role === "user" ? "用户" : "助手";
        const body = norm.content
          .trim()
          .replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, "$1")
          .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
          .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
          .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
          .trim();
        if (body && body !== "[Request interrupted by user]") cleanedParts.push(`${label}: ${body}`);
      } else if (norm && norm.role === "tool" && norm.toolName) {
        cleanedParts.push(`[调用工具: ${norm.toolName}]`);
      }
    }
  }
  if (cleanedParts.length) return cleanedParts.join("\n\n");
  const plain = text
    .trim()
    .replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, "用户: $1")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, "")
    .trim();
  if (plain.startsWith("{") || plain.startsWith('{"timestamp"') || plain.startsWith('{"type"') || plain.startsWith('{"ordinal"')) return "";
  return plain;
}

export async function retrieveDocuments(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  q: string,
  tool: string | null = null,
  days: number | null = null,
) {
  const { docs, semSnippets } = await hybridRank(db, settings, redis, user, q, tool, days);
  const topDocs = docs.slice(0, TOP_K);
  const convIds = topDocs.filter((d) => d.category === "conversation").map((d) => d.id);
  const cachedMsgs = new Map<string, [string, string][]>();
  if (convIds.length) {
    try {
      const rows = (await db.execute(sql`
        SELECT document_id, role, content FROM (
          SELECT document_id, role, content,
                 row_number() OVER (PARTITION BY document_id ORDER BY line_number) AS rn
          FROM conversation_messages
          WHERE document_id IN (${sql.join(convIds.map((id) => sql`${id}::uuid`), sql`, `)})
            AND role IN ('user', 'assistant')
        ) sub
        WHERE rn <= 4
        ORDER BY document_id, rn
      `)) as unknown as { document_id: string; role: string; content: string }[];
      for (const r of rows) {
        const docId = String(r.document_id);
        const list = cachedMsgs.get(docId) ?? [];
        if (list.length < 4 && r.content?.trim()) list.push([r.role, r.content.trim()]);
        cachedMsgs.set(docId, list);
      }
    } catch {
      /* best effort */
    }
  }

  return topDocs.map((d) => {
    const rawText = semSnippets[d.id] ?? "";
    let cleanText = "";
    if (d.category === "conversation") {
      if (rawText) cleanText = cleanConversationExcerpt(rawText, d.toolId);
      if (!cleanText && cachedMsgs.get(d.id)?.length) {
        cleanText = cachedMsgs
          .get(d.id)!
          .map(([r, c]) => `${r === "user" ? "用户" : "助手"}: ${c}`)
          .join("\n\n");
      }
      if (!cleanText && d.content) cleanText = cleanConversationExcerpt(d.content.slice(0, 3000), d.toolId);
    } else {
      cleanText = (rawText || (d.content ?? "").slice(0, CHARS_PER_DOC))
        .replace(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/g, "$1")
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "");
    }
    if (!cleanText) cleanText = "(无文字摘要)";
    let displayTitle = d.title || d.relativePath.split("/").pop() || "";
    if (isJunkOrUuidTitle(displayTitle)) {
      const msgs = cachedMsgs.get(d.id) ?? [];
      for (const [r, c] of msgs) {
        if (r === "user" && c) {
          const cand = c.split("\n")[0]!.slice(0, 50).trim();
          if (!isJunkOrUuidTitle(cand)) {
            displayTitle = cand;
            break;
          }
        }
      }
    }
    return {
      id: d.id,
      title: displayTitle,
      relative_path: d.relativePath,
      tool_id: d.toolId,
      category: d.category,
      synced_at: pgToIso(d.syncedAt),
      happened_at: documentHappenedAt(d),
      excerpt: cleanText.slice(0, CHARS_PER_DOC),
    };
  });
}

export function computeEbbinghausMemoryScore(
  cosineSim: number,
  lastRecalledAt: string | null,
  recallCount: number,
  createdAt: string | null = null,
  lambdaDecay = 0.05,
  nowMs = Date.now(),
): number {
  const sim = Math.max(0.0, cosineSim);
  const ref = lastRecalledAt || createdAt;
  let deltaDays = 0;
  if (ref) {
    const t = Date.parse(ref.includes("T") ? ref : ref.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
    if (!Number.isNaN(t)) deltaDays = Math.max(0, (nowMs - t) / 86_400_000);
  }
  return sim * Math.exp(-lambdaDecay * deltaDays) * Math.log(2.0 + Math.max(0, Math.trunc(recallCount || 0)));
}

function toFloatVector(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        return (JSON.parse(s) as unknown[]).map(Number);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cosineSimilarity(v1: number[], v2: number[]): number {
  if (!v1.length || v1.length !== v2.length) return 0;
  let dot = 0;
  let n1 = 0;
  let n2 = 0;
  for (let i = 0; i < v1.length; i++) {
    const a = v1[i]!;
    const b = v2[i]!;
    dot += a * b;
    n1 += a * a;
    n2 += b * b;
  }
  return n1 > 0 && n2 > 0 ? dot / (Math.sqrt(n1) * Math.sqrt(n2)) : 0;
}

export async function touchRecalled(db: Db, ids: string[]): Promise<void> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return;
  try {
    await db
      .update(userMemories)
      .set({
        lastRecalledAt: sql`now()`,
        recallCount: sql`${userMemories.recallCount} + 1`,
        updatedAt: userMemories.updatedAt,
      })
      .where(inArray(userMemories.id, unique));
  } catch {
    /* non-fatal */
  }
}

export async function retrieveCoreMemories(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  question: string,
  opts: { projectId?: string | null; cwd?: string | null; limit?: number } = {},
) {
  const limit = opts.limit ?? 12;
  let projSlug: string | null = null;
  if (opts.projectId) {
    const pUuid = normalizeUuid(opts.projectId);
    if (pUuid) {
      const [p] = await db.select({ slug: projects.slug }).from(projects).where(eq(projects.id, pUuid)).limit(1);
      if (p) projSlug = p.slug;
    } else {
      projSlug = opts.projectId.trim();
    }
  }
  if (!projSlug && opts.cwd) {
    const bname = path.basename(opts.cwd.trim().replace(/[/\\]+$/, ""));
    if (bname) {
      const [p] = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(or(eq(projects.slug, bname), ilike(projects.sourcePath, `%${bname}%`)))
        .limit(1);
      projSlug = p?.slug ?? bname;
    }
  }

  let qvec: number[] | null = null;
  const cleanQ = (question || "").trim();
  if (cleanQ) {
    try {
      const embeds = await callEmbeddingServer(settings, redis, [cleanQ], 5);
      if (embeds?.[0]) qvec = embeds[0];
    } catch {
      /* fallback to lexical */
    }
  }

  const candidates: (typeof userMemories.$inferSelect)[] = [];
  const seenIds = new Set<string>();

  if (qvec) {
    try {
      const lit = toVectorLiteral(qvec);
      const vecRows = await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.userId, user.id), eq(userMemories.isFolder, false), eq(userMemories.status, "active"), isNotNull(userMemories.embedding)))
        .orderBy(sql`${userMemories.embedding} <=> ${lit}::vector`)
        .limit(60);
      for (const m of vecRows) {
        if (!seenIds.has(m.id)) {
          candidates.push(m);
          seenIds.add(m.id);
        }
      }
    } catch {
      /* fallback */
    }
  }

  const candRows = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.isFolder, false), eq(userMemories.status, "active")))
    .orderBy(
      sql`CASE WHEN ${userMemories.category} IN ('iron_rule', 'rule', 'pitfall') THEN 1 ELSE 2 END`,
      desc(userMemories.confidence),
      desc(userMemories.updatedAt),
    )
    .limit(160);
  for (const m of candRows) {
    if (!seenIds.has(m.id)) {
      candidates.push(m);
      seenIds.add(m.id);
    }
  }

  const nowMs = Date.now();
  const tokens = cleanQ
    ? cleanQ
        .split(/[\s,;，；]+/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length >= 2)
    : [];
  const slugClean = projSlug ? projSlug.toLowerCase() : null;
  const scored: [number, typeof userMemories.$inferSelect][] = [];

  for (const m of candidates) {
    if (m.isFolder || !m.content?.trim()) continue;
    const isProjectMatch = Boolean(
      slugClean &&
        ((m.treePath ?? "").toLowerCase().includes(slugClean) || m.key.toLowerCase().includes(slugClean) || m.category === "architecture"),
    );
    const memVec = toFloatVector(m.embedding);
    let sim: number;
    if (qvec && memVec) {
      sim = cosineSimilarity(qvec, memVec);
    } else if (cleanQ && tokens.length) {
      const lowC = m.content.toLowerCase();
      const lowK = m.key.toLowerCase();
      const overlap = tokens.filter((tok) => lowC.includes(tok) || lowK.includes(tok)).length;
      sim = overlap > 0 ? Math.min(1.0, 0.35 + 0.25 * overlap) : 0.0;
    } else {
      sim = !cleanQ ? 0.5 : 0.0;
    }
    const ebb = computeEbbinghausMemoryScore(sim, m.lastRecalledAt, m.recallCount, m.createdAt, 0.05, nowMs);
    const conf = m.confidence ?? 1.0;
    let score = ebb * conf;
    if (score <= 0) {
      if (["iron_rule", "rule", "pitfall"].includes(m.category)) score = 0.15 * conf;
      else if (isProjectMatch) score = 0.12 * conf;
      else if (["preference", "general"].includes(m.category)) score = 0.05 * conf;
      else score = 0.01;
    }
    if (isProjectMatch) score *= 1.4;
    if (["iron_rule", "rule", "pitfall"].includes(m.category)) score *= 1.25;
    scored.push([score, m]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const chosen = scored.slice(0, limit).map(([, m]) => m);
  await touchRecalled(db, chosen.map((m) => m.id));
  return chosen;
}
