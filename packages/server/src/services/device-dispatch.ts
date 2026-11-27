// Handing a device_tasks row to its device over WebSocket (server/server/services/device_dispatch.py).
// Strict invariant (pitfall_d6464e9470): devices only receive tasks via WS; immediately mark running if sent,
// or failed with explicit reason if offline / send failed, only transitioning rows still in "queued".
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client";
import { deviceTasks } from "../db/pulled/schema";
import type { MachineRow } from "./device-merge";
import { normalizeDeviceName } from "./user-filter";
import { wsManager } from "./ws-manager";

export type DeviceTaskRow = typeof deviceTasks.$inferSelect;

export const OFFLINE_ERROR = "设备当前不在线，任务没有发出去。等设备连上后再派发";
export const SEND_FAILED_ERROR = "设备连接刚断开，任务没有发出去。等设备重新连上后再派发";

export function wsAlias(deviceId: string | null | undefined, machine?: MachineRow | null): string | null {
  const candidates: (string | null | undefined)[] = [deviceId];
  if (machine) {
    candidates.push(machine.collectorTokenHash, machine.name, normalizeDeviceName(machine.name), String(machine.id));
  }
  for (const c of candidates) {
    if (c && wsManager.hasDevice(c)) return c;
  }
  return null;
}

export async function deliverTask(db: Db, task: DeviceTaskRow, machine?: MachineRow | null): Promise<{ sent: boolean; task: DeviceTaskRow }> {
  const alias = wsAlias(task.deviceId, machine);
  let sent = false;
  if (alias) {
    sent = await wsManager.sendTask(alias, {
      id: String(task.id),
      action: task.action,
      payload: (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>,
      timeout_seconds: task.timeoutSeconds,
    });
  }
  const nowIso = new Date().toISOString();
  const patch: Partial<typeof deviceTasks.$inferInsert> = sent
    ? { status: "running", dispatchedAt: nowIso }
    : { status: "failed", error: alias ? SEND_FAILED_ERROR : OFFLINE_ERROR, finishedAt: nowIso };

  await db
    .update(deviceTasks)
    .set(patch)
    .where(and(eq(deviceTasks.id, task.id), eq(deviceTasks.status, "queued")));

  const [fresh] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, task.id)).limit(1);
  return { sent, task: fresh ?? { ...task, ...patch } };
}
