// Knowledge graph auto-extraction from conversations & notes (server/server/services/graph_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import {
  conversationMessages,
  documents,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  users,
} from "../db/pulled/schema";
import { callPlainChat, getAiProviders } from "./ai-provider";
import { cluster } from "./cluster";
import { safeJsonLoads } from "./dreaming-core";
import { findEntity, isGone, summaryUpdate } from "./entity-canon";

export const GRAPH_MIN_INTERVAL = 600;
const GRAPH_CATEGORIES = new Set(["conversation", "memory", "learning", "plan", "identity"]);

const EXTRACTION_TEMPLATE =
  "分析以下 AI 编程对话，提取结构化知识。用中文回复。\n\n" +
  "返回 JSON 对象：\n" +
  '{"entities": [{"name": "实体名", "type": "project|tool|technology|concept|person|file", "summary": "简要描述"}],\n' +
  ' "relations": [{"source": "实体1", "target": "实体2", "type": "uses|creates|depends_on|fixes|discussed"}],\n' +
  ' "observations": [{"entity": "实体名", "content": "学到了什么、做了什么决定"}]}\n\n' +
  "规则：\n" +
  "- 提取具体的、可复用的知识（不要泛泛而谈）\n" +
  "- 实体名用标准名称（如 PostgreSQL 而非 postgres 数据库）\n" +
  "- summary 和 observations 的 content 用中文\n" +
  "- 最多 10 个实体、10 个关系、10 个观察\n" +
  "- 重点关注：使用的技术、解决的问题、做出的决定\n\n" +
  "对话内容：\n";

export function extractedRecently(doc: { metadata?: unknown }): boolean {
  const m = doc.metadata && typeof doc.metadata === "object" ? (doc.metadata as Record<string, unknown>) : {};
  const at = m._graph_at;
  return typeof at === "number" && Date.now() / 1000 - at < GRAPH_MIN_INTERVAL;
}

