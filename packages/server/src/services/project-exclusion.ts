// Project collection exclusions: preview, add, background purge, restore & ingest drop
// (server/server/services/project_exclusion.py).
import { and, desc, eq, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { Db } from "../db/client";
import {
  accessLogs,
  conversationMessages,
  correctionTopics,
  documentEmbeddings,
  documents,
  documentVersions,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  projects,
  skills,
  syncState,
  todos,
  userMemories,
  userProfiles,
  users,
} from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { joinProfileScopes, normScopeName, splitProfileScopes } from "./profile-scopes";

export const EXCLUDED = "excluded";
export const MAX_EXCLUSIONS = 200;
const BATCH = 50;

export class ProjectExcluded extends Error {
  constructor(readonly key: string) {
    super(`project excluded: ${key}`);
  }
}

export interface ExclusionEntry {
  key: string;
  name: string;
  added_at?: string;
  state?: string;
  updated_at?: string;
  purged?: Record<string, number>;
  error?: string | null;
  undo?: {
    memories?: string[];
    skills?: [string, string][];
    corrections?: [string, string][];
    todos?: [string, string][];
    profile?: Record<string, Record<string, string[]>>;
  };
}

export function exclusionKey(name: string): string {
  return normScopeName((name || "").trim()).slice(0, 120);
}

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export function matchesExclusion(key: string, projectName: string | null | undefined): boolean {
  if (!key || !projectName) return false;
  const name = normScopeName(projectName);
  return key.includes("*") ? globToRegex(key).test(name) : name === key;
}

export function matchAnyExclusion(keys: string[], projectName: string | null | undefined): string | null {
  for (const k of keys) if (matchesExclusion(k, projectName)) return k;
  return null;
}

export function entriesOf(user: Pick<UserRow, "collectSettings">): ExclusionEntry[] {
  const cs = (user.collectSettings ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(cs.excluded_projects) ? cs.excluded_projects : [];
  return structuredClone(raw) as ExclusionEntry[];
}

export function keysOf(user: Pick<UserRow, "collectSettings">): string[] {
  return entriesOf(user)
    .map((e) => e.key)
    .filter((k): k is string => Boolean(k));
}

export async function excludedKeys(db: Db, userId: string | null | undefined): Promise<string[]> {
  const uid = normalizeUuid(userId);
  if (!uid) return [];
  const [row] = await db.select({ collectSettings: users.collectSettings }).from(users).where(eq(users.id, uid)).limit(1);
  if (!row) return [];
  const cs = (row.collectSettings ?? {}) as Record<string, unknown>;
  const list = Array.isArray(cs.excluded_projects) ? cs.excluded_projects : [];
  return list
    .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).key : null))
    .filter((k): k is string => typeof k === "string" && k.length > 0);
}

function keyCondition(key: string): SQL {
  const normCol = sql`lower(regexp_replace(${projects.title}, '[\\s_-]+', '', 'g'))`;
  if (key.includes("*")) {
    const pat = key.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_").replaceAll("*", "%");
    return sql`${normCol} LIKE ${pat} ESCAPE '\\'`;
  }
  return sql`${normCol} = ${key}`;
}

async function ownMachines(db: Db, userId: string): Promise<string[]> {
  const rows = await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, userId));
  return rows.map((r) => r.id);
}

function docScope(user: Pick<UserRow, "role">, machineIds: string[]): SQL {
  const own = machineIds.length ? inArray(documents.machineId, machineIds) : sql`false`;
  return user.role === "owner" ? sql`(${own} OR ${documents.machineId} IS NULL)` : own;
}

async function projectDocIds(db: Db, user: Pick<UserRow, "id" | "role">, key: string): Promise<string[]> {
  const mids = await ownMachines(db, user.id);
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .innerJoin(projects, eq(projects.id, documents.projectId))
    .where(and(keyCondition(key), docScope(user, mids)));
  return rows.map((r) => r.id);
}

