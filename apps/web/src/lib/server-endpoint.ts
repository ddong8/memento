export const DEFAULT_OFFICIAL_SERVER = "https://mem.ihasy.com";
export const DEFAULT_LOCAL_SERVER = "http://localhost:8001";

export interface ServerHistoryItem {
  url: string;
  label?: string;
  lastUsed: number;
}

export function getCustomServerUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const val = localStorage.getItem("memento_custom_server");
    return val ? val.trim().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

export function setCustomServerUrl(url: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!url) {
      localStorage.removeItem("memento_custom_server");
    } else {
      const clean = url.trim().replace(/\/+$/, "");
      localStorage.setItem("memento_custom_server", clean);
      addServerToHistory(clean);
    }
  } catch {}
}

export function getServerHistory(): ServerHistoryItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem("memento_server_history");
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addServerToHistory(url: string, label?: string): void {
  if (typeof window === "undefined") return;
  try {
    const clean = url.trim().replace(/\/+$/, "");
    if (!clean) return;
    const history = getServerHistory().filter((item) => item.url !== clean);
    history.unshift({ url: clean, label, lastUsed: Date.now() });
    localStorage.setItem("memento_server_history", JSON.stringify(history.slice(0, 10)));
  } catch {}
}

export function removeServerFromHistory(url: string): void {
  if (typeof window === "undefined") return;
  try {
    const clean = url.trim().replace(/\/+$/, "");
    const history = getServerHistory().filter((item) => item.url !== clean);
    localStorage.setItem("memento_server_history", JSON.stringify(history));
  } catch {}
}

export function clearServerHistory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("memento_server_history");
  } catch {}
}

export function openServerSwitchModal(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("memento:open-server-switch"));
  }
}

export async function testServerConnection(url: string): Promise<{ ok: boolean; latencyMs: number; error?: string; status?: number }> {
  const clean = url.trim().replace(/\/+$/, "");
  const startTime = Date.now();
  try {
    if (typeof window !== "undefined" && (window as unknown as { mementoDesktop?: { server?: { test: (u: string) => Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> } } }).mementoDesktop?.server?.test) {
      return await (window as unknown as { mementoDesktop: { server: { test: (u: string) => Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> } } }).mementoDesktop.server.test(clean);
    }
    // A memento server answers /health with {"status":"ok"}; any other site, or one that is down, doesn't.
    const res = await fetch(`${clean}/health`, { signal: AbortSignal.timeout(5000) });
    const latencyMs = Date.now() - startTime;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    if (res.ok && body?.status === "ok") return { ok: true, latencyMs, status: res.status };
    return { ok: false, latencyMs, status: res.status, error: res.ok ? "不是 memento 服务器" : `HTTP ${res.status}` };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : "连接失败或超时";
    return { ok: false, latencyMs, error: errorMsg };
  }
}

export function getApiBase(): string {
  if (typeof window !== "undefined") {
    const custom = localStorage.getItem("memento_custom_server");
    if (custom) {
      return custom.replace(/\/+$/, "");
    }
    const { protocol, hostname, port } = window.location;
    // If accessed via standard ports (80/443) — likely behind reverse proxy, API at same origin
    if (!port || port === "80" || port === "443") {
      return `${protocol}//${hostname}`;
    }
    // Direct access with port — API on port 8001
    return `${protocol}//${hostname}:8001`;
  }
  return "http://localhost:8001";
}

/**
 * Whether a URL is Memento's own (the page's origin or the API's). Only those get the login token: the
 * workbench also fetches other sites' documents, which must never see it, and whose 401 is not ours.
 */
export function isOwnUrl(url: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const origin = new URL(url, window.location.href).origin;
    return origin === window.location.origin || origin === new URL(getApiBase()).origin;
  } catch {
    return false;
  }
}

/** Authenticated fetch — wraps native fetch with JWT from localStorage. */
export function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const own = isOwnUrl(url);
  const token = own ? _getToken() : null;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { ...init, headers }).then((res) => {
    if (res.status === 401 && own && typeof window !== "undefined") {
      const onAuthPage = window.location.pathname.startsWith("/auth/");
      localStorage.removeItem("dr_token");
      if (!onAuthPage) {
        window.location.href = "/auth/login";
      }
    }
    return res;
  });
}

interface FetchOptions extends RequestInit {
  token?: string;
  skipCache?: boolean;
}

export function _getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("dr_token");
}
