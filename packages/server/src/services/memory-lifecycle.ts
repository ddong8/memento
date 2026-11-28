// Memory lifecycle: dormancy, deduplication & contradiction reconciliation (server/server/services/memory_lifecycle.py).
import { randomUUID } from "node:crypto";

import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { userMemories, userProfiles, users } from "../db/pulled/schema";
import { callPlainChat } from "./ai-provider";
import { safeJsonLoads } from "./dreaming-core";
import { embedMemories, nearestMemories, type UserMemoryRow } from "./memory-vectors";
import { getDraftProfile, getPublishedProfile, sanitizeProfileContent } from "./profile-read";

export const ACTIVE = "active";
export const DORMANT = "dormant";
export const SUPERSEDED = "superseded";
export const DORMANT_AFTER_DAYS = 60;
export const PITFALL_UNUSED_AFTER_DAYS = 30;
export const SCENARIO_UNUSED_AFTER_DAYS = 30;
export const ALWAYS_ON = ["rule", "rules", "preference"] as const;
const ALWAYS_ON_SET = new Set<string>(ALWAYS_ON);
const NEW_PER_CALL = 30;
const EXISTING_PER_CALL = 80;

function touchedMs(mem: UserMemoryRow): number {
  const raw = mem.updatedAt || mem.createdAt;
  if (!raw) return 0;
  const s = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

export async function sweepDormant(db: Db, user: Pick<UserRow, "id">, nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - DORMANT_AFTER_DAYS * 86400_000).toISOString();
  const pitfallCutoffIso = new Date(nowMs - PITFALL_UNUSED_AFTER_DAYS * 86400_000).toISOString();

  const res1 = (await db.execute(sql`
    UPDATE user_memories
    SET status = ${DORMANT}, status_reason = ${`${DORMANT_AFTER_DAYS} 天没有被用到，也没有更新`}
    WHERE user_id = ${user.id}::uuid
      AND status = ${ACTIVE}
      AND is_folder IS FALSE
      AND source != 'manual'
      AND category NOT IN ('rule', 'rules', 'preference')
      AND greatest(coalesce(last_recalled_at, created_at), coalesce(updated_at, created_at)) < ${cutoffIso}::timestamptz
    RETURNING id
  `)) as unknown as { id: string }[];

  const res2 = (await db.execute(sql`
    UPDATE user_memories
    SET status = ${DORMANT}, status_reason = ${`记下 ${PITFALL_UNUSED_AFTER_DAYS} 天没有被用到，也没有再遇到`}
    WHERE user_id = ${user.id}::uuid
      AND status = ${ACTIVE}
      AND is_folder IS FALSE
      AND source != 'manual'
      AND category = 'pitfall'
      AND coalesce(recall_count, 0) = 0
      AND greatest(coalesce(last_recalled_at, created_at), coalesce(updated_at, created_at)) < ${pitfallCutoffIso}::timestamptz
    RETURNING id
  `)) as unknown as { id: string }[];

  const scenarioCutoffIso = new Date(nowMs - SCENARIO_UNUSED_AFTER_DAYS * 86400_000).toISOString();
  const res3 = (await db.execute(sql`
    UPDATE user_memories
    SET status = ${DORMANT}, status_reason = ${`动态场景超过 ${SCENARIO_UNUSED_AFTER_DAYS} 天从未被命中`}
    WHERE user_id = ${user.id}::uuid
      AND status = ${ACTIVE}
      AND is_folder IS FALSE
      AND source != 'manual'
      AND category IN ('resonance_scenario', 'scenario', 'custom_scenario')
      AND coalesce(recall_count, 0) = 0
      AND greatest(coalesce(last_recalled_at, created_at), coalesce(updated_at, created_at)) < ${scenarioCutoffIso}::timestamptz
    RETURNING id
  `)) as unknown as { id: string }[];

  return res1.length + res2.length + res3.length;
}

export function groupKey(mem: Pick<UserMemoryRow, "category" | "treePath">): string {
  const cat = (mem.category || "general").toLowerCase();
  if (ALWAYS_ON_SET.has(cat)) return "rules";
  const path = (mem.treePath || "").replace(/^\/+|\/+$/g, "").split("/");
  if ((cat === "project" || cat === "pitfall") && path.length >= 2 && path[0] === cat) {
    return `${cat}:${path[1]!.toLowerCase()}`;
  }
  return cat;
}

