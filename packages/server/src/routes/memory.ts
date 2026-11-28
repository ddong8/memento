// /api/memory: knowledge graph, semantic search, 3-tier overview, core memory & dream journals
// (server/server/api/memory.py).
import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv, Deps } from "../context";
import { withoutNul } from "../db/client";
import {
  askConversations,
  conversationMessages,
  dailySummaries,
  documentEmbeddings,
  documents,
  dreamJournals,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  userMemories,
} from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { cluster } from "../services/cluster";
import { exportCoreMemoryMarkdown } from "../services/dreaming-core";
import {
  BACKFILL_LOCK,
  bootstrapMemoriesFromKnowledgeGraph,
  getBackfillStatus,
  runDreamingPipeline,
  runUserBackfillAsync,
} from "../services/dreaming-service";
import { callEmbeddingServer, chunkTexts, semanticDocumentHits, toVectorLiteral } from "../services/embedding";
import { findEntity } from "../services/entity-canon";
import { touchRecalled } from "../services/guidance-service";
import { renderMindResonanceMarkdown, senseResonance } from "../services/mind-resonance-service";
import { seesAll, userMachineIds } from "../services/visibility";

export const memoryRoutes = new Hono<AppEnv>();

async function bustUserMemoryCache(deps: Deps, userId: string): Promise<void> {
  const redis = deps.redis();
  await Promise.allSettled([
    cacheDeletePrefix(redis, `memory:tree:${userId}:`),
    cacheDeletePrefix(redis, `memory:core:${userId}:`),
    cacheDeletePrefix(redis, `memory:stats:${userId}:`),
    cacheDeletePrefix(redis, `memory:markdown:${userId}:`),
    cacheDeletePrefix(redis, `learning:check:${userId}:`),
    cacheDeletePrefix(redis, `project:blueprint:${userId}:`),
    cacheDeletePrefix(redis, `user:blueprint:v4:${userId}`),
  ]);
}

// Explicit projection for user_memories reads: intentionally omits 1024-dim `embedding` vector (~4KB/row)
const CORE_MEMORY_COLUMNS = {
  id: userMemories.id,
  parentId: userMemories.parentId,
  category: userMemories.category,
  key: userMemories.key,
  content: userMemories.content,
  confidence: userMemories.confidence,
  source: userMemories.source,
  treePath: userMemories.treePath,
  isFolder: userMemories.isFolder,
  status: userMemories.status,
  statusReason: userMemories.statusReason,
  supersededBy: userMemories.supersededBy,
  recallCount: userMemories.recallCount,
  lastRecalledAt: userMemories.lastRecalledAt,
  createdAt: userMemories.createdAt,
  updatedAt: userMemories.updatedAt,
};

function userDocIdsSq(userId: string) {
  return sql`(SELECT id FROM documents WHERE machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid))`;
}

// ---- GET /api/memory/stats ----
memoryRoutes.get("/stats", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const admin = seesAll(user, settings);
  const cacheKey = `memory:stats:${user.id}:${admin ? "True" : "False"}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const typeRows = await db
    .select({ entityType: knowledgeEntities.entityType, n: count() })
    .from(knowledgeEntities)
    .where(admin ? undefined : eq(knowledgeEntities.userId, user.id))
    .groupBy(knowledgeEntities.entityType);
  const entityTypes: Record<string, number> = {};
  let entities = 0;
  for (const r of typeRows) {
    const n = Number(r.n ?? 0);
    entityTypes[r.entityType] = n;
    entities += n;
  }

  const [relRow] = await db
    .select({ n: count() })
    .from(knowledgeRelations)
    .where(admin ? undefined : sql`${knowledgeRelations.sourceId} IN (SELECT id FROM knowledge_entities WHERE user_id = ${user.id}::uuid)`);
  const [obsRow] = await db
    .select({ n: count() })
    .from(knowledgeObservations)
    .where(admin ? undefined : sql`${knowledgeObservations.entityId} IN (SELECT id FROM knowledge_entities WHERE user_id = ${user.id}::uuid)`);
  const [embRow] = await db
    .select({ n: count() })
    .from(documentEmbeddings)
    .where(admin ? undefined : sql`${documentEmbeddings.documentId} IN ${userDocIdsSq(user.id)}`);

  const payload = {
    entities,
    relations: Number(relRow?.n ?? 0),
    observations: Number(obsRow?.n ?? 0),
    embeddings: Number(embRow?.n ?? 0),
    entity_types: entityTypes,
  };
  await cacheSet(redis, cacheKey, payload, 300);
  return c.json(payload);
});

// ---- GET /api/memory/resonance ----
memoryRoutes.get("/resonance", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const query = c.req.query("query") ?? null;
  const project = c.req.query("project") ?? null;
  const action = c.req.query("action") ?? null;
  const format = c.req.query("format") || "json";
  const limitEntities = queryInt(c, "limit_entities", 4, { ge: 1, le: 20 });
  const limitPitfalls = queryInt(c, "limit_pitfalls", 4, { ge: 1, le: 20 });

  const cacheKey = `memory:resonance:${user.id}:${query || ""}:${project || ""}:${action || ""}:${format}:${limitEntities}:${limitPitfalls}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const res = await senseResonance(db, redis, user, { query, project, action, limitEntities, limitPitfalls, settings: c.var.deps.settings });
  const result = format === "markdown" ? { markdown: renderMindResonanceMarkdown(res) } : res;
  await cacheSet(redis, cacheKey, result, 30);
  return c.json(result);
});