async function projectNames(db: Db, user: Pick<UserRow, "id" | "role">, key: string): Promise<string[]> {
  const mids = await ownMachines(db, user.id);
  const rows = await db
    .select({ title: projects.title })
    .from(projects)
    .innerJoin(documents, eq(documents.projectId, projects.id))
    .where(and(keyCondition(key), docScope(user, mids)))
    .groupBy(projects.title);
  const names = new Set(rows.map((r) => r.title).filter(Boolean));
  if (!key.includes("*")) names.add(key);
  return [...names].sort();
}

const PREFIX_RE = /^\s*【([^】]{1,80})】/;
const TREE_RE = /^\/project\/([^/]+)/;
const SCOPE_RE = /^项目[：:]\s*(.+)$/;

export function memoryProject(treePath: string | null, memKey: string | null, content: string | null, category: string): string | null {
  const tm = TREE_RE.exec(treePath ?? "");
  if (tm) return tm[1]!;
  if (category === "project" && (memKey ?? "").startsWith("proj_")) {
    const rest = (memKey ?? "").slice(5);
    const idx = rest.lastIndexOf("_");
    return idx >= 0 ? rest.slice(0, idx) : rest;
  }
  const pm = PREFIX_RE.exec(content ?? "");
  return pm ? pm[1]! : null;
}

async function memoriesFor(db: Db, userId: string, key: string) {
  const rows = await db
    .select()
    .from(userMemories)
    .where(and(eq(userMemories.userId, userId), eq(userMemories.status, "active"), eq(userMemories.isFolder, false)));
  return rows.filter((m) => matchesExclusion(key, memoryProject(m.treePath, m.key, m.content, m.category)));
}

async function skillsFor(db: Db, userId: string, key: string) {
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.userId, userId), isNotNull(skills.project), inArray(skills.status, ["draft", "published"])));
  return rows.filter((s) => matchesExclusion(key, s.project));
}

async function correctionsFor(db: Db, userId: string, key: string) {
  const rows = await db
    .select()
    .from(correctionTopics)
    .where(and(eq(correctionTopics.userId, userId), inArray(correctionTopics.status, ["pending", "accepted"]), like(correctionTopics.scope, "项目%")));
  return rows.filter((t) => {
    const m = SCOPE_RE.exec(t.scope ?? "");
    return Boolean(m && matchesExclusion(key, m[1]));
  });
}

async function todosFor(db: Db, userId: string, key: string, docIds: string[]) {
  const rows = await db
    .select()
    .from(todos)
    .where(and(eq(todos.userId, userId), eq(todos.status, "open"), sql`${todos.source} <> 'manual'`));
  const docSet = new Set(docIds);
  return rows.filter((t) => matchesExclusion(key, t.project) || (t.sourceDocId !== null && docSet.has(t.sourceDocId)));
}

async function activeProfiles(db: Db, userId: string) {
  const [published] = await db
    .select()
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.status, "published")))
    .orderBy(desc(userProfiles.version))
    .limit(1);
  const [draft] = await db
    .select()
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, userId), eq(userProfiles.status, "draft")))
    .limit(1);
  return [published, draft].filter((p): p is NonNullable<typeof p> => Boolean(p));
}