const RECONCILE_PROMPT = (items: string) => `下面是同一类长期记忆。N 开头的是最近新增或改过的，E 开头的是早就有的。请找出以下两种情况，每一组至少要涉及一条 N：

1. duplicate：两条（或多条）说的是同一件事，只是措辞不同。保留信息最完整的一条。
2. conflict：新的一条推翻了旧的（偏好变了、规则改了、做法换了、结论被新证据否定）。保留新的那条。

只报确定的情况。说的是相关但不同的两件事、或只是互相补充的，不要报。

${items}

只输出 JSON：{"actions": [{"type": "duplicate|conflict", "keep": "N1", "drop": ["E3"], "reason": "一句话说明"}]}`;

function renderItems(newList: UserMemoryRow[], oldList: UserMemoryRow[]): { text: string; refs: Map<string, UserMemoryRow> } {
  const refs = new Map<string, UserMemoryRow>();
  const lines: string[] = [];
  for (const [prefix, group] of [
    ["N", newList],
    ["E", oldList],
  ] as const) {
    group.forEach((mem, idx) => {
      const ref = `${prefix}${idx + 1}`;
      refs.set(ref, mem);
      const origin = mem.source === "manual" ? "用户手写/确认" : "自动总结";
      const when = new Date(touchedMs(mem) || Date.now()).toISOString().slice(0, 10);
      lines.push(`${ref} [${mem.category}·${origin}·${when}] ${(mem.content || "").slice(0, 300)}`);
    });
  }
  return { text: lines.join("\n"), refs };
}

export function settle(action: string, keep: UserMemoryRow, drop: UserMemoryRow): [UserMemoryRow, UserMemoryRow] {
  const keepManual = keep.source === "manual";
  const dropManual = drop.source === "manual";
  if (dropManual && !keepManual) return [drop, keep];
  if (action === "conflict" && keepManual && dropManual && touchedMs(drop) > touchedMs(keep)) return [drop, keep];
  return [keep, drop];
}

function oneLine(text: string | null | undefined): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function replaceProfileLine(content: string, oldLine: string, newLine: string | null): string {
  const oldBullet = `- ${oneLine(oldLine)}`;
  const lines = (content || "").split("\n");
  const at = lines.findIndex((l) => l.trim() === oldBullet);
  if (at === -1) return content;
  const newBullet = newLine ? `- ${oneLine(newLine)}` : null;
  if (newBullet === null || lines.some((l) => l.trim() === newBullet)) {
    lines.splice(at, 1);
  } else {
    lines[at] = newBullet;
  }
  return lines.join("\n");
}

async function syncProfile(db: Db, user: Pick<UserRow, "id">, pairs: [UserMemoryRow, UserMemoryRow][]): Promise<boolean> {
  const approved = pairs.filter(([keep]) => keep.source === "manual");
  if (!approved.length) return false;
  const published = await getPublishedProfile(db, user);
  const draft = await getDraftProfile(db, user);
  let changed = false;

  if (published) {
    let content = published.content;
    for (const [keep, drop] of approved) content = replaceProfileLine(content, drop.content, keep.content);
    if (content !== published.content) {
      const [maxRow] = await db
        .select({ v: sql<number>`coalesce(max(${userProfiles.version}), 0)` })
        .from(userProfiles)
        .where(eq(userProfiles.userId, user.id));
      await db.insert(userProfiles).values({
        id: randomUUID(),
        userId: user.id,
        status: "published",
        version: Number(maxRow?.v ?? 0) + 1,
        content: sanitizeProfileContent(content),
        stats: { source: "reconcile" },
        publishedAt: new Date().toISOString(),
      });
      changed = true;
    }
  }
  if (draft) {
    let content = draft.content;
    for (const [keep, drop] of approved) content = replaceProfileLine(content, drop.content, keep.content);
    if (content !== draft.content) {
      await db.update(userProfiles).set({ content, updatedAt: new Date().toISOString() }).where(eq(userProfiles.id, draft.id));
    }
  }
  return changed;
}