// ---- GET /api/memory/graph ----
memoryRoutes.get("/graph", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const limit = queryInt(c, "limit", 100, { ge: 1, le: 500 });
  const entityType = c.req.query("entity_type") || null;
  const admin = seesAll(user, settings);

  const conds: SQL[] = [];
  if (entityType) conds.push(eq(knowledgeEntities.entityType, entityType));
  if (!admin) conds.push(eq(knowledgeEntities.userId, user.id));

  const entities = await db
    .select()
    .from(knowledgeEntities)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(knowledgeEntities.updatedAt))
    .limit(limit);

  const nodes = entities.map((e) => ({ id: e.id, name: e.name, type: e.entityType, summary: e.summary }));
  const ids = entities.map((e) => e.id);
  const edges = ids.length
    ? (
        await db
          .select()
          .from(knowledgeRelations)
          .where(and(inArray(knowledgeRelations.sourceId, ids), inArray(knowledgeRelations.targetId, ids)))
      ).map((r) => ({ source: r.sourceId, target: r.targetId, type: r.relationType, strength: r.strength }))
    : [];

  return c.json({ nodes, edges });
});

// ---- GET /api/memory/entities/:entity_id ----
memoryRoutes.get("/entities/:entity_id", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const eid = pathUuid(c, "entity_id");
  const [entity] = await db.select().from(knowledgeEntities).where(eq(knowledgeEntities.id, eid)).limit(1);
  if (!entity || (!seesAll(user, settings) && entity.userId !== user.id)) {
    return c.json({ error: "not found" });
  }

  const [obsRows, outRows, inRows] = await Promise.all([
    db.select().from(knowledgeObservations).where(eq(knowledgeObservations.entityId, eid)).orderBy(desc(knowledgeObservations.observedAt)).limit(20),
    db
      .select({ targetName: knowledgeEntities.name, targetType: knowledgeEntities.entityType, relation: knowledgeRelations.relationType })
      .from(knowledgeRelations)
      .innerJoin(knowledgeEntities, eq(knowledgeRelations.targetId, knowledgeEntities.id))
      .where(eq(knowledgeRelations.sourceId, eid)),
    db
      .select({ sourceName: knowledgeEntities.name, sourceType: knowledgeEntities.entityType, relation: knowledgeRelations.relationType })
      .from(knowledgeRelations)
      .innerJoin(knowledgeEntities, eq(knowledgeRelations.sourceId, knowledgeEntities.id))
      .where(eq(knowledgeRelations.targetId, eid)),
  ]);

  const aliasKeys = ["name", "type", "summary", "merged_at", "replaced_at"] as const;
  const rawAliases = Array.isArray(entity.aliases) ? entity.aliases : [];
  const aliases = rawAliases
    .filter((a): a is Record<string, unknown> => Boolean(a && typeof a === "object"))
    .map((a) => {
      const obj: Record<string, unknown> = {};
      for (const k of aliasKeys) if (a[k] !== null && a[k] !== undefined) obj[k] = a[k];
      return obj;
    });

  return c.json({
    id: entity.id,
    name: entity.name,
    type: entity.entityType,
    summary: entity.summary,
    stale_at: pgToIso(entity.staleAt),
    stale_reason: entity.staleReason,
    aliases,
    observations: obsRows.map((o) => ({
      content: o.content,
      observed_at: pgToIso(o.observedAt),
      source_document_id: o.sourceDocumentId,
    })),
    outgoing_relations: outRows.map((r) => ({ target_name: r.targetName, target_type: r.targetType, relation: r.relation })),
    incoming_relations: inRows.map((r) => ({ source_name: r.sourceName, source_type: r.sourceType, relation: r.relation })),
  });
});