export async function previewExclusion(db: Db, user: Pick<UserRow, "id" | "role">, name: string) {
  const key = exclusionKey(name);
  if (!key || key === "*") {
    return { key, names: [], documents: 0, messages: 0, memories: 0, skills: 0, corrections: 0, todos: 0, profile_rules: 0 };
  }
  const docIds = await projectDocIds(db, user, key);
  let messages = 0;
  for (let i = 0; i < docIds.length; i += 500) {
    const batch = docIds.slice(i, i + 500);
    const [row] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(conversationMessages)
      .where(and(inArray(conversationMessages.documentId, batch), inArray(conversationMessages.role, ["user", "assistant"])));
    messages += Number(row?.c ?? 0);
  }
  let profileRules = 0;
  for (const p of await activeProfiles(db, user.id)) {
    if (p.status === "published") {
      const scopes = splitProfileScopes(p.content);
      for (const [pname, lines] of Object.entries(scopes.projects)) {
        if (matchesExclusion(key, pname)) profileRules += lines.length;
      }
    }
  }
  const [names, mems, sks, corrs, tds] = await Promise.all([
    projectNames(db, user, key),
    memoriesFor(db, user.id, key),
    skillsFor(db, user.id, key),
    correctionsFor(db, user.id, key),
    todosFor(db, user.id, key, docIds),
  ]);
  return {
    key,
    names,
    documents: docIds.length,
    messages,
    memories: mems.length,
    skills: sks.length,
    corrections: corrs.length,
    todos: tds.length,
    profile_rules: profileRules,
  };
}

const nowIso = () => new Date().toISOString().replace("Z", "+00:00");

export async function addExclusion(db: Db, userId: string, name: string): Promise<ExclusionEntry> {
  const key = exclusionKey(name);
  if (!key || key.replaceAll("*", "") === "") {
    throw new Error("项目名不能为空，也不能只写 *");
  }
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT collect_settings FROM users WHERE id = ${userId}::uuid FOR UPDATE`)) as unknown as {
      collect_settings: Record<string, unknown> | null;
    }[];
    const cs = structuredClone(rows[0]?.collect_settings ?? {});
    const items = (Array.isArray(cs.excluded_projects) ? cs.excluded_projects : []) as ExclusionEntry[];
    const found = items.find((e) => e.key === key);
    if (found) return found;
    if (items.length >= MAX_EXCLUSIONS) throw new Error(`最多 ${MAX_EXCLUSIONS} 条`);
    const entry: ExclusionEntry = {
      key,
      name: name.trim().slice(0, 120),
      added_at: nowIso(),
      state: "purging",
      updated_at: nowIso(),
    };
    const next = { ...cs, excluded_projects: [...items, entry] };
    await tx.update(users).set({ collectSettings: next }).where(eq(users.id, userId));
    return entry;
  });
}

export async function updateExclusionEntry(
  db: Db,
  userId: string,
  key: string,
  changes: Partial<ExclusionEntry>,
): Promise<ExclusionEntry | null> {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT collect_settings FROM users WHERE id = ${userId}::uuid FOR UPDATE`)) as unknown as {
      collect_settings: Record<string, unknown> | null;
    }[];
    const cs = structuredClone(rows[0]?.collect_settings ?? {});
    const items = (Array.isArray(cs.excluded_projects) ? cs.excluded_projects : []) as ExclusionEntry[];
    let target: ExclusionEntry | null = null;
    for (const e of items) {
      if (e.key === key) {
        Object.assign(e, changes, { updated_at: nowIso() });
        target = e;
        break;
      }
    }
    if (target) {
      await tx.update(users).set({ collectSettings: { ...cs, excluded_projects: items } }).where(eq(users.id, userId));
    }
    return target;
  });
}

export async function invalidateExclusionCaches(redis: Redis | null, userId: string): Promise<void> {
  const prefixes = [
    "projects:list:",
    "projects:list:v2:",
    "project:conv:",
    "project:conv:v3:",
    "project:timeline:",
    "profile_content:",
    "profile_injection:",
    "skills_injection:",
    "memory:resonance:",
    "learning:check:",
  ];
  for (const p of prefixes) await cacheDeletePrefix(redis, `${p}${userId}`);
}