function relatedCategories(mem: UserMemoryRow): readonly string[] {
  const cat = (mem.category || "general").toLowerCase();
  return ALWAYS_ON_SET.has(cat) ? ALWAYS_ON : [cat];
}

async function closestFirst(
  db: Db,
  user: Pick<UserRow, "id">,
  newList: UserMemoryRow[],
  others: UserMemoryRow[],
): Promise<UserMemoryRow[]> {
  const newIds = new Set(newList.map((m) => m.id));
  const seen = new Set(newIds);
  const picked: UserMemoryRow[] = [];
  for (const mem of newList) {
    const emb = Array.isArray(mem.embedding) ? mem.embedding : null;
    if (!emb?.length) continue;
    const nears = await nearestMemories(db, user.id, emb, { categories: relatedCategories(mem), exclude: [...newIds] });
    for (const near of nears) {
      if (!seen.has(near.id)) {
        seen.add(near.id);
        picked.push(near);
      }
    }
  }
  for (const m of others) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      picked.push(m);
    }
  }
  return picked.slice(0, EXISTING_PER_CALL);
}

export async function reconcileGroup(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  newList: UserMemoryRow[],
  oldList: UserMemoryRow[],
): Promise<[UserMemoryRow, UserMemoryRow, string][]> {
  if (newList.length + oldList.length < 2) return [];
  const { text, refs } = renderItems(newList, oldList);
  const raw = await callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "You deduplicate a user's long-term memories. Respond only with valid JSON." },
      { role: "user", content: RECONCILE_PROMPT(text) },
    ],
    { maxTokens: 1500, background: true, user },
  );
  if (!raw) throw new Error("memory reconcile got no answer from any AI provider");
  const actions = Array.isArray(safeJsonLoads(raw).actions) ? (safeJsonLoads(raw).actions as Record<string, unknown>[]) : [];

  const newSet = new Set(newList.map((m) => m.id));
  const changes: [UserMemoryRow, UserMemoryRow, string][] = [];
  const gone = new Set<string>();
  const nowIso = new Date().toISOString();

  for (const action of actions) {
    if (!action || typeof action !== "object") continue;
    const kind = String(action.type ?? "");
    const keep = refs.get(String(action.keep ?? ""));
    const drops = Array.isArray(action.drop) ? action.drop : [];
    if ((kind !== "duplicate" && kind !== "conflict") || !keep) continue;
    for (const ref of drops) {
      const drop = refs.get(String(ref ?? ""));
      if (!drop || drop.id === keep.id) continue;
      const [k, d] = settle(kind, keep, drop);
      if (gone.has(k.id) || gone.has(d.id) || k.status !== ACTIVE || d.status !== ACTIVE) continue;
      if (!newSet.has(k.id) && !newSet.has(d.id)) continue;
      const reason = `${kind === "duplicate" ? "和另一条重复" : "被新的说法取代"}：${String(action.reason ?? "").slice(0, 200)}`;
      d.status = SUPERSEDED;
      d.supersededBy = k.id;
      d.statusReason = reason;
      await db
        .update(userMemories)
        .set({ status: SUPERSEDED, supersededBy: k.id, statusReason: reason, updatedAt: nowIso })
        .where(eq(userMemories.id, d.id));
      gone.add(d.id);
      changes.push([k, d, reason]);
    }
  }
  return changes;
}

async function activeMemories(db: Db, user: Pick<UserRow, "id">): Promise<UserMemoryRow[]> {
  return db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, ACTIVE), eq(userMemories.isFolder, false)));
}