// ---- GET /api/memory/search ----
memoryRoutes.get("/search", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  if (!q.length) throw new HttpError(422, [{ type: "string_too_short", loc: ["query", "q"], msg: "min_length 1", input: q }]);
  const limit = queryInt(c, "limit", 10, { ge: 1, le: 50 });
  const admin = seesAll(user, settings);
  const pattern = `%${q}%`;
  const qLow = q.toLowerCase();

  const entConds: SQL[] = [or(ilike(knowledgeEntities.name, pattern), ilike(knowledgeEntities.summary, pattern))!];
  if (!admin) entConds.push(eq(knowledgeEntities.userId, user.id));
  const rankExpr = sql`CASE WHEN lower(${knowledgeEntities.name}) = ${qLow} THEN 0 WHEN ${knowledgeEntities.name} ILIKE ${`${q}%`} THEN 1 WHEN ${knowledgeEntities.name} ILIKE ${pattern} THEN 2 ELSE 3 END`;

  const ents = await db
    .select()
    .from(knowledgeEntities)
    .where(and(...entConds))
    .orderBy(rankExpr, sql`${knowledgeEntities.updatedAt} DESC NULLS LAST`)
    .limit(limit);

  const results: Record<string, unknown>[] = ents.map((e) => ({
    type: "entity",
    id: e.id,
    name: e.name,
    entity_type: e.entityType,
    summary: e.summary,
  }));

  if (results.length < limit) {
    const obsConds: SQL[] = [ilike(knowledgeObservations.content, pattern)];
    if (!admin) obsConds.push(eq(knowledgeEntities.userId, user.id));
    const obs = await db
      .select({ id: knowledgeObservations.id, content: knowledgeObservations.content, observedAt: knowledgeObservations.observedAt, entityName: knowledgeEntities.name })
      .from(knowledgeObservations)
      .innerJoin(knowledgeEntities, eq(knowledgeObservations.entityId, knowledgeEntities.id))
      .where(and(...obsConds))
      .orderBy(sql`${knowledgeObservations.observedAt} DESC NULLS LAST`)
      .limit(limit - results.length);
    for (const o of obs) {
      results.push({
        type: "observation",
        id: o.id,
        name: o.entityName,
        content: o.content,
        observed_at: pgToIso(o.observedAt),
      });
    }
  }
  return c.json(results);
});

// ---- POST /api/memory/observations ----
memoryRoutes.post("/observations", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const content = typeof body.content === "string" ? body.content : "";
  if (!content) throw new HttpError(422, [{ type: "missing", loc: ["body", "content"], msg: "Field required", input: body }]);
  const name = (typeof body.entity_name === "string" ? body.entity_name.trim() : "") || "Note";
  const etype = (typeof body.entity_type === "string" ? body.entity_type.trim() : "") || "concept";

  let entity = await findEntity(db, user.id, name, etype);
  if (!entity) {
    const [created] = await db
      .insert(knowledgeEntities)
      .values(withoutNul({ id: randomUUID(), userId: user.id, name, entityType: etype, aliases: [] }))
      .returning();
    entity = created!;
  }
  const [obs] = await db
    .insert(knowledgeObservations)
    .values(withoutNul({ id: randomUUID(), entityId: entity.id, content }))
    .returning();
  return c.json({ status: "stored", entity_id: entity.id, entity_name: entity.name, observation_id: obs!.id });
});