export async function extractKnowledgeFromDocument(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  doc: typeof documents.$inferSelect,
  explicitUserId?: string | null,
): Promise<number> {
  if (!doc.content || doc.content.length < 200 || !GRAPH_CATEGORIES.has(doc.category)) {
    await db.update(documents).set({ knowledgeStatus: "skipped" }).where(eq(documents.id, doc.id));
    return 0;
  }

  const contentRaw = doc.content;
  const hashSeed = `${contentRaw.length}:${contentRaw.slice(0, 2000)}:${contentRaw.slice(-2000)}`;
  const contentHash = createHash("md5").update(hashSeed, "utf8").digest("hex");
  const docMeta = doc.metadata && typeof doc.metadata === "object" ? (doc.metadata as Record<string, unknown>) : {};

  const [existingObs] = await db
    .select({ id: knowledgeObservations.id })
    .from(knowledgeObservations)
    .where(eq(knowledgeObservations.sourceDocumentId, doc.id))
    .limit(1);
  if (existingObs && docMeta._graph_hash === contentHash) {
    await db.update(documents).set({ knowledgeStatus: "ok" }).where(eq(documents.id, doc.id));
    return 0;
  }

  const MAX_GRAPH_CHARS = 12000;
  let content = "";
  if (doc.category === "conversation") {
    const rows = await db
      .select({ role: conversationMessages.role, content: conversationMessages.content })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.documentId, doc.id), inArray(conversationMessages.role, ["user", "assistant"])))
      .orderBy(asc(conversationMessages.lineNumber))
      .limit(400);
    const chunks: string[] = [];
    for (const r of rows) {
      const text = (r.content || "").trim();
      if (!text || text.startsWith("[Result]") || text.startsWith("[Tool:") || text.startsWith('{"tool_use_id"')) continue;
      chunks.push(`[${r.role}] ${text}\n`);
    }
    const fullChat = chunks.join("");
    if (fullChat) {
      content =
        fullChat.length <= MAX_GRAPH_CHARS
          ? fullChat
          : `${fullChat.slice(0, 4000)}\n\n... [省略部分中间交互，保留开头意图与最终技术决策结论] ...\n\n${fullChat.slice(-8000)}`;
    }
  }
  if (!content) {
    content = contentRaw.length <= MAX_GRAPH_CHARS ? contentRaw : `${contentRaw.slice(0, 4000)}\n\n...\n\n${contentRaw.slice(-8000)}`;
  }

  let userId = explicitUserId ?? null;
  if (!userId && doc.machineId) {
    const [m] = await db.select({ userId: machines.userId }).from(machines).where(eq(machines.id, doc.machineId)).limit(1);
    userId = m?.userId ?? null;
  }
  const [userObj] = userId ? await db.select().from(users).where(eq(users.id, userId)).limit(1) : [];

  const lock = await cluster.mutex(`graph-extract:${doc.id}`, 120);
  if (!lock) return 0;

  try {
    await db
      .update(documents)
      .set({ knowledgeAttempts: (doc.knowledgeAttempts ?? 0) + 1 })
      .where(eq(documents.id, doc.id));

    if (!getAiProviders(settings, { background: true, user: userObj ?? null }).length) {
      await db.update(documents).set({ knowledgeStatus: "failed" }).where(eq(documents.id, doc.id));
      return 0;
    }

    const raw = await callPlainChat(
      settings,
      redis,
      [{ role: "user", content: `${EXTRACTION_TEMPLATE}${content}\n\nRespond with JSON only.` }],
      { maxTokens: 2000, background: true, user: userObj ?? null },
    );
    const parsed = raw ? safeJsonLoads(raw) : {};
    if (!raw || !Object.keys(parsed).length) {
      await db.update(documents).set({ knowledgeStatus: "failed" }).where(eq(documents.id, doc.id));
      return 0;
    }

    await db.delete(knowledgeObservations).where(eq(knowledgeObservations.sourceDocumentId, doc.id));
    let count = 0;
    const entityMap = new Map<string, typeof knowledgeEntities.$inferSelect>();
    const goneNotes: [typeof knowledgeEntities.$inferSelect, string][] = [];
    const nowIso = new Date().toISOString();

    const entities = Array.isArray(parsed.entities) ? (parsed.entities as Record<string, unknown>[]) : [];
    for (const e of entities) {
      if (!e || typeof e !== "object") continue;
      const name = String(e.name ?? "").trim();
      const etype = String(e.type ?? "concept").trim() || "concept";
      const sum = e.summary ? String(e.summary).trim() : null;
      if (!name) continue;
      const existing = userId ? await findEntity(db, userId, name, etype) : null;
      if (existing) {
        const nextSum = summaryUpdate(existing.summary, sum, Boolean(existing.staleAt));
        if (nextSum) {
          await db
            .update(knowledgeEntities)
            .set({ summary: nextSum, staleAt: null, staleReason: null, updatedAt: nowIso })
            .where(eq(knowledgeEntities.id, existing.id));
          existing.summary = nextSum;
        } else if (sum && isGone(sum) && !isGone(existing.summary)) {
          goneNotes.push([existing, sum]);
        }
        entityMap.set(name, existing);
      } else {
        const [created] = await db
          .insert(knowledgeEntities)
          .values(
            withoutNul({
              id: randomUUID(),
              userId,
              name,
              entityType: etype,
              summary: sum,
              aliases: [],
              createdAt: nowIso,
              updatedAt: nowIso,
            }),
          )
          .returning();
        if (created) {
          entityMap.set(name, created);
          count++;
        }
      }
    }

    const relations = Array.isArray(parsed.relations) ? (parsed.relations as Record<string, unknown>[]) : [];
    for (const r of relations) {
      if (!r || typeof r !== "object") continue;
      const source = entityMap.get(String(r.source ?? ""));
      const target = entityMap.get(String(r.target ?? ""));
      const relType = String(r.type ?? "related").trim() || "related";
      if (!source || !target || source.id === target.id) continue;
      const [existingRel] = await db
        .select()
        .from(knowledgeRelations)
        .where(
          and(
            eq(knowledgeRelations.sourceId, source.id),
            eq(knowledgeRelations.targetId, target.id),
            eq(knowledgeRelations.relationType, relType),
          ),
        )
        .limit(1);
      if (existingRel) {
        await db
          .update(knowledgeRelations)
          .set({ strength: (existingRel.strength ?? 1) + 1 })
          .where(eq(knowledgeRelations.id, existingRel.id));
      } else {
        await db.insert(knowledgeRelations).values({
          id: randomUUID(),
          sourceId: source.id,
          targetId: target.id,
          relationType: relType,
          strength: 1.0,
        });
        count++;
      }
    }

    const observations = Array.isArray(parsed.observations) ? (parsed.observations as Record<string, unknown>[]) : [];
    for (const o of observations) {
      if (!o || typeof o !== "object") continue;
      const entity = entityMap.get(String(o.entity ?? ""));
      const obsText = String(o.content ?? "").trim();
      if (!entity || !obsText) continue;
      await db.insert(knowledgeObservations).values(
        withoutNul({
          id: randomUUID(),
          entityId: entity.id,
          content: obsText,
          sourceDocumentId: doc.id,
          observedAt: nowIso,
        }),
      );
      count++;
    }

    for (const [entity, note] of goneNotes) {
      await db.insert(knowledgeObservations).values(
        withoutNul({
          id: randomUUID(),
          entityId: entity.id,
          content: note,
          sourceDocumentId: doc.id,
          observedAt: nowIso,
        }),
      );
      count++;
    }

    const [fresh] = await db.select({ metadata: documents.metadata }).from(documents).where(eq(documents.id, doc.id)).limit(1);
    const mergedMeta = {
      ...(fresh?.metadata && typeof fresh.metadata === "object" ? (fresh.metadata as Record<string, unknown>) : {}),
      _graph_hash: contentHash,
      _graph_at: Date.now() / 1000,
    };
    await db
      .update(documents)
      .set({ metadata: mergedMeta, knowledgeStatus: "ok", knowledgeAttempts: 0 })
      .where(eq(documents.id, doc.id));
    return count;
  } finally {
    await lock.release();
  }
}