export async function purgeExclusion(
  db: Db,
  redis: Redis | null,
  user: Pick<UserRow, "id" | "role">,
  key: string,
): Promise<Record<string, number>> {
  const docIds = await projectDocIds(db, user, key);
  const undo: NonNullable<ExclusionEntry["undo"]> = { memories: [], skills: [], corrections: [], todos: [], profile: {} };
  const reason = `项目已设为不采集（${key}）`;

  const [mems, sks, corrs, tds, profs] = await Promise.all([
    memoriesFor(db, user.id, key),
    skillsFor(db, user.id, key),
    correctionsFor(db, user.id, key),
    todosFor(db, user.id, key, docIds),
    activeProfiles(db, user.id),
  ]);

  let profileRules = 0;
  await db.transaction(async (tx) => {
    if (mems.length) {
      const ids = mems.map((m) => m.id);
      undo.memories = ids;
      await tx.update(userMemories).set({ status: EXCLUDED, statusReason: reason }).where(inArray(userMemories.id, ids));
    }
    for (const s of sks) {
      undo.skills!.push([s.id, s.status]);
      await tx.update(skills).set({ status: "retired" }).where(eq(skills.id, s.id));
    }
    for (const t of corrs) {
      undo.corrections!.push([t.id, t.status]);
      await tx.update(correctionTopics).set({ status: "dismissed" }).where(eq(correctionTopics.id, t.id));
    }
    for (const t of tds) {
      undo.todos!.push([t.id, t.status]);
      await tx.update(todos).set({ status: "dropped" }).where(eq(todos.id, t.id));
    }
    for (const p of profs) {
      const scopes = splitProfileScopes(p.content);
      const gone: Record<string, string[]> = {};
      for (const [pname, lines] of Object.entries(scopes.projects)) {
        if (matchesExclusion(key, pname)) {
          gone[pname] = lines;
          delete scopes.projects[pname];
        }
      }
      if (Object.keys(gone).length) {
        await tx.update(userProfiles).set({ content: joinProfileScopes(scopes) }).where(eq(userProfiles.id, p.id));
        undo.profile![p.status] = gone;
        if (p.status === "published") {
          profileRules = Object.values(gone).reduce((a, b) => a + b.length, 0);
        }
      }
    }
  });

  const entityIds = new Set<string>();
  for (let i = 0; i < docIds.length; i += BATCH) {
    const batch = docIds.slice(i, i + BATCH);
    await db.transaction(async (tx) => {
      const files = await tx
        .select({ machineId: documents.machineId, toolId: documents.toolId, relativePath: documents.relativePath })
        .from(documents)
        .where(inArray(documents.id, batch));
      for (const f of files) {
        await tx
          .update(syncState)
          .set({ excludedProject: key })
          .where(
            and(
              eq(syncState.toolId, f.toolId),
              eq(syncState.relativePath, f.relativePath),
              f.machineId ? eq(syncState.machineId, f.machineId) : isNull(syncState.machineId),
            ),
          );
      }
      const obs = await tx
        .select({ entityId: knowledgeObservations.entityId })
        .from(knowledgeObservations)
        .where(inArray(knowledgeObservations.sourceDocumentId, batch));
      for (const o of obs) if (o.entityId) entityIds.add(o.entityId);
      await tx.update(accessLogs).set({ documentId: null }).where(inArray(accessLogs.documentId, batch));
      await tx.delete(knowledgeObservations).where(inArray(knowledgeObservations.sourceDocumentId, batch));
      await tx.delete(conversationMessages).where(inArray(conversationMessages.documentId, batch));
      await tx.delete(documentVersions).where(inArray(documentVersions.documentId, batch));
      await tx.delete(documentEmbeddings).where(inArray(documentEmbeddings.documentId, batch));
      await tx.delete(documents).where(inArray(documents.id, batch));
    });
  }

  await db.transaction(async (tx) => {
    if (entityIds.size) {
      const ids = [...entityIds];
      const still = new Set(
        (await tx.select({ entityId: knowledgeObservations.entityId }).from(knowledgeObservations).where(inArray(knowledgeObservations.entityId, ids))).map(
          (r) => r.entityId,
        ),
      );
      const orphans = ids.filter((id) => !still.has(id));
      if (orphans.length) {
        await tx
          .delete(knowledgeRelations)
          .where(or(inArray(knowledgeRelations.sourceId, orphans), inArray(knowledgeRelations.targetId, orphans)));
        await tx.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, orphans));
      }
    }
    await tx.delete(projects).where(
      and(
        keyCondition(key),
        sql`${projects.id} NOT IN (SELECT project_id FROM documents WHERE project_id IS NOT NULL)`,
      ),
    );
  });

  const counts: Record<string, number> = {
    documents: docIds.length,
    memories: undo.memories!.length,
    skills: undo.skills!.length,
    corrections: undo.corrections!.length,
    todos: undo.todos!.length,
    profile_rules: profileRules,
  };

  await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT collect_settings FROM users WHERE id = ${user.id}::uuid FOR UPDATE`)) as unknown as {
      collect_settings: Record<string, unknown> | null;
    }[];
    const cs = structuredClone(rows[0]?.collect_settings ?? {});
    const items = (Array.isArray(cs.excluded_projects) ? cs.excluded_projects : []) as ExclusionEntry[];
    for (const e of items) {
      if (e.key === key) {
        const prev = e.undo ?? {};
        const merged: NonNullable<ExclusionEntry["undo"]> = {
          memories: [...(prev.memories ?? []), ...undo.memories!],
          skills: [...(prev.skills ?? []), ...undo.skills!],
          corrections: [...(prev.corrections ?? []), ...undo.corrections!],
          todos: [...(prev.todos ?? []), ...undo.todos!],
          profile: { ...(prev.profile ?? {}), ...(undo.profile ?? {}) },
        };
        const done = e.purged ?? {};
        const nextPurged: Record<string, number> = {};
        for (const [k, v] of Object.entries(counts)) nextPurged[k] = (done[k] ?? 0) + v;
        Object.assign(e, { state: "done", updated_at: nowIso(), undo: merged, purged: nextPurged });
      }
    }
    await tx.update(users).set({ collectSettings: { ...cs, excluded_projects: items } }).where(eq(users.id, user.id));
  });

  await invalidateExclusionCaches(redis, user.id);
  return counts;
}

export async function restoreExclusion(db: Db, redis: Redis | null, user: Pick<UserRow, "id">, key: string): Promise<ExclusionEntry | null> {
  const entry = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT collect_settings FROM users WHERE id = ${user.id}::uuid FOR UPDATE`)) as unknown as {
      collect_settings: Record<string, unknown> | null;
    }[];
    const cs = structuredClone(rows[0]?.collect_settings ?? {});
    const items = (Array.isArray(cs.excluded_projects) ? cs.excluded_projects : []) as ExclusionEntry[];
    const found = items.find((e) => e.key === key) ?? null;
    if (!found) return null;
    const remaining = items.filter((e) => e.key !== key);
    await tx.update(users).set({ collectSettings: { ...cs, excluded_projects: remaining } }).where(eq(users.id, user.id));

    const undo = found.undo ?? {};
    const memIds = (undo.memories ?? []).map((v) => normalizeUuid(v)).filter((x): x is string => Boolean(x));
    if (memIds.length) {
      await tx
        .update(userMemories)
        .set({ status: "active", statusReason: null })
        .where(and(inArray(userMemories.id, memIds), eq(userMemories.status, EXCLUDED)));
    }
    for (const [id, prev] of undo.skills ?? []) {
      const uid = normalizeUuid(id);
      if (uid) await tx.update(skills).set({ status: prev }).where(and(eq(skills.id, uid), eq(skills.status, "retired")));
    }
    for (const [id, prev] of undo.corrections ?? []) {
      const uid = normalizeUuid(id);
      if (uid) await tx.update(correctionTopics).set({ status: prev }).where(and(eq(correctionTopics.id, uid), eq(correctionTopics.status, "dismissed")));
    }
    for (const [id, prev] of undo.todos ?? []) {
      const uid = normalizeUuid(id);
      if (uid) await tx.update(todos).set({ status: prev }).where(and(eq(todos.id, uid), eq(todos.status, "dropped")));
    }
    const profs = await activeProfiles(tx as unknown as Db, user.id);
    for (const p of profs) {
      const gone = undo.profile?.[p.status];
      if (gone && Object.keys(gone).length) {
        const scopes = splitProfileScopes(p.content);
        for (const [pname, lines] of Object.entries(gone)) {
          if (!scopes.projects[pname]) scopes.projects[pname] = lines;
        }
        await tx.update(userProfiles).set({ content: joinProfileScopes(scopes) }).where(eq(userProfiles.id, p.id));
      }
    }
    await tx
      .delete(syncState)
      .where(and(eq(syncState.excludedProject, key), sql`${syncState.machineId} IN (SELECT id FROM machines WHERE user_id = ${user.id}::uuid)`));
    return found;
  });
  if (entry) await invalidateExclusionCaches(redis, user.id);
  return entry;
}