// ---- GET /api/memory/semantic ----
memoryRoutes.get("/semantic", async (c) => {
  const { db, settings } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const q = c.req.query("q") ?? "";
  if (!q.length || q.length > 1000) throw new HttpError(422, [{ type: "string_too_short", loc: ["query", "q"], msg: "1..1000", input: q }]);
  const limit = queryInt(c, "limit", 5, { ge: 1, le: 20 });
  const toolFilter = c.req.query("tool_filter") || null;
  const daysRaw = c.req.query("days");
  const days = daysRaw !== undefined ? queryInt(c, "days", 30, { ge: 1, le: 3650 }) : null;

  const mids = await userMachineIds(db, user, settings);
  const cleanQ = q.trim().toLowerCase();
  const cacheKey = `semantic:${user.id}:${cleanQ}:${limit}:${toolFilter || ""}:${days || ""}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const embeds = await callEmbeddingServer(settings, redis, [q], 30);
  if (!embeds || !embeds[0]) return c.json({ results: [], note: "embedding-server-unavailable" });

  const hits = await semanticDocumentHits(db, embeds[0], limit, { mids, tool: toolFilter, days });
  const texts = await chunkTexts(
    db,
    hits.map((h) => h.chunkId),
  );
  const docsMap = new Map<
    string,
    { id: string; toolId: string; title: string | null; relativePath: string; category: string; syncedAt: string }
  >();
  if (hits.length) {
    const dRows = await db
      .select({
        id: documents.id,
        toolId: documents.toolId,
        title: documents.title,
        relativePath: documents.relativePath,
        category: documents.category,
        syncedAt: documents.syncedAt,
      })
      .from(documents)
      .where(inArray(documents.id, hits.map((h) => h.documentId)));
    for (const r of dRows) docsMap.set(r.id, r);
  }

  const results = [];
  for (const h of hits) {
    const d = docsMap.get(h.documentId);
    if (!d) continue;
    results.push({
      id: d.id,
      tool_id: d.toolId,
      title: d.title || (d.relativePath ? d.relativePath.split("/").pop() : ""),
      relative_path: d.relativePath,
      category: d.category,
      snippet: (texts.get(h.chunkId) || "").slice(0, 400),
      synced_at: pgToIso(d.syncedAt),
      score: Math.round(h.similarity * 10000) / 10000,
    });
  }
  const payload = { results };
  await cacheSet(redis, cacheKey, payload, 300);
  return c.json(payload);
});

// ---- POST /api/memory/vacuum ----
memoryRoutes.post("/vacuum", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const admin = seesAll(user, settings);

  const obsEntRows = await db
    .selectDistinct({ eid: knowledgeObservations.entityId })
    .from(knowledgeObservations)
    .where(isNotNull(knowledgeObservations.entityId));
  const usedIds = obsEntRows.map((r) => r.eid);

  const conds: SQL[] = [];
  if (usedIds.length) conds.push(notInArray(knowledgeEntities.id, usedIds));
  if (!admin) conds.push(eq(knowledgeEntities.userId, user.id));
  const orphanIds = (
    await db
      .select({ id: knowledgeEntities.id })
      .from(knowledgeEntities)
      .where(conds.length ? and(...conds) : undefined)
  ).map((r) => r.id);

  let relsDeleted = 0;
  let entsDeleted = 0;
  if (orphanIds.length) {
    const r1 = await db
      .delete(knowledgeRelations)
      .where(or(inArray(knowledgeRelations.sourceId, orphanIds), inArray(knowledgeRelations.targetId, orphanIds)))
      .returning({ id: knowledgeRelations.id });
    relsDeleted = r1.length;
    const r2 = await db.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, orphanIds)).returning({ id: knowledgeEntities.id });
    entsDeleted = r2.length;
  }
  return c.json({ status: "vacuumed", scope: admin ? "all" : "self", entities_deleted: entsDeleted, relations_deleted: relsDeleted });
});

// ---- GET /api/memory/tiers ----
memoryRoutes.get("/tiers", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const admin = seesAll(user, settings);

  const [[l1], [ds], [msg], [core], [ent], [drm]] = await Promise.all([
    db.select({ n: count() }).from(askConversations).where(admin ? undefined : eq(askConversations.userId, user.id)),
    db.select({ n: count() }).from(dailySummaries).where(admin ? undefined : or(eq(dailySummaries.userId, user.id), isNull(dailySummaries.userId))),
    db.select({ n: count() }).from(conversationMessages).where(admin ? undefined : sql`${conversationMessages.documentId} IN ${userDocIdsSq(user.id)}`),
    db.select({ n: count() }).from(userMemories).where(admin ? undefined : eq(userMemories.userId, user.id)),
    db.select({ n: count() }).from(knowledgeEntities).where(admin ? undefined : eq(knowledgeEntities.userId, user.id)),
    db.select({ n: count() }).from(dreamJournals).where(admin ? undefined : eq(dreamJournals.userId, user.id)),
  ]);

  return c.json({
    l1_working: {
      tier_name: "L1 短期工作记忆 (Working Memory)",
      conversations: Number(l1?.n ?? 0),
      description: "即时上下文与最近交互轮次",
    },
    l2_episodic: {
      tier_name: "L2 中期情景记忆 (Episodic Memory)",
      daily_summaries: Number(ds?.n ?? 0),
      conversation_messages: Number(msg?.n ?? 0),
      description: "每日研发日报与历史活动事件流",
    },
    l3_core: {
      tier_name: "L3 长期核心记忆 (Core / Semantic Memory)",
      core_memories: Number(core?.n ?? 0),
      knowledge_entities: Number(ent?.n ?? 0),
      dream_journals: Number(drm?.n ?? 0),
      description: "自动做梦萃取与用户维护的核心开发铁律 (MEMORY.md)",
    },
  });
});

// ---- L3 Core Memory ----
memoryRoutes.get("/core/tree", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const rawCat = c.req.query("category");
  const realCat = rawCat && rawCat.trim() ? rawCat.trim() : null;
  const cacheKey = `memory:tree:${user.id}:${realCat || "all"}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const conds: SQL[] = [eq(userMemories.userId, user.id)];
  if (realCat) {
    if (realCat === "rule" || realCat === "rules") conds.push(inArray(userMemories.category, ["rule", "rules"]));
    else if (realCat === "tool" || realCat === "tools") conds.push(inArray(userMemories.category, ["tool", "tools"]));
    else conds.push(eq(userMemories.category, realCat));
  }

  const memories = await db
    .select(CORE_MEMORY_COLUMNS)
    .from(userMemories)
    .where(and(...conds))
    .orderBy(asc(userMemories.category), asc(userMemories.treePath), asc(userMemories.key));

  const categoryLabels: Record<string, string> = {
    project: "项目与业务系统",
    architecture: "架构设计与技术栈",
    rule: "开发铁律与避坑经验",
    rules: "开发铁律与避坑经验",
    tools: "工具链与AI助手生态",
    preference: "个人偏好与工作习惯",
    general: "通用常识与约定",
  };

  const sorted = [...memories].sort((a, b) => {
    const fa = a.isFolder ? 0 : 1;
    const fb = b.isFolder ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const da = (a.treePath || "").split("/").filter(Boolean).length;
    const dbLen = (b.treePath || "").split("/").filter(Boolean).length;
    return da - dbLen;
  });

  const folderNodes = new Map<string, Record<string, unknown>>();
  const rootNodes = new Map<string, Record<string, unknown>>();

  for (const m of sorted) {
    let p = (m.treePath || `/${m.category}/${m.key}`).trim();
    if (!p.startsWith("/")) p = `/${p}`;
    let parts = p.split("/").filter(Boolean);
    if (!parts.length) parts = [m.category, m.key];
    const dirParts = m.isFolder ? parts : parts.slice(0, -1);
    const leafName = m.isFolder ? null : parts[parts.length - 1]!;

    let currDir = "";
    let parentChildren: Record<string, unknown>[] | null = null;
    for (let idx = 0; idx < dirParts.length; idx++) {
      const part = dirParts[idx]!;
      currDir += `/${part}`;
      if (!folderNodes.has(currDir)) {
        const displayLabel = idx === 0 ? (categoryLabels[part] ?? part) : part;
        const isExplicit = m.isFolder && idx === dirParts.length - 1;
        const node: Record<string, unknown> = {
          id: isExplicit ? m.id : `dir:${currDir}`,
          name: part,
          title: displayLabel,
          category: m.category,
          tree_path: currDir,
          is_folder: true,
          children: [],
        };
        folderNodes.set(currDir, node);
        if (parentChildren) parentChildren.push(node);
        else rootNodes.set(currDir, node);
      } else if (m.isFolder && idx === dirParts.length - 1) {
        folderNodes.get(currDir)!.id = m.id;
      }
      parentChildren = folderNodes.get(currDir)!.children as Record<string, unknown>[];
    }

    if (!m.isFolder && leafName) {
      const leaf: Record<string, unknown> = {
        id: m.id,
        name: leafName,
        title: m.key,
        parent_id: m.parentId,
        category: m.category,
        key: m.key,
        content: m.content,
        confidence: m.confidence,
        source: m.source,
        tree_path: p,
        is_folder: false,
        status: m.status,
        status_reason: m.statusReason,
        recall_count: m.recallCount,
        created_at: pgToIso(m.createdAt),
        updated_at: pgToIso(m.updatedAt),
        children: [],
      };
      if (parentChildren) parentChildren.push(leaf);
      else rootNodes.set(`leaf:${m.id}`, leaf);
    }
  }

  const payload = { tree: [...rootNodes.values()], total_count: memories.length };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});

