// Device capabilities and AI subscription quotas shared across replicas (server/server/services/device_reports.py).
import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { cluster, SharedDict } from "./cluster";
import { seesAll } from "./visibility";

const capabilities = new SharedDict<Record<string, unknown>>(cluster, "device_capabilities");
const quotas = new SharedDict<Record<string, unknown>>(cluster, "device_quotas");
const owners = new SharedDict<string | null>(cluster, "device_owners");

export function recordOwner(names: Iterable<string | null | undefined>, userId: string | null): void {
  owners.set(names, userId);
}

export function visibleTo(name: string, user: UserRow | null | undefined, settings?: Settings): boolean {
  if (!user) return true;
  if (settings ? seesAll(user, settings) : user.role === "admin" || user.role === "owner") return true;
  return owners.data.get(name) === String(user.id);
}

function visibleMap<T>(data: Map<string, T>, user: UserRow | null | undefined, settings?: Settings): Map<string, T> {
  const out = new Map<string, T>();
  for (const [k, v] of data.entries()) {
    if (visibleTo(k, user, settings)) out.set(k, v);
  }
  return out;
}

export function setDeviceCapabilities(names: Iterable<string | null | undefined>, caps: Record<string, unknown>): void {
  capabilities.set(names, caps);
}

export function getCachedDeviceCapabilities(
  deviceId?: string | null,
  tool?: string | null,
  user?: UserRow | null,
  settings?: Settings,
): Record<string, unknown> | null {
  const reports = visibleMap(capabilities.data, user, settings);
  if (!deviceId || deviceId === "auto" || deviceId === "ask_only") {
    for (const caps of reports.values()) {
      if (tool) {
        if (tool in caps) return (caps[tool] as Record<string, unknown>) ?? null;
      } else {
        return caps;
      }
    }
    return null;
  }

  let caps = reports.get(deviceId) ?? null;
  if (!caps) {
    for (const [k, v] of reports.entries()) {
      if (k === deviceId || deviceId.startsWith(k) || k.startsWith(deviceId)) {
        caps = v;
        break;
      }
    }
  }
  if (!caps) return null;
  if (tool) return (caps[tool] as Record<string, unknown>) ?? null;
  return caps;
}

export function deviceHasFeature(name: string | null | undefined, feature: string, user?: UserRow | null, settings?: Settings): boolean {
  if (!name) return false;
  const caps = getCachedDeviceCapabilities(name, null, user, settings);
  const env = caps?.environment;
  if (!env || typeof env !== "object") return false;
  const features = (env as Record<string, unknown>).features;
  return Array.isArray(features) && features.includes(feature);
}

export function getDeviceEnvironmentSummary(deviceId?: string | null, user?: UserRow | null, settings?: Settings): string | null {
  if (!deviceId || deviceId === "auto" || deviceId === "ask_only" || deviceId === "all") return null;
  const caps = getCachedDeviceCapabilities(deviceId, null, user, settings);
  const env = caps?.environment;
  if (!env || typeof env !== "object") return null;
  const e = env as Record<string, unknown>;
  const plat = String(e.platform ?? "");
  const arch = String(e.arch ?? "");
  const shell = String(e.shell ?? "");
  const username = String(e.username ?? "");
  const toolsDict = (e.tools && typeof e.tools === "object" ? e.tools : {}) as Record<string, unknown>;
  const activeTools = Object.entries(toolsDict)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}: ${String(v)}`);
  const lines = [`系统平台: ${plat} (${arch}) | 默认 Shell: ${shell} | 当前用户: ${username}`];
  if (activeTools.length) lines.push(`已就绪工具链: ${activeTools.join(", ")}`);
  const workspaces = Array.isArray(e.workspaces) ? (e.workspaces as string[]).slice(0, 3) : [];
  if (workspaces.length) lines.push(`常用工作区路径: ${workspaces.join(", ")}`);
  lines.push("提示: 目标设备已就绪上述环境与工具，执行命令时直接调用对应环境，无需重复运行 which/--version 探查。");
  return lines.join("\n");
}

export function claudePlanTier<T>(tier: T): T | string {
  if (typeof tier !== "string") return tier;
  const t = tier.toLowerCase();
  if (!t.startsWith("default_claude")) return tier;
  const m = /max_(\d+x)/.exec(t);
  if (m) return `MAX ${m[1]!.toUpperCase()}`;
  return t.includes("max") ? "MAX" : "PRO";
}

export function setCachedDeviceQuotas(
  deviceId: string,
  report: Record<string, unknown>,
  machineName?: string | null,
  machineId?: string | null,
): void {
  if (!report || typeof report !== "object") return;
  let nextReport = report;
  const tools = report.tools;
  if (tools && typeof tools === "object") {
    const claude = (tools as Record<string, unknown>).claude_code;
    if (claude && typeof claude === "object" && "tier" in claude) {
      nextReport = {
        ...report,
        tools: {
          ...(tools as Record<string, unknown>),
          claude_code: { ...(claude as Record<string, unknown>), tier: claudePlanTier((claude as Record<string, unknown>).tier) },
        },
      };
    }
  }
  const reportWithMeta = {
    ...nextReport,
    device_id: deviceId,
    device_name: machineName || deviceId,
    updated_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  quotas.set([deviceId, machineName, machineId], reportWithMeta);
}

export function getCachedDeviceQuotas(
  deviceId?: string | null,
  user?: UserRow | null,
  settings?: Settings,
): Record<string, unknown> | null {
  const reports = visibleMap(quotas.data, user, settings);
  if (deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all") {
    const exact = reports.get(deviceId);
    if (exact) return exact;
    const low = deviceId.toLowerCase();
    for (const [k, v] of reports.entries()) {
      const kl = k.toLowerCase();
      if (kl.includes(low) || low.includes(kl)) return v;
    }
    return null;
  }
  let best: Record<string, unknown> | null = null;
  let bestTs = "";
  for (const r of reports.values()) {
    const ts = String(r.updated_at ?? "");
    if (!best || ts > bestTs) {
      best = r;
      bestTs = ts;
    }
  }
  return best;
}