export async function markFileExcluded(
  db: Db,
  machineId: string | null | undefined,
  toolId: string,
  relativePath: string,
  key: string | null,
): Promise<void> {
  const mid = normalizeUuid(machineId);
  await db
    .update(syncState)
    .set({ excludedProject: key })
    .where(and(eq(syncState.toolId, toolId), eq(syncState.relativePath, relativePath), mid ? eq(syncState.machineId, mid) : isNull(syncState.machineId)));
}

export async function updateSyncState(
  db: Db,
  toolId: string,
  relativePath: string,
  contentHash: string,
  offset: number,
  machineId: string | null | undefined,
  endOffset: number | null = null,
): Promise<void> {
  const mid = normalizeUuid(machineId);
  const [existing] = await db
    .select()
    .from(syncState)
    .where(and(eq(syncState.toolId, toolId), eq(syncState.relativePath, relativePath), mid ? eq(syncState.machineId, mid) : isNull(syncState.machineId)))
    .limit(1);
  const now = new Date().toISOString();
  if (!existing) {
    await db.insert(syncState).values({
      machineId: mid,
      toolId,
      relativePath,
      lastHash: contentHash,
      lastOffset: offset,
      lastEndOffset: endOffset,
      lastSyncedAt: now,
    });
  } else {
    await db
      .update(syncState)
      .set({ lastHash: contentHash, lastOffset: offset, lastEndOffset: endOffset, lastSyncedAt: now })
      .where(eq(syncState.id, existing.id));
  }
}

