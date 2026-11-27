// Where a project lives: which devices, and the folder on each (server/server/services/project_placement.py).
import { and, count, desc, eq, inArray, max, sql, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheGet, cacheSet } from "../cache";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { documents, machines, projects } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import type { MachineRow } from "./device-merge";
import { cleanSourcePath, isInvalidProjectName, isJunkProject, prettifyProjectName } from "./ingest-service";
import { seesAll } from "./visibility";

export interface Placement {
  machineId: string | null;
  path: string | null;
  documents: number;
  lastActive: number; // ms since epoch (0 when absent)
  lastActiveRaw: string | null;
}

export interface DeviceRef {
  deviceId: string;
  name: string;
}

export interface DiscoveredProject {
  machineId: string | null;
  toolId: string;
  name: string;
  path: string | null;
}

function toMs(value: string | Date | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  const iso = pgToIso(value) ?? value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function leafName(name: string): string {
  return name
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop()!
    .replace(/^[-"'` ]+|[-"'` ]+$/g, "")
    .toLowerCase()
    .replaceAll("_", "-");
}

export function pickProjectPath(placements: Iterable<Placement>, slug: string, title: string | null | undefined): string | null {
  const pLeaf = leafName(slug);
  const pTitle = (title || "").replace(/^[-"'` ]+|[-"'` ]+$/g, "").toLowerCase().replaceAll("_", "-");
  let best: [number, number, number] | null = null;
  let bestPath: string | null = null;
  for (const pl of placements) {
    const raw = (pl.path || "").trim();
    if (raw.length <= 3 || /^\d+$/.test(raw)) continue;
    const path = cleanSourcePath(raw);
    if (!path || isJunkProject(null, path)) continue;
    const lf = leafName(path);
    let rank = 0;
    if (lf === pLeaf || lf === pTitle) rank = 2;
    else if (pLeaf && lf.includes(pLeaf)) rank = 1;
    else continue;
    const key: [number, number, number] = [rank, pl.lastActive, pl.documents];
    if (
      !best ||
      key[0] > best[0] ||
      (key[0] === best[0] && (key[1] > best[1] || (key[1] === best[1] && key[2] > best[2])))
    ) {
      best = key;
      bestPath = path;
    }
  }
  return bestPath;
}

export async function deviceIndex(db: Db, settings: Settings, user: UserRow): Promise<Map<string, DeviceRef>> {
  const rows = seesAll(user, settings)
    ? await db.select().from(machines)
    : await db.select().from(machines).where(eq(machines.userId, user.id));
  const byId = new Map(rows.map((m) => [m.id, m]));

  const live = (m: MachineRow): MachineRow => {
    const seen = new Set<string>();
    let cur = m;
    while (cur.mergedInto && byId.has(cur.mergedInto) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.mergedInto)!;
    }
    return cur;
  };

  const shown = new Map<string, MachineRow>();
  const active = rows.filter((m) => !m.mergedInto).sort((a, b) => toMs(b.lastHeartbeat) - toMs(a.lastHeartbeat));
  for (const m of active) {
    if (!shown.has(m.name)) shown.set(m.name, m);
  }

  const index = new Map<string, DeviceRef>();
  for (const m of rows) {
    const root = live(m);
    const target = shown.get(root.name) ?? root;
    if (target.collectorTokenHash) {
      index.set(m.id, { deviceId: target.collectorTokenHash, name: target.name });
    }
  }
  return index;
}

export async function projectPlacements(
  db: Db,
  projectIds: string[],
  scope?: SQL,
): Promise<Map<string, Placement[]>> {
  const out = new Map<string, Placement[]>();
  if (!projectIds.length) return out;
  const pathExpr = sql<string | null>`${documents.metadata}->>'project_path'`;
  const conds: SQL[] = [inArray(documents.projectId, projectIds)];
  if (scope) conds.push(scope);
  const rows = await db
    .select({
      projectId: documents.projectId,
      machineId: documents.machineId,
      path: pathExpr,
      n: count(documents.id),
      last: max(documents.syncedAt),
    })
    .from(documents)
    .where(and(...conds))
    .groupBy(documents.projectId, documents.machineId, pathExpr);

  for (const r of rows) {
    if (!r.projectId) continue;
    const list = out.get(r.projectId) ?? [];
    list.push({
      machineId: r.machineId,
      path: r.path,
      documents: Number(r.n ?? 0),
      lastActive: toMs(r.last),
      lastActiveRaw: r.last ? pgToIso(r.last) : null,
    });
    out.set(r.projectId, list);
  }
  return out;
}

export async function discoveredProjects(
  db: Db,
  machine: MachineRow | null,
  machineIds: string[] | null,
  toolId: string | null,
): Promise<DiscoveredProject[]> {
  const baseConds: SQL[] = [eq(documents.toolId, "system"), eq(documents.category, "discovery")];
  const docs: { machineId: string | null; relativePath: string; content: string | null }[] = [];

  if (machine) {
    let [doc] = await db
      .select({ machineId: documents.machineId, relativePath: documents.relativePath, content: documents.content })
      .from(documents)
      .where(and(...baseConds, eq(documents.machineId, machine.id)))
      .orderBy(desc(documents.syncedAt))
      .limit(1);
    if (!doc && machine.collectorTokenHash) {
      [doc] = await db
        .select({ machineId: documents.machineId, relativePath: documents.relativePath, content: documents.content })
        .from(documents)
        .where(and(...baseConds, eq(documents.relativePath, `discovery/${machine.collectorTokenHash}.json`)))
        .orderBy(desc(documents.syncedAt))
        .limit(1);
    }
    if (doc) docs.push(doc);
  } else {
    const conds = [...baseConds];
    if (machineIds !== null) {
      if (!machineIds.length) return [];
      conds.push(inArray(documents.machineId, machineIds));
    }
    const rows = await db
      .select({ machineId: documents.machineId, relativePath: documents.relativePath, content: documents.content })
      .from(documents)
      .where(and(...conds))
      .orderBy(desc(documents.syncedAt));
    const seen = new Set<string>();
    for (const d of rows) {
      const k = d.machineId ?? d.relativePath;
      if (!seen.has(k)) {
        seen.add(k);
        docs.push(d);
      }
    }
  }

  const found: DiscoveredProject[] = [];
  for (const doc of docs) {
    let toolsMap: unknown;
    try {
      toolsMap = JSON.parse(doc.content || "{}");
    } catch {
      continue;
    }
    if (!toolsMap || typeof toolsMap !== "object" || Array.isArray(toolsMap)) continue;
    const rec = toolsMap as Record<string, unknown>;
    const mid = machine ? machine.id : doc.machineId;
    const keys = toolId ? [toolId] : Object.keys(rec);
    for (const t of keys) {
      const info = rec[t];
      if (!info || typeof info !== "object" || Array.isArray(info)) continue;
      const projs = (info as { projects?: unknown }).projects;
      if (!Array.isArray(projs)) continue;
      for (const entry of projs) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const e = entry as { path?: string; name?: string };
        const path = typeof e.path === "string" ? e.path : null;
        const rawName = (typeof e.name === "string" && e.name) || (path || "").replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || "";
        if (!rawName) continue;
        const name = prettifyProjectName(rawName).replace(/^[-"'` ]+|[-"'` ]+$/g, "");
        if (!name || isInvalidProjectName(name)) continue;
        found.push({ machineId: mid, toolId: t, name, path });
      }
    }
  }
  return found;
}

export function projectDevices(
  slug: string,
  title: string | null | undefined,
  placements: Iterable<Placement>,
  discovered: Iterable<DiscoveredProject>,
  index: Map<string, DeviceRef>,
) {
  const groups = new Map<string, Placement[]>();
  const refs = new Map<string, DeviceRef>();
  for (const pl of placements) {
    const ref = pl.machineId ? index.get(pl.machineId) : undefined;
    if (!ref) continue;
    refs.set(ref.deviceId, ref);
    const list = groups.get(ref.deviceId) ?? [];
    list.push(pl);
    groups.set(ref.deviceId, list);
  }

  const devices = new Map<
    string,
    { device_id: string; name: string; source_path: string; document_count: number; last_active: string | null }
  >();
  const lastSeen = new Map<string, number>();

  for (const [deviceId, pls] of groups) {
    let bestMs = 0;
    let bestRaw: string | null = null;
    let total = 0;
    for (const p of pls) {
      total += p.documents;
      if (p.lastActive > bestMs) {
        bestMs = p.lastActive;
        bestRaw = p.lastActiveRaw;
      }
    }
    lastSeen.set(deviceId, bestMs);
    devices.set(deviceId, {
      device_id: deviceId,
      name: refs.get(deviceId)!.name,
      source_path: pickProjectPath(pls, slug, title) || "",
      document_count: total,
      last_active: bestMs > 0 ? bestRaw : null,
    });
  }

  for (const d of discovered) {
    const ref = d.machineId ? index.get(d.machineId) : undefined;
    if (!ref) continue;
    let path = cleanSourcePath(d.path) || "";
    if (path && isJunkProject(null, path)) path = "";
    const entry = devices.get(ref.deviceId);
    if (!entry) {
      lastSeen.set(ref.deviceId, 0);
      devices.set(ref.deviceId, {
        device_id: ref.deviceId,
        name: ref.name,
        source_path: path,
        document_count: 0,
        last_active: null,
      });
    } else if (!entry.source_path && path) {
      entry.source_path = path;
    }
  }

  return [...devices.values()].sort((a, b) => {
    const la = lastSeen.get(a.device_id) ?? 0;
    const lb = lastSeen.get(b.device_id) ?? 0;
    if (lb !== la) return lb - la;
    return b.document_count - a.document_count;
  });
}

export function discoveredFor(slug: string, discovered: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const out: DiscoveredProject[] = [];
  for (const d of discovered) {
    if (`${d.toolId}/${d.name}` === slug) out.push(d);
  }
  return out;
}

export async function deviceProjects(
  db: Db,
  redis: Redis | null,
  machine: Pick<MachineRow, "id">,
  days = 120,
): Promise<Record<string, string>> {
  const cacheKey = `dev_projects:${machine.id}:${days}`;
  try {
    const cached = await cacheGet(redis, cacheKey);
    if (cached && typeof cached === "object" && !Array.isArray(cached)) return cached as Record<string, string>;
  } catch {
    /* ignore */
  }

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const pathExpr = sql<string | null>`${documents.metadata}->>'project_path'`;
  const rows = await db
    .select({
      title: projects.title,
      path: pathExpr,
      n: count(documents.id),
      last: max(documents.syncedAt),
    })
    .from(documents)
    .innerJoin(projects, eq(projects.id, documents.projectId))
    .where(and(eq(documents.machineId, machine.id), sql`${documents.syncedAt} >= ${sinceIso}::timestamptz`, sql`${documents.metadata} ? 'project_path'`))
    .groupBy(projects.title, pathExpr);

  const byTitle = new Map<string, Placement[]>();
  for (const r of rows) {
    if (!r.title) continue;
    const list = byTitle.get(r.title) ?? [];
    list.push({
      machineId: machine.id,
      path: r.path,
      documents: Number(r.n ?? 0),
      lastActive: toMs(r.last),
      lastActiveRaw: r.last ? pgToIso(r.last) : null,
    });
    byTitle.set(r.title, list);
  }

  const found: Record<string, string> = {};
  for (const [title, pls] of byTitle) {
    const p = pickProjectPath(pls, title, title);
    if (p) found[title] = p;
  }
  await cacheSet(redis, cacheKey, found, 300).catch(() => {});
  return found;
}
