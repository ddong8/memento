// Enterprise policy helpers (server/server/services/enterprise_policy.py).
import type { Settings } from "../config";

function allowedHosts(settings: Pick<Settings, "allowedModelHosts">): string[] {
  return (settings.allowedModelHosts || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function hostAllowed(url: string, settings: Pick<Settings, "allowedModelHosts">): boolean {
  const allowed = allowedHosts(settings);
  if (!allowed.length) return true;
  let host = "";
  try {
    host = new URL(url.includes("://") ? url : `http://${url.replace(/^\/\//, "")}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  for (const a of allowed) {
    if (a.startsWith("*.")) {
      if (host === a.slice(2) || host.endsWith(a.slice(1))) return true;
    } else if (host === a) {
      return true;
    }
  }
  return false;
}

export function modelEndpointViolation(
  data: Record<string, unknown>,
  settings: Pick<Settings, "allowedModelHosts">,
): string | null {
  for (const field of ["base_url", "fallback_base_url"] as const) {
    const url = String(data[field] ?? "").trim();
    if (url && !hostAllowed(url, settings)) {
      let host = url;
      try {
        host = new URL(url.includes("://") ? url : `http://${url.replace(/^\/\//, "")}`).hostname || url;
      } catch {
        /* keep url */
      }
      return `管理员只允许使用指定的模型服务，${host} 不在允许范围内`;
    }
  }
  return null;
}