export async function dropExcluded(
  db: Db,
  userId: string | null | undefined,
  machineId: string | null | undefined,
  toolId: string,
  relativePath: string,
  projectName: string | null | undefined,
  contentHash: string,
  offset: number,
  endOffset: number | null,
): Promise<void> {
  const key = matchAnyExclusion(await excludedKeys(db, userId), projectName);
  if (key === null) return;
  await updateSyncState(db, toolId, relativePath, contentHash, offset, machineId, endOffset);
  await markFileExcluded(db, machineId, toolId, relativePath, key);
  throw new ProjectExcluded(key);
}

export async function droppedSlice(
  db: Db,
  userId: string,
  machineId: string,
  toolId: string,
  relativePath: string,
  contentHash: string,
  offset: number,
  endOffset: number | null,
): Promise<boolean> {
  const mid = normalizeUuid(machineId);
  if (!mid) return false;
  const [row] = await db
    .select({ excludedProject: syncState.excludedProject })
    .from(syncState)
    .where(and(eq(syncState.machineId, mid), eq(syncState.toolId, toolId), eq(syncState.relativePath, relativePath)))
    .limit(1);
  const key = row?.excludedProject;
  if (!key) return false;
  const keys = await excludedKeys(db, userId);
  if (!keys.includes(key)) {
    await markFileExcluded(db, machineId, toolId, relativePath, null);
    return false;
  }
  await updateSyncState(db, toolId, relativePath, contentHash, offset, machineId, endOffset);
  return true;
}
