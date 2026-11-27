// AI subscription tool quotas (Antigravity, Claude Code, Codex, WorkBuddy) (server/server/api/quotas.py).
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv, Deps } from "../context";
import { machines } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import type { MachineRow } from "../services/device-merge";
import { getCachedDeviceQuotas } from "../services/device-reports";
import { seesAll } from "../services/visibility";
import { wsManager } from "../services/ws-manager";

async function findMachine(deps: Deps, user: UserRow, deviceId: string): Promise<MachineRow | null> {
  const conds = [eq(machines.name, deviceId), eq(machines.collectorTokenHash, deviceId)];
  const uid = normalizeUuid(deviceId);
  if (uid) conds.push(eq(machines.id, uid));
  const whereClause = seesAll(user, deps.settings) ? or(...conds) : and(or(...conds), eq(machines.userId, user.id));
  const [row] = await deps.db.select().from(machines).where(whereClause).limit(1);
  return row ?? null;
}

async function askForQuotas(deps: Deps, user: UserRow, deviceId: string | null, targetMid: string | null, isSpecific: boolean): Promise<boolean> {
  const msg = { type: "get_agent_quotas" };
  const adminAll = seesAll(user, deps.settings);
  if (isSpecific) {
    let target = targetMid && wsManager.isOnline(targetMid) ? targetMid : null;
    if (!target && adminAll && deviceId && wsManager.isOnline(deviceId)) target = deviceId;
    return Boolean(target) && (await wsManager.sendJson(target!, msg));
  }
  if (adminAll) {
    if (!wsManager.hasOnlineDevices()) return false;
    await wsManager.broadcast(msg);
    return true;
  }
  const rows = await deps.db.select({ hash: machines.collectorTokenHash }).from(machines).where(eq(machines.userId, user.id));
  let sent = false;
  for (const r of rows) {
    if (r.hash && wsManager.isOnline(r.hash)) {
      sent = (await wsManager.sendJson(r.hash, msg)) || sent;
    }
  }
  return sent;
}

function makeFallbackReport(deviceId?: string | null, deviceName?: string | null): Record<string, unknown> {
  const err = "未接收到设备实时额度上报，请确认本地服务运行并刷新";
  return {
    device_id: deviceId || "auto",
    device_name: deviceName || "当前设备",
    timestamp: new Date().toISOString().replace("Z", "+00:00"),
    is_fallback: true,
    tools: {
      antigravity: { tool: "antigravity", name: "Google Antigravity", available: false, remaining_percent: null, error: err },
      claude_code: { tool: "claude_code", name: "Claude Code", available: false, remaining_percent: null, error: err },
      codex: { tool: "codex", name: "OpenAI Codex", available: false, remaining_percent: null, error: err },
      workbuddy: { tool: "workbuddy", name: "WorkBuddy", available: false, remaining_percent: null, error: err },
    },
  };
}

export const quotaRoutes = new Hono<AppEnv>();

quotaRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const deviceId = c.req.query("device_id") ?? null;
  const cached = getCachedDeviceQuotas(deviceId, user, c.var.deps.settings);
  if (cached) return c.json(cached);

  let machineName: string | null = null;
  let targetMid: string | null = null;
  const isSpecific = Boolean(deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all");
  if (isSpecific && deviceId) {
    const m = await findMachine(c.var.deps, user, deviceId).catch(() => null);
    if (m) {
      machineName = m.name;
      targetMid = String(m.id);
      const hit =
        getCachedDeviceQuotas(m.collectorTokenHash, user, c.var.deps.settings) ??
        (m.name ? getCachedDeviceQuotas(m.name, user, c.var.deps.settings) : null) ??
        getCachedDeviceQuotas(String(m.id), user, c.var.deps.settings);
      if (hit) return c.json(hit);
    }
  }

  try {
    if (await askForQuotas(c.var.deps, user, deviceId, targetMid, isSpecific)) {
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const hit =
          getCachedDeviceQuotas(deviceId, user, c.var.deps.settings) ??
          (targetMid ? getCachedDeviceQuotas(targetMid, user, c.var.deps.settings) : null) ??
          (machineName ? getCachedDeviceQuotas(machineName, user, c.var.deps.settings) : null);
        if (hit) return c.json(hit);
      }
    }
  } catch {
    /* fallback */
  }
  return c.json(makeFallbackReport(deviceId, machineName));
});

quotaRoutes.post("/refresh", async (c) => {
  const user = await currentUser(c);
  const deviceId = c.req.query("device_id") ?? null;
  let machineName: string | null = null;
  let targetMid: string | null = null;
  const isSpecific = Boolean(deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all");
  if (isSpecific && deviceId) {
    const m = await findMachine(c.var.deps, user, deviceId).catch(() => null);
    if (m) {
      machineName = m.name;
      targetMid = String(m.id);
    }
  }

  let dispatched = false;
  try {
    dispatched = await askForQuotas(c.var.deps, user, deviceId, targetMid, isSpecific);
  } catch {
    /* ignore */
  }
  if (dispatched) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const hit =
        getCachedDeviceQuotas(deviceId, user, c.var.deps.settings) ??
        (targetMid ? getCachedDeviceQuotas(targetMid, user, c.var.deps.settings) : null) ??
        (machineName ? getCachedDeviceQuotas(machineName, user, c.var.deps.settings) : null);
      if (hit) return c.json(hit);
    }
  }
  const res =
    getCachedDeviceQuotas(deviceId, user, c.var.deps.settings) ??
    (targetMid ? getCachedDeviceQuotas(targetMid, user, c.var.deps.settings) : null) ??
    (machineName ? getCachedDeviceQuotas(machineName, user, c.var.deps.settings) : null);
  return c.json(res ?? makeFallbackReport(deviceId, machineName));
});
