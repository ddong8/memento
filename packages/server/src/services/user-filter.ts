// Device lookup & name normalization (server/server/services/user_filter.py).
import { desc, eq, ilike, inArray, or, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { machines } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { resolveMerged, type MachineRow } from "./device-merge";
import { seesAll } from "./visibility";

const PLATFORM_SUFFIXES = [" (Darwin)", " (Windows)", " (Linux)"] as const;

/** Strip platform suffixes like ' (Darwin)', ' (Windows)', ' (Linux)'. */
export function normalizeDeviceName(name: string | null | undefined): string {
  if (!name) return "";
  for (const suffix of PLATFORM_SUFFIXES) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

/** Find a machine by collector_token_hash, machine name, or UUID id, verifying ownership for non-admin users. */
export async function findMachineByIdOrHash(
  db: Db,
  settings: Settings,
  deviceId: string | null | undefined,
  user: UserRow | null = null,
): Promise<MachineRow | null> {
  if (!deviceId || deviceId === "auto" || deviceId === "ask_only" || deviceId === "all") return null;

  const baseName = normalizeDeviceName(deviceId);
  const nameCandidates = new Set<string>([deviceId]);
  if (baseName) {
    nameCandidates.add(baseName);
    nameCandidates.add(`${baseName} (Darwin)`);
    nameCandidates.add(`${baseName} (Windows)`);
    nameCandidates.add(`${baseName} (Linux)`);
  }

  const conditions = [eq(machines.collectorTokenHash, deviceId), inArray(machines.name, [...nameCandidates])];
  if (baseName) conditions.push(ilike(machines.name, `${baseName}%`));

  const whereClause =
    user && !seesAll(user, settings) ? sql`(${or(...conditions)}) AND ${machines.userId} = ${user.id}` : or(...conditions);

  const [m] = await db
    .select()
    .from(machines)
    .where(whereClause)
    .orderBy(desc(sql`(${machines.mergedInto} IS NULL)`), desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`))
    .limit(1);

  if (m) {
    if (m.mergedInto) return (await resolveMerged(db, m)) ?? m;
    return m;
  }

  const uid = normalizeUuid(deviceId);
  if (!uid) return null;
  const uidWhere = user && !seesAll(user, settings) ? sql`${machines.id} = ${uid} AND ${machines.userId} = ${user.id}` : eq(machines.id, uid);
  const [byId] = await db.select().from(machines).where(uidWhere).limit(1);
  if (byId && byId.mergedInto) return (await resolveMerged(db, byId)) ?? byId;
  return byId ?? null;
}
