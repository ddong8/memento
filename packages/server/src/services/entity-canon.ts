// Canonical knowledge-graph entity resolution, dedup & stale marking (server/server/services/entity_canon.py).
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { knowledgeEntities, knowledgeObservations, knowledgeRelations } from "../db/pulled/schema";

export type KnowledgeEntityRow = typeof knowledgeEntities.$inferSelect;

export const IDENTITY_TYPES = new Set(["person", "organization"]);
const ANY_TYPE = "*";
export const GONE_PATTERN =
  "(已|被)(彻底|完全|全部)?(卸载|删除|删掉|移除|下线|废弃|弃用|停用|淘汰|清除|清理掉)|不再(使用|维护)|已被[^，。]{0,12}(替换|取代|替代)";
export const GONE_RE = new RegExp(GONE_PATTERN);
export const STALE_MIN_DOCUMENTS = 2;
export const STALE_AFTER_MS = 86_400_000;

export function normName(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase().replace(/[-_\s]+/g, "");
}

export function mergeClass(entityType: string | null | undefined): string {
  const t = (entityType || "").trim().toLowerCase();
  return IDENTITY_TYPES.has(t) ? t : ANY_TYPE;
}

export function isGone(summary: string | null | undefined): boolean {
  return Boolean(summary && GONE_RE.test(summary));
}

export async function findEntity(db: Db, userId: string, name: string, entityType: string): Promise<KnowledgeEntityRow | null> {
  const norm = normName(name);
  if (!norm) return null;
  const cls = mergeClass(entityType);
  const typeCond =
    cls === ANY_TYPE
      ? notInArray(sql`lower(${knowledgeEntities.entityType})`, [...IDENTITY_TYPES])
      : eq(sql`lower(${knowledgeEntities.entityType})`, cls);

  const rows = await db
    .select()
    .from(knowledgeEntities)
    .where(
      and(
        eq(knowledgeEntities.userId, userId),
        sql`regexp_replace(lower(${knowledgeEntities.name}), '[-_\\s]+', '', 'g') = ${norm}`,
        typeCond,
      ),
    )
    .orderBy(asc(knowledgeEntities.createdAt))
    .limit(20);

  const exact = rows.find((r) => r.name === name && r.entityType === entityType);
  return exact ?? rows[0] ?? null;
}

export function summaryUpdate(old: string | null | undefined, next: string | null | undefined, oldStale = false): string | null {
  const n = (next || "").trim();
  const o = (old || "").trim();
  if (!n || n === o) return null;
  if (!o) return n;
  const oldGone = oldStale || isGone(o);
  const newGone = isGone(n);
  if (newGone && !oldGone) return null;
  if (oldGone && !newGone) return n;
  return n.length > o.length ? n : null;
}

export interface EntityRow {
  id: string;
  name: string;
  entityType: string;
  summary: string | null;
  createdAt: string | null;
  aliases: unknown[];
  observations: number;
  relations: number;
  staleAt: string | null;
  staleReason: string | null;
}

export interface MergePlan {
  canonical: EntityRow;
  duplicates: EntityRow[];
  summary: string | null;
  aliases: unknown[];
  clearStale: boolean;
}