memoryRoutes.get("/core/markdown", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const excludeRaw = c.req.query("exclude") || "";
  const skip = [...new Set(excludeRaw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
  const cacheKey = `memory:markdown:${user.id}:${skip.join(",")}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const md = await exportCoreMemoryMarkdown(db, user, skip);
  const payload = { markdown: md };
  await cacheSet(redis, cacheKey, payload, 60);
  return c.json(payload);
});

memoryRoutes.get("/core", async (c) => {
  const { db } = c.var.deps;
  const redis = c.var.deps.redis();
  const user = await currentUser(c);
  const category = c.req.query("category") || null;
  const activeOnly = (c.req.query("active_only") ?? "").toLowerCase() === "true" || c.req.query("active_only") === "1";
  const recall = (c.req.query("recall") ?? "").toLowerCase() === "true" || c.req.query("recall") === "1";

  const cacheKey = `memory:core:${user.id}:${category || "all"}:${activeOnly ? "1" : "0"}`;
  if (!recall) {
    const cached = await cacheGet(redis, cacheKey);
    if (cached != null) return c.json(cached);
  }

  const conds: SQL[] = [eq(userMemories.userId, user.id)];
  if (activeOnly) conds.push(eq(userMemories.status, "active"));
  if (category) {
    if (category === "rule" || category === "rules") conds.push(inArray(userMemories.category, ["rule", "rules"]));
    else if (category === "tool" || category === "tools") conds.push(inArray(userMemories.category, ["tool", "tools"]));
    else conds.push(eq(userMemories.category, category));
  }

  const memories = await db
    .select(CORE_MEMORY_COLUMNS)
    .from(userMemories)
    .where(and(...conds))
    .orderBy(desc(userMemories.isFolder), asc(userMemories.category), desc(userMemories.updatedAt));

  if (recall) {
    await touchRecalled(
      db,
      memories.filter((m) => !m.isFolder).map((m) => m.id),
    ).catch(() => {});
  }

  const payload = memories.map((m) => ({
    id: m.id,
    parent_id: m.parentId,
    category: m.category,
    key: m.key,
    content: m.content,
    confidence: m.confidence,
    source: m.source,
    tree_path: m.treePath || `/${m.category}/${m.key}`,
    is_folder: m.isFolder,
    status: m.status,
    status_reason: m.statusReason,
    superseded_by: m.supersededBy,
    recall_count: m.recallCount,
    last_recalled_at: pgToIso(m.lastRecalledAt),
    created_at: pgToIso(m.createdAt),
    updated_at: pgToIso(m.updatedAt),
  }));
  if (!recall) {
    await cacheSet(redis, cacheKey, payload, 60);
  }
  return c.json(payload);
});

memoryRoutes.post("/core/:memory_id/revive", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const mid = pathUuid(c, "memory_id");
  const [mem] = await deps.db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.id, mid), eq(userMemories.userId, user.id)))
    .limit(1);
  if (!mem) throw new HttpError(404, "not found");
  await deps.db
    .update(userMemories)
    .set({ status: "active", statusReason: null, supersededBy: null, lastRecalledAt: new Date().toISOString() })
    .where(eq(userMemories.id, mid));
  await bustUserMemoryCache(deps, user.id);
  return c.json({ status: "active", id: mid });
});

memoryRoutes.post("/core", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const cat = String(body.category || "general").trim().toLowerCase();
  const key = String(body.key || "").trim().toLowerCase().replaceAll(" ", "_");
  const content = String(body.content || "").trim();
  const confidence = typeof body.confidence === "number" ? body.confidence : 1.0;
  const parentId = typeof body.parent_id === "string" && body.parent_id ? normalizeUuid(body.parent_id) : null;
  const isFolder = Boolean(body.is_folder ?? false);

  if (!key || !content) return c.json({ error: "key and content are required" });

  let treePath = typeof body.tree_path === "string" ? body.tree_path : "";
  if (!treePath) {
    if (parentId) {
      const [parent] = await db
        .select()
        .from(userMemories)
        .where(and(eq(userMemories.id, parentId), eq(userMemories.userId, user.id)))
        .limit(1);
      if (parent) {
        const pp = (parent.treePath || `/${parent.category}/${parent.key}`).replace(/\/+$/, "");
        treePath = `${pp}/${key}`;
      }
    }
    if (!treePath) treePath = `/${cat}/${key}`;
  }

  let vec: number[] | null = null;
  try {
    const embeds = await callEmbeddingServer(settings, redis, [content], 3);
    if (embeds?.[0]?.length) vec = embeds[0];
  } catch {
    /* optional */
  }

  const [existing] = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, cat), eq(userMemories.key, key)))
    .limit(1);
  const nowIso = new Date().toISOString();

  if (existing) {
    await db
      .update(userMemories)
      .set(withoutNul({ content, confidence, source: "manual", parentId, treePath, isFolder, updatedAt: nowIso }))
      .where(eq(userMemories.id, existing.id));
    if (vec) {
      await db.execute(sql`UPDATE user_memories SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${existing.id}::uuid`).catch(() => {});
    }
    await bustUserMemoryCache(deps, user.id);
    return c.json({ status: "updated", id: existing.id });
  }

  const id = randomUUID();
  await db.insert(userMemories).values(
    withoutNul({
      id,
      userId: user.id,
      category: cat,
      key,
      content,
      confidence,
      source: "manual",
      parentId,
      treePath,
      isFolder,
      status: "active",
      recallCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
  );
  if (vec) {
    await db.execute(sql`UPDATE user_memories SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${id}::uuid`).catch(() => {});
  }
  await bustUserMemoryCache(deps, user.id);
  return c.json({ status: "created", id });
});

memoryRoutes.put("/core/:memory_id", async (c) => {
  const deps = c.var.deps;
  const { db, settings } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const mid = pathUuid(c, "memory_id");
  const body = await parseJsonObject(c);

  const [mem] = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.id, mid), eq(userMemories.userId, user.id)))
    .limit(1);
  if (!mem) return c.json({ error: "not found" });

  const patch: Partial<typeof userMemories.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (typeof body.category === "string") patch.category = body.category.trim().toLowerCase();
  if (typeof body.key === "string") patch.key = body.key.trim().toLowerCase().replaceAll(" ", "_");
  let vec: number[] | null = null;
  if (typeof body.content === "string") {
    patch.content = body.content.trim();
    patch.source = "manual";
    try {
      const embeds = await callEmbeddingServer(settings, redis, [patch.content], 3);
      if (embeds?.[0]?.length) vec = embeds[0];
    } catch {
      /* ignore */
    }
  }
  if (typeof body.confidence === "number") patch.confidence = body.confidence;
  if (body.parent_id !== undefined) patch.parentId = typeof body.parent_id === "string" ? normalizeUuid(body.parent_id) : null;
  if (typeof body.tree_path === "string") patch.treePath = body.tree_path.trim();
  if (typeof body.is_folder === "boolean") patch.isFolder = body.is_folder;

  await db.update(userMemories).set(withoutNul(patch)).where(eq(userMemories.id, mid));
  if (vec) {
    await db.execute(sql`UPDATE user_memories SET embedding = ${toVectorLiteral(vec)}::vector WHERE id = ${mid}::uuid`).catch(() => {});
  }
  await bustUserMemoryCache(deps, user.id);
  return c.json({ status: "updated", id: mid });
});

memoryRoutes.delete("/core/:memory_id", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const mid = pathUuid(c, "memory_id");
  const [mem] = await deps.db
    .select({ id: userMemories.id })
    .from(userMemories)
    .where(and(eq(userMemories.id, mid), eq(userMemories.userId, user.id)))
    .limit(1);
  if (!mem) return c.json({ error: "not found" });
  await deps.db.delete(userMemories).where(eq(userMemories.id, mid));
  await bustUserMemoryCache(deps, user.id);
  return c.json({ status: "deleted", id: mid });
});

// ---- Dreaming & Dream Journals ----
memoryRoutes.get("/dreams", async (c) => {
  const user = await currentUser(c);
  const limit = queryInt(c, "limit", 20, { ge: 1, le: 100 });
  const offset = queryInt(c, "offset", 0, { ge: 0 });
  const journals = await c.var.deps.db
    .select()
    .from(dreamJournals)
    .where(eq(dreamJournals.userId, user.id))
    .orderBy(desc(dreamJournals.createdAt))
    .offset(offset)
    .limit(limit);
  return c.json({
    journals: journals.map((j) => ({
      id: j.id,
      dream_date: String(j.dreamDate).slice(0, 10),
      stage_metrics: j.stageMetrics ?? {},
      created_at: pgToIso(j.createdAt),
      summary_snippet: (j.remReflections || j.lightSleepNotes || "").slice(0, 200),
    })),
  });
});

memoryRoutes.get("/dreams/:dream_id", async (c) => {
  const user = await currentUser(c);
  const did = pathUuid(c, "dream_id");
  const [j] = await c.var.deps.db
    .select()
    .from(dreamJournals)
    .where(and(eq(dreamJournals.id, did), eq(dreamJournals.userId, user.id)))
    .limit(1);
  if (!j) return c.json({ error: "not found" });
  return c.json({
    id: j.id,
    dream_date: String(j.dreamDate).slice(0, 10),
    stage_metrics: j.stageMetrics ?? {},
    light_sleep_notes: j.lightSleepNotes,
    rem_reflections: j.remReflections,
    deep_consolidations: j.deepConsolidations,
    report_markdown: j.reportMarkdown,
    created_at: pgToIso(j.createdAt),
  });
});

memoryRoutes.post("/dream", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c).catch(() => ({} as Record<string, unknown>));
  const daysBack = typeof body.days_back === "number" ? body.days_back : 1;
  const startDate = typeof body.start_date === "string" && body.start_date ? body.start_date : null;
  const endDate = typeof body.end_date === "string" && body.end_date ? body.end_date : null;
  const journal = await runDreamingPipeline(db, settings, c.var.deps.redis(), user, {
    daysBack,
    startDate,
    endDate,
    tag: "on_demand",
  });
  return c.json({
    status: "completed",
    journal_id: journal!.id,
    dream_date: String(journal!.dreamDate).slice(0, 10),
    stage_metrics: journal!.stageMetrics,
    report_markdown: journal!.reportMarkdown,
  });
});

memoryRoutes.get("/dream/backfill/status", async (c) => {
  const user = await currentUser(c);
  return c.json(await getBackfillStatus(user.id));
});

memoryRoutes.post("/dream/backfill", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c).catch(() => ({} as Record<string, unknown>));
  const chunkDays = typeof body.chunk_days === "number" ? body.chunk_days : 3;
  const maxChunks = typeof body.max_chunks === "number" ? body.max_chunks : 30;
  const runAsync = body.run_async !== false;

  const mutex = await cluster.mutex(BACKFILL_LOCK + user.id);
  if (!mutex) {
    return c.json({
      status: "already_running",
      message: "历史回填任务已在运行中，请勿重复触发",
      progress: await getBackfillStatus(user.id),
    });
  }
  if (runAsync) {
    cluster.spawn(async () => {
      await runUserBackfillAsync(deps, user.id, chunkDays, maxChunks, mutex);
    });
    return c.json({
      status: "started",
      message: `历史记忆渐进回填任务已在后台启动 (每 ${chunkDays} 天一切片)`,
      chunk_days: chunkDays,
      max_chunks: maxChunks,
    });
  }
  const result = await runUserBackfillAsync(deps, user.id, chunkDays, maxChunks, mutex);
  return c.json({ status: "completed", result });
});

memoryRoutes.post("/bootstrap", async (c) => {
  const { db, settings } = c.var.deps;
  const user = await currentUser(c);
  return c.json(await bootstrapMemoriesFromKnowledgeGraph(db, settings, c.var.deps.redis(), user));
});
