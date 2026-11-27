// Memory compaction: compress old observations (>7 days) into summaries & prune weak relations
// (server/server/services/memory_compaction.py).
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { knowledgeEntities, knowledgeObservations, knowledgeRelations, users } from "../db/pulled/schema";
import { callPlainChat, getAiProviders } from "./ai-provider";

const COMPACTION_AGE_DAYS = Number(process.env.MEMENTO_COMPACTION_AGE_DAYS || "7") || 7;
const MIN_OBSERVATIONS_TO_COMPACT = 5;

async function callCompactionLlm(
  settings: Settings,
  redis: Redis | null,
  prompt: string,
  user?: UserRow | null,
): Promise<{ summary?: string; compacted_observations?: string[] } | null> {
  if (!getAiProviders(settings, { user: user ?? null }).length) return null;
  try {
    const raw = await callPlainChat(settings, redis, [{ role: "user", content: `${prompt}\n\nRespond with JSON only.` }], {
      maxTokens: 1000,
      user: user ?? null,
    });
    if (!raw) return null;
    let text = raw.trim();
    if (text.startsWith("```")) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : text;
      if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    }
    text = text.trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end)) as { summary?: string; compacted_observations?: string[] };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function compactEntity(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  entity: typeof knowledgeEntities.$inferSelect,
  owner?: UserRow | null,
): Promise<number> {
  const cutoffIso = new Date(Date.now() - COMPACTION_AGE_DAYS * 86400_000).toISOString();
  const oldObs = await db
    .select()
    .from(knowledgeObservations)
    .where(and(eq(knowledgeObservations.entityId, entity.id), lt(knowledgeObservations.observedAt, cutoffIso)))
    .orderBy(asc(knowledgeObservations.observedAt));

  if (oldObs.length < MIN_OBSERVATIONS_TO_COMPACT) return 0;

  const obsText = oldObs.map((o) => `- [${o.observedAt ? String(o.observedAt).slice(0, 10) : "?"}] ${o.content}`).join("\n");
  const prompt =
    `你是一个知识库管理员。以下是关于实体「${entity.name}」(${entity.entityType}) 的多条历史观察记录。\n` +
    "请将它们合并压缩为 1-3 条精炼的摘要，保留关键事实，去掉重复和过时信息。\n" +
    "如果有矛盾信息，保留最新的。用中文回复。\n\n" +
    `当前实体摘要：${entity.summary || "(无)"}\n\n` +
    `历史观察记录：\n${obsText}\n\n` +
    '返回 JSON：\n{"summary": "更新后的实体摘要", "compacted_observations": ["压缩后的观察1", "压缩后的观察2"]}\n';

  const result = await callCompactionLlm(settings, redis, prompt, owner);
  if (!result) return 0;

  const nowIso = new Date().toISOString();
  const newSummary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (newSummary) {
    await db
      .update(knowledgeEntities)
      .set(withoutNul({ summary: newSummary, updatedAt: nowIso }))
      .where(eq(knowledgeEntities.id, entity.id));
  }

  const oldIds = oldObs.map((o) => o.id);
  await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.id, oldIds));

  const compacted = Array.isArray(result.compacted_observations) ? result.compacted_observations : [];
  let inserted = 0;
  for (const c of compacted) {
    const clean = typeof c === "string" ? c.trim() : "";
    if (!clean) continue;
    await db.insert(knowledgeObservations).values(
      withoutNul({
        id: randomUUID(),
        entityId: entity.id,
        content: clean,
        observedAt: nowIso,
      }),
    );
    inserted++;
  }
  return oldIds.length - inserted;
}

export async function compactStaleRelations(db: Db): Promise<number> {
  const deleted = await db
    .delete(knowledgeRelations)
    .where(lt(knowledgeRelations.strength, 1.5))
    .returning({ id: knowledgeRelations.id });
  return deleted.length;
}

export async function runCompaction(db: Db, settings: Settings, redis: Redis | null) {
  const entities = await db.select().from(knowledgeEntities).orderBy(asc(knowledgeEntities.updatedAt));
  const ownerRows = await db.select().from(users);
  const owners = new Map(ownerRows.map((u) => [u.id, u]));

  let totalRemoved = 0;
  let entitiesCompacted = 0;
  for (const entity of entities) {
    const owner = entity.userId ? owners.get(entity.userId) ?? null : null;
    const removed = await compactEntity(db, settings, redis, entity, owner);
    if (removed > 0) {
      totalRemoved += removed;
      entitiesCompacted++;
    }
  }
  const weakRemoved = await compactStaleRelations(db);
  return {
    entities_compacted: entitiesCompacted,
    observations_removed: totalRemoved,
    weak_relations_removed: weakRemoved,
  };
}