function tsOf(d: string | null | undefined): number {
  if (!d) return Number.POSITIVE_INFINITY;
  const t = Date.parse(d);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export function planMerges(rows: EntityRow[], now = new Date()): MergePlan[] {
  const groups = new Map<string, EntityRow[]>();
  for (const r of rows) {
    const n = normName(r.name);
    if (!n) continue;
    const key = `${n}\0${mergeClass(r.entityType)}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const plans: MergePlan[] = [];
  const at = now.toISOString();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const wa = a.observations + a.relations;
      const wb = b.observations + b.relations;
      if (wa !== wb) return wb - wa;
      const ta = tsOf(a.createdAt);
      const tb = tsOf(b.createdAt);
      if (ta !== tb) return ta - tb;
      return a.id.localeCompare(b.id);
    });
    const keep = group[0]!;
    const dups = group.slice(1);
    const aliases: unknown[] = [...(keep.aliases || [])];
    for (const d of dups) {
      aliases.push({
        id: d.id,
        name: d.name,
        type: d.entityType,
        summary: d.summary,
        observations: d.observations,
        relations: d.relations,
        merged_at: at,
      });
      aliases.push(...(d.aliases || []));
    }
    let summary = keep.summary;
    let clearStale = false;
    if (!summary || keep.staleAt || isGone(summary)) {
      const better = dups.filter((d) => d.summary && !d.staleAt && !isGone(d.summary));
      if (better.length) {
        summary = better[0]!.summary;
        clearStale = true;
      } else if (!summary) {
        summary = dups.find((d) => d.summary)?.summary ?? null;
      }
      if (summary !== keep.summary && keep.summary) {
        aliases.push({ id: keep.id, name: keep.name, type: keep.entityType, summary: keep.summary, replaced_at: at });
      }
    }
    plans.push({ canonical: keep, duplicates: dups, summary, aliases, clearStale });
  }
  return plans;
}

export async function collapseParallelEdges(db: Db, userId: string): Promise<number> {
  const res = await db.execute(sql`
    WITH g AS (
      SELECT (array_agg(r.id ORDER BY r.created_at NULLS LAST, r.id))[1] AS keep,
             array_agg(r.id) AS ids,
             sum(coalesce(r.strength, 1.0)) AS strength
      FROM knowledge_relations r
      JOIN knowledge_entities e ON e.id = r.source_id
      WHERE e.user_id = ${userId}::uuid
      GROUP BY r.source_id, r.target_id, r.relation_type
      HAVING count(*) > 1
    ), bumped AS (
      UPDATE knowledge_relations r SET strength = g.strength FROM g WHERE r.id = g.keep RETURNING r.id
    )
    DELETE FROM knowledge_relations r USING g WHERE r.id = ANY(g.ids) AND r.id <> g.keep
  `);
  return (res as unknown as { count?: number }).count ?? 0;
}

export async function mergeDuplicateEntities(db: Db, userId: string, now = new Date()): Promise<Record<string, number>> {
  const stats = { merged_entities: 0, merged_groups: 0, cross_type: 0, merged_observations: 0, updated_relations: 0, collapsed_edges: 0 };
  const rawRows = (await db.execute(sql`
    WITH obs AS (
      SELECT o.entity_id AS eid, count(*)::int AS n
      FROM knowledge_observations o JOIN knowledge_entities e ON e.id = o.entity_id
      WHERE e.user_id = ${userId}::uuid
      GROUP BY o.entity_id
    ), ends AS (
      SELECT r.source_id AS eid FROM knowledge_relations r JOIN knowledge_entities e ON e.id = r.source_id WHERE e.user_id = ${userId}::uuid
      UNION ALL
      SELECT r.target_id AS eid FROM knowledge_relations r JOIN knowledge_entities e ON e.id = r.target_id WHERE e.user_id = ${userId}::uuid
    ), rels AS (
      SELECT eid, count(*)::int AS n FROM ends GROUP BY eid
    )
    SELECT e.id, e.name, e.entity_type, e.summary, e.created_at, e.aliases, e.stale_at, e.stale_reason,
           coalesce(obs.n, 0)::int AS observations, coalesce(rels.n, 0)::int AS relations
    FROM knowledge_entities e
    LEFT JOIN obs ON obs.eid = e.id
    LEFT JOIN rels ON rels.eid = e.id
    WHERE e.user_id = ${userId}::uuid
  `)) as unknown as Record<string, unknown>[];

  const rows: EntityRow[] = rawRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    entityType: String(r.entity_type),
    summary: r.summary ? String(r.summary) : null,
    createdAt: r.created_at ? String(r.created_at) : null,
    aliases: Array.isArray(r.aliases) ? r.aliases : [],
    staleAt: r.stale_at ? String(r.stale_at) : null,
    staleReason: r.stale_reason ? String(r.stale_reason) : null,
    observations: Number(r.observations ?? 0),
    relations: Number(r.relations ?? 0),
  }));

  const plans = planMerges(rows, now);
  if (plans.length) {
    const dups = plans.flatMap((p) => p.duplicates.map((d) => d.id));
    const canons = plans.flatMap((p) => p.duplicates.map(() => p.canonical.id));
    const kept = plans.map((p) => p.canonical.id);
    const dupsLit = `{${dups.join(",")}}`;
    const canonsLit = `{${canons.join(",")}}`;
    const keptLit = `{${kept.join(",")}}`;

    const moved = await db.execute(sql`
      UPDATE knowledge_observations o SET entity_id = m.canon
      FROM unnest(${dupsLit}::uuid[], ${canonsLit}::uuid[]) AS m(dup, canon)
      WHERE o.entity_id = m.dup
    `);
    stats.merged_observations = (moved as unknown as { count?: number }).count ?? 0;

    await db.execute(sql`
      DELETE FROM knowledge_observations o USING (
        SELECT id, row_number() OVER (PARTITION BY entity_id, content ORDER BY observed_at DESC NULLS LAST, id) AS rn
        FROM knowledge_observations WHERE entity_id = ANY(${keptLit}::uuid[])
      ) d WHERE o.id = d.id AND d.rn > 1
    `);

    const src = await db.execute(sql`
      UPDATE knowledge_relations r SET source_id = m.canon
      FROM unnest(${dupsLit}::uuid[], ${canonsLit}::uuid[]) AS m(dup, canon)
      WHERE r.source_id = m.dup
    `);
    const tgt = await db.execute(sql`
      UPDATE knowledge_relations r SET target_id = m.canon
      FROM unnest(${dupsLit}::uuid[], ${canonsLit}::uuid[]) AS m(dup, canon)
      WHERE r.target_id = m.dup
    `);
    stats.updated_relations = ((src as unknown as { count?: number }).count ?? 0) + ((tgt as unknown as { count?: number }).count ?? 0);

    await db.execute(sql`DELETE FROM knowledge_relations WHERE source_id = target_id AND source_id = ANY(${keptLit}::uuid[])`);
    await db.execute(sql`DELETE FROM knowledge_entities WHERE id = ANY(${dupsLit}::uuid[])`);

    for (const p of plans) {
      await db.execute(sql`
        UPDATE knowledge_entities
        SET aliases = ${JSON.stringify(p.aliases)}::jsonb,
            summary = ${p.summary},
            stale_at = CASE WHEN ${p.clearStale} THEN NULL ELSE stale_at END,
            stale_reason = CASE WHEN ${p.clearStale} THEN NULL ELSE stale_reason END,
            updated_at = updated_at
        WHERE id = ${p.canonical.id}::uuid
      `);
    }
    stats.merged_entities = dups.length;
    stats.merged_groups = plans.length;
    stats.cross_type = plans.filter((p) => p.duplicates.some((d) => d.entityType !== p.canonical.entityType)).length;
  }

  stats.collapsed_edges = await collapseParallelEdges(db, userId);
  return stats;
}

export async function markStaleEntities(db: Db, userId: string, now = new Date()): Promise<number> {
  const cands = await db
    .select({ id: knowledgeEntities.id, updatedAt: knowledgeEntities.updatedAt })
    .from(knowledgeEntities)
    .where(and(eq(knowledgeEntities.userId, userId), isNull(knowledgeEntities.staleAt), sql`${knowledgeEntities.summary} ~ ${GONE_PATTERN}`));
  if (!cands.length) return 0;

  const updated = new Map(cands.map((c) => [c.id, tsOf(c.updatedAt)]));
  const candIds = cands.map((c) => c.id);
  const obsRows = await db
    .select({
      entityId: knowledgeObservations.entityId,
      sourceDocumentId: knowledgeObservations.sourceDocumentId,
      content: knowledgeObservations.content,
      observedAt: knowledgeObservations.observedAt,
    })
    .from(knowledgeObservations)
    .where(sql`${knowledgeObservations.entityId} = ANY(${`{${candIds.join(",")}}`}::uuid[])`);

  const seen = new Map<string, typeof obsRows>();
  for (const r of obsRows) {
    const arr = seen.get(r.entityId) ?? [];
    arr.push(r);
    seen.set(r.entityId, arr);
  }

  let marked = 0;
  for (const [eid, obs] of seen.entries()) {
    const said = obs.filter((o) => GONE_RE.test(o.content || ""));
    let since = updated.get(eid) ?? null;
    const saidTimes = said.map((o) => tsOf(o.observedAt)).filter(Number.isFinite);
    if (saidTimes.length) since = Math.max(...saidTimes);
    const goneDocs = new Set(said.map((o) => o.sourceDocumentId).filter(Boolean));
    const later = new Set<string>();
    for (const o of obs) {
      const at = tsOf(o.observedAt);
      if (o.sourceDocumentId && !goneDocs.has(o.sourceDocumentId) && Number.isFinite(at) && since !== null && at > since + STALE_AFTER_MS && !GONE_RE.test(o.content || "")) {
        later.add(o.sourceDocumentId);
      }
    }
    if (later.size < STALE_MIN_DOCUMENTS) continue;
    await db
      .update(knowledgeEntities)
      .set({
        staleAt: now.toISOString(),
        staleReason: `描述说它已经不在了，但之后又有 ${later.size} 个对话提到它`,
        updatedAt: sql`${knowledgeEntities.updatedAt}`,
      })
      .where(eq(knowledgeEntities.id, eid));
    marked++;
  }
  return marked;
}