/**
 * Nightly knowledge graph hygiene:
 * 1) Merge exact case-insensitive duplicate entities (lower(trim(name))) per user,
 *    preserving all observations, relations (summing colliding edge strengths), and aliases on the canonical row.
 * 2) Soft-mark stale orphan `concept` entities (> orphanDays old, 0 observations, 0 relations) with `stale_at`
 *    instead of hard deleting, keeping the audit trail intact.
 */
export async function deduplicateAndPruneGraph(
  db: Db,
  userId: string,
  opts: { maxGroups?: number; orphanDays?: number; maxOrphans?: number; nowMs?: number } = {},
): Promise<{ groups_merged: number; duplicates_removed: number; orphans_marked_stale: number }> {
  const maxGroups = opts.maxGroups ?? 200;
  const orphanDays = opts.orphanDays ?? 60;
  const maxOrphans = opts.maxOrphans ?? 500;
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1) Find case-insensitive duplicate entity groups for this user
  const dupGroups = (await db.execute(sql`
    SELECT lower(btrim(name)) AS norm_name, count(*)::int AS cnt
    FROM knowledge_entities
    WHERE user_id = ${userId}::uuid
    GROUP BY lower(btrim(name))
    HAVING count(*) > 1
    ORDER BY count(*) DESC
    LIMIT ${maxGroups}
  `)) as unknown as { norm_name: string; cnt: number }[];

  let groupsMerged = 0;
  let duplicatesRemoved = 0;

  for (const grp of dupGroups) {
    const members = (await db.execute(sql`
      SELECT e.id, e.name, e.summary, e.aliases, e.created_at,
             (SELECT count(*)::int FROM knowledge_observations o WHERE o.entity_id = e.id) AS obs_cnt
      FROM knowledge_entities e
      WHERE e.user_id = ${userId}::uuid AND lower(btrim(e.name)) = ${grp.norm_name}
      ORDER BY obs_cnt DESC, e.created_at ASC
    `)) as unknown as { id: string; name: string; summary: string | null; aliases: unknown; created_at: string; obs_cnt: number }[];
    if (members.length < 2) continue;

    const canonical = members[0]!;
    const dupes = members.slice(1);
    const dupeIds = dupes.map((d) => d.id);

    const aliasSet = new Set<string>(
      Array.isArray(canonical.aliases) ? canonical.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
    );
    let bestSummary = canonical.summary || null;
    for (const d of dupes) {
      if (d.name && d.name !== canonical.name) aliasSet.add(d.name);
      if (Array.isArray(d.aliases)) {
        for (const a of d.aliases) {
          const s = String(a).trim();
          if (s && s !== canonical.name) aliasSet.add(s);
        }
      }
      if (!bestSummary && d.summary) bestSummary = d.summary;
    }

    // Re-point observations to canonical entity
    await db
      .update(knowledgeObservations)
      .set({ entityId: canonical.id })
      .where(inArray(knowledgeObservations.entityId, dupeIds));

    // Re-point relations while collapsing duplicate edges & eliminating self-loops
    const rels = await db
      .select()
      .from(knowledgeRelations)
      .where(inArray(knowledgeRelations.sourceId, dupeIds));
    for (const rel of rels) {
      const nextSource = canonical.id;
      const nextTarget = dupeIds.includes(rel.targetId) ? canonical.id : rel.targetId;
      if (nextSource === nextTarget) {
        await db.delete(knowledgeRelations).where(eq(knowledgeRelations.id, rel.id));
        continue;
      }
      const [existing] = await db
        .select()
        .from(knowledgeRelations)
        .where(
          and(
            eq(knowledgeRelations.sourceId, nextSource),
            eq(knowledgeRelations.targetId, nextTarget),
            eq(knowledgeRelations.relationType, rel.relationType),
          ),
        )
        .limit(1);
      if (existing && existing.id !== rel.id) {
        await db
          .update(knowledgeRelations)
          .set({ strength: (existing.strength ?? 1) + (rel.strength ?? 1) })
          .where(eq(knowledgeRelations.id, existing.id));
        await db.delete(knowledgeRelations).where(eq(knowledgeRelations.id, rel.id));
      } else {
        await db
          .update(knowledgeRelations)
          .set({ sourceId: nextSource, targetId: nextTarget })
          .where(eq(knowledgeRelations.id, rel.id));
      }
    }

    const incomingRels = await db
      .select()
      .from(knowledgeRelations)
      .where(inArray(knowledgeRelations.targetId, dupeIds));
    for (const rel of incomingRels) {
      const nextSource = dupeIds.includes(rel.sourceId) ? canonical.id : rel.sourceId;
      const nextTarget = canonical.id;
      if (nextSource === nextTarget) {
        await db.delete(knowledgeRelations).where(eq(knowledgeRelations.id, rel.id));
        continue;
      }
      const [existing] = await db
        .select()
        .from(knowledgeRelations)
        .where(
          and(
            eq(knowledgeRelations.sourceId, nextSource),
            eq(knowledgeRelations.targetId, nextTarget),
            eq(knowledgeRelations.relationType, rel.relationType),
          ),
        )
        .limit(1);
      if (existing && existing.id !== rel.id) {
        await db
          .update(knowledgeRelations)
          .set({ strength: (existing.strength ?? 1) + (rel.strength ?? 1) })
          .where(eq(knowledgeRelations.id, existing.id));
        await db.delete(knowledgeRelations).where(eq(knowledgeRelations.id, rel.id));
      } else {
        await db
          .update(knowledgeRelations)
          .set({ sourceId: nextSource, targetId: nextTarget })
          .where(eq(knowledgeRelations.id, rel.id));
      }
    }

    await db
      .update(knowledgeEntities)
      .set({ summary: bestSummary, aliases: [...aliasSet], updatedAt: nowIso })
      .where(eq(knowledgeEntities.id, canonical.id));

    await db.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, dupeIds));
    groupsMerged++;
    duplicatesRemoved += dupeIds.length;
  }

  // 2) Soft-mark orphan concept entities older than orphanDays with 0 observations & 0 relations
  const cutoffIso = new Date(nowMs - orphanDays * 86400_000).toISOString();
  const orphans = (await db.execute(sql`
    UPDATE knowledge_entities e
    SET stale_at = ${nowIso}::timestamptz,
        stale_reason = ${`孤立概念超过 ${orphanDays} 天无观察与关联`}
    WHERE e.id IN (
      SELECT ke.id
      FROM knowledge_entities ke
      WHERE ke.user_id = ${userId}::uuid
        AND ke.entity_type = 'concept'
        AND ke.stale_at IS NULL
        AND coalesce(ke.updated_at, ke.created_at) < ${cutoffIso}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM knowledge_observations o WHERE o.entity_id = ke.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_relations r WHERE r.source_id = ke.id OR r.target_id = ke.id)
      LIMIT ${maxOrphans}
    )
    RETURNING e.id
  `)) as unknown as { id: string }[];

  return {
    groups_merged: groupsMerged,
    duplicates_removed: duplicatesRemoved,
    orphans_marked_stale: orphans.length,
  };
}