export async function reconcile(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  sinceMs: number | null,
): Promise<{ groups: number; superseded: number; profile_updated: boolean }> {
  const memories = await activeMemories(db, user);
  const groups = new Map<string, UserMemoryRow[]>();
  for (const m of memories) {
    const k = groupKey(m);
    const arr = groups.get(k) ?? [];
    arr.push(m);
    groups.set(k, arr);
  }

  let checked = 0;
  let superseded = 0;
  const pairs: [UserMemoryRow, UserMemoryRow][] = [];
  const batches: [UserMemoryRow[], UserMemoryRow[]][] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => touchedMs(b) - touchedMs(a));
    const newList = members.filter((m) => sinceMs === null || touchedMs(m) > sinceMs).slice(0, NEW_PER_CALL);
    if (newList.length) {
      const ids = new Set(newList.map((m) => m.id));
      batches.push([newList, members.filter((m) => !ids.has(m.id))]);
    }
  }

  try {
    await embedMemories(db, settings, redis, batches.flatMap(([n]) => n));
  } catch {
    /* proceed without vectors */
  }

  for (const [newList, others] of batches) {
    try {
      const oldList = await closestFirst(db, user, newList, others);
      const changes = await reconcileGroup(db, settings, redis, user, newList, oldList);
      checked++;
      superseded += changes.length;
      for (const [k, d] of changes) pairs.push([k, d]);
    } catch (e) {
      console.warn("[memory-lifecycle] reconcile group failed:", (e as Error).message);
    }
  }

  const profileUpdated = await syncProfile(db, user, pairs);
  return { groups: checked, superseded, profile_updated: profileUpdated };
}

export async function reconcileOne(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
  memory: UserMemoryRow,
): Promise<[UserMemoryRow, UserMemoryRow, string][]> {
  const key = groupKey(memory);
  try {
    await embedMemories(db, settings, redis, [memory]);
  } catch {
    /* ignore */
  }
  const all = await activeMemories(db, user);
  const others = all.filter((m) => m.id !== memory.id && groupKey(m) === key).sort((a, b) => touchedMs(b) - touchedMs(a));
  const oldList = await closestFirst(db, user, [memory], others);
  const changes = await reconcileGroup(db, settings, redis, user, [memory], oldList);
  await syncProfile(db, user, changes.map(([k, d]) => [k, d]));
  return changes;
}

export async function reconcileInBackground(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  userId: string,
  memoryId: string,
): Promise<void> {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const [memory] = await db.select().from(userMemories).where(eq(userMemories.id, memoryId)).limit(1);
    if (!user || !memory || memory.status !== ACTIVE) return;
    await reconcileOne(db, settings, redis, user, memory);
  } catch (e) {
    console.warn("[memory-lifecycle] reconcileInBackground failed:", (e as Error).message);
  }
}

export async function lifecycleCounts(db: Db, user: Pick<UserRow, "id">, days = 7) {
  const rows = await db
    .select({ status: userMemories.status, n: count() })
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.isFolder, false)))
    .groupBy(userMemories.status);
  const counts = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

  const [[recentRow], [recalledRow], [attrRow]] = await Promise.all([
    db
      .select({ n: count() })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, SUPERSEDED), gte(userMemories.updatedAt, sinceIso))),
    db
      .select({ n: count() })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), gte(userMemories.lastRecalledAt, sinceIso))),
    db
      .select({
        pos: sql<number>`coalesce(sum(${userMemories.feedbackPos}), 0)`.mapWith(Number),
        neg: sql<number>`coalesce(sum(${userMemories.feedbackNeg}), 0)`.mapWith(Number),
        scenarioActive: sql<number>`count(*) filter (where ${userMemories.status} = 'active' and ${userMemories.category} = 'resonance_scenario')`.mapWith(Number),
        scenarioRecalled: sql<number>`count(*) filter (where ${userMemories.status} = 'active' and ${userMemories.category} = 'resonance_scenario' and coalesce(${userMemories.recallCount}, 0) > 0)`.mapWith(Number),
      })
      .from(userMemories)
      .where(and(eq(userMemories.userId, user.id), eq(userMemories.isFolder, false))),
  ]);

  return {
    active: counts.get(ACTIVE) ?? 0,
    dormant: counts.get(DORMANT) ?? 0,
    superseded: counts.get(SUPERSEDED) ?? 0,
    superseded_recent: Number(recentRow?.n ?? 0),
    recalled_recent: Number(recalledRow?.n ?? 0),
    attribution: {
      feedback_pos: Number(attrRow?.pos ?? 0),
      feedback_neg: Number(attrRow?.neg ?? 0),
      scenario_active: Number(attrRow?.scenarioActive ?? 0),
      scenario_recalled: Number(attrRow?.scenarioRecalled ?? 0),
    },
  };
}
