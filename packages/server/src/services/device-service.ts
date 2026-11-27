// Device registration & heartbeat throttling (server/server/services/device_service.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { machines } from "../db/pulled/schema";
import { resolveMerged, type MachineRow } from "./device-merge";

export const HEARTBEAT_WRITE_EVERY_MS = 60_000;

export function shouldWriteHeartbeat(lastHeartbeat: string | null | undefined, nowMs: number): boolean {
  if (!lastHeartbeat) return true;
  const t = Date.parse(lastHeartbeat.includes("T") ? lastHeartbeat : lastHeartbeat.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  if (Number.isNaN(t)) return true;
  return nowMs - t >= HEARTBEAT_WRITE_EVERY_MS;
}

export async function ensureDevice(
  db: Db,
  deviceId: string,
  deviceName: string,
  _devicePlatform: string,
  userId: string | null = null,
): Promise<MachineRow> {
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  let [machine] = await db.select().from(machines).where(eq(machines.collectorTokenHash, deviceId)).limit(1);

  if (machine && machine.mergedInto) {
    const resolved = await resolveMerged(db, machine);
    if (resolved) {
      if (shouldWriteHeartbeat(resolved.lastHeartbeat, nowMs)) {
        const [updated] = await db
          .update(machines)
          .set({ lastHeartbeat: nowIso })
          .where(eq(machines.id, resolved.id))
          .returning();
        return updated ?? resolved;
      }
      return resolved;
    }
  }

  if (!machine && userId && deviceName) {
    const [existing] = await db
      .select()
      .from(machines)
      .where(and(eq(machines.name, deviceName), eq(machines.userId, userId), isNull(machines.mergedInto)))
      .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`))
      .limit(1);
    if (existing) {
      const [updated] = await db
        .update(machines)
        .set({
          collectorTokenHash: deviceId,
          lastHeartbeat: nowIso,
          ...(existing.isArchived ? { isArchived: false, archivedAt: null } : {}),
        })
        .where(eq(machines.id, existing.id))
        .returning();
      return updated ?? existing;
    }
  }

  if (!machine) {
    const [inserted] = await db
      .insert(machines)
      .values({
        id: randomUUID(),
        name: deviceName,
        collectorTokenHash: deviceId,
        userId,
        lastHeartbeat: nowIso,
      })
      .returning();
    return inserted!;
  }

  const patch: Partial<typeof machines.$inferInsert> = {};
  if (machine.name !== deviceName) patch.name = deviceName;
  if (shouldWriteHeartbeat(machine.lastHeartbeat, nowMs)) patch.lastHeartbeat = nowIso;
  if (machine.isArchived) {
    patch.isArchived = false;
    patch.archivedAt = null;
  }
  if (userId && !machine.userId) patch.userId = userId;
  if (Object.keys(patch).length) {
    const [updated] = await db.update(machines).set(patch).where(eq(machines.id, machine.id)).returning();
    return updated ?? machine;
  }
  return machine;
}
