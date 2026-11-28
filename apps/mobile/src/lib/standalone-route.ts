// Multi-route standalone desktop <-> mobile pairing & smart route selection:
// Priority 1: Direct LAN (same Wi-Fi, lowest latency, zero external traffic)
// Priority 2: Tailscale Serve (private WireGuard HTTPS, if installed)
// Priority 3: Stateless Blind HTTPS Relay (4G/5G anywhere, zero DB/storage on relay server)

export const DEFAULT_UI_ORIGIN = "https://mem.ihasy.com";

export interface StandaloneProfile {
  deviceName: string;
  lanUrl?: string;
  tsUrl?: string;
  relayApiUrl?: string;
  uiOrigin: string;
}

export type RouteMode = "cloud" | "lan" | "tailscale" | "relay";

export interface ResolvedRoute {
  mode: Exclude<RouteMode, "cloud">;
  webOrigin: string;
  apiBase: string;
  customApiBase: string | null;
}

export interface ParsedPairingLink {
  code: string;
  profile: StandaloneProfile;
}

export interface ClaimPairingResult {
  accessToken: string;
  route: ResolvedRoute;
  profile: StandaloneProfile;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function cleanHttpUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) return undefined;
  return trimmed;
}

function originOf(url: string): string {
  return url.match(/^https?:\/\/[^/]+/i)?.[0] ?? DEFAULT_UI_ORIGIN;
}

/** Parse a `memento://pair?v=1&code=...&lan=...&ts=...&relay=...&ui=...&name=...` URI. */
export function parsePairingUrl(raw: string | null | undefined): ParsedPairingLink | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^(?:memento|com\.ihasy\.memento):\/\/pair(?:[/?#]|$)/i.test(trimmed)) {
    return null;
  }
  const qIdx = trimmed.indexOf("?");
  if (qIdx < 0) return null;
  const queryStr = trimmed.slice(qIdx + 1).split("#")[0] || "";
  const params = new URLSearchParams(queryStr);
  const code = (params.get("code") || "").trim();
  if (!code || code.length < 16 || code.length > 128) return null;

  const lanUrl = cleanHttpUrl(params.get("lan"));
  const tsUrl = cleanHttpUrl(params.get("ts"));
  const relayApiUrl = cleanHttpUrl(params.get("relay"));
  if (!lanUrl && !tsUrl && !relayApiUrl) return null;

  const uiOrigin = cleanHttpUrl(params.get("ui")) || (relayApiUrl ? originOf(relayApiUrl) : DEFAULT_UI_ORIGIN);
  const deviceName = (params.get("name") || "Memento 桌面端").trim().slice(0, 48) || "Memento 桌面端";

  return {
    code,
    profile: {
      deviceName,
      lanUrl,
      tsUrl,
      relayApiUrl,
      uiOrigin,
    },
  };
}

/** Check if a Memento endpoint answers GET /health with {"status":"ok"} within timeoutMs. */
export async function probeHealth(baseUrl: string, timeoutMs: number, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    return body?.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function buildCandidateRoutes(profile: StandaloneProfile): ResolvedRoute[] {
  const routes: ResolvedRoute[] = [];
  if (profile.lanUrl) {
    routes.push({ mode: "lan", webOrigin: profile.lanUrl, apiBase: profile.lanUrl, customApiBase: null });
  }
  if (profile.tsUrl) {
    routes.push({ mode: "tailscale", webOrigin: profile.tsUrl, apiBase: profile.tsUrl, customApiBase: null });
  }
  if (profile.relayApiUrl) {
    routes.push({ mode: "relay", webOrigin: profile.uiOrigin || DEFAULT_UI_ORIGIN, apiBase: profile.relayApiUrl, customApiBase: profile.relayApiUrl });
  }
  return routes;
}

/**
 * Probe all configured channels in parallel and pick the highest-priority healthy channel:
 * LAN (same Wi-Fi) -> Tailscale Serve -> Stateless Blind HTTPS Relay.
 */
export async function resolveBestStandaloneRoute(
  profile: StandaloneProfile,
  opts: { fetchImpl?: FetchLike; lanTimeoutMs?: number; tsTimeoutMs?: number; relayTimeoutMs?: number } = {},
): Promise<ResolvedRoute> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lanTimeout = opts.lanTimeoutMs ?? 900;
  const tsTimeout = opts.tsTimeoutMs ?? 1800;
  const relayTimeout = opts.relayTimeoutMs ?? 3500;

  const lanProbe = profile.lanUrl ? probeHealth(profile.lanUrl, lanTimeout, fetchImpl) : Promise.resolve(false);
  const tsProbe = profile.tsUrl ? probeHealth(profile.tsUrl, tsTimeout, fetchImpl) : Promise.resolve(false);
  const relayProbe = profile.relayApiUrl ? probeHealth(profile.relayApiUrl, relayTimeout, fetchImpl) : Promise.resolve(false);

  if (profile.lanUrl && (await lanProbe)) {
    return { mode: "lan", webOrigin: profile.lanUrl, apiBase: profile.lanUrl, customApiBase: null };
  }
  if (profile.tsUrl && (await tsProbe)) {
    return { mode: "tailscale", webOrigin: profile.tsUrl, apiBase: profile.tsUrl, customApiBase: null };
  }
  if (profile.relayApiUrl && (await relayProbe)) {
    return {
      mode: "relay",
      webOrigin: profile.uiOrigin || DEFAULT_UI_ORIGIN,
      apiBase: profile.relayApiUrl,
      customApiBase: profile.relayApiUrl,
    };
  }

  // Fallback when all endpoints fail (e.g. offline launch or desktop asleep): prefer relay shell so UI loads cleanly
  if (profile.relayApiUrl) {
    return {
      mode: "relay",
      webOrigin: profile.uiOrigin || DEFAULT_UI_ORIGIN,
      apiBase: profile.relayApiUrl,
      customApiBase: profile.relayApiUrl,
    };
  }
  if (profile.tsUrl) {
    return { mode: "tailscale", webOrigin: profile.tsUrl, apiBase: profile.tsUrl, customApiBase: null };
  }
  return { mode: "lan", webOrigin: profile.lanUrl!, apiBase: profile.lanUrl!, customApiBase: null };
}

/**
 * Exchange a one-time pairing code against the standalone desktop over the best reachable channel.
 * Automatically falls back across channels if LAN is blocked (e.g. during first-time iOS Local Network prompt).
 */
export async function claimPairingCode(
  profile: StandaloneProfile,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<ClaimPairingResult> {
  const preferred = await resolveBestStandaloneRoute(profile, { fetchImpl });
  const candidates = [preferred, ...buildCandidateRoutes(profile).filter((r) => r.apiBase !== preferred.apiBase)];

  let lastError = "无法连接到桌面端单机服务，请确认电脑端 Memento 正在运行";
  for (const route of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetchImpl(`${route.apiBase.replace(/\/+$/, "")}/api/auth/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as { access_token?: string };
        if (data.access_token) {
          return { accessToken: data.access_token, route, profile };
        }
        lastError = "桌面端未返回登录凭据";
        continue;
      }
      const errBody = (await res.json().catch(() => ({}))) as { detail?: string };
      // 401/403 means the desktop answered and rejected the code (expired or already used) — stop immediately.
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        throw new Error(errBody.detail || "配对码已失效或已过期，请在桌面端刷新二维码后重试");
      }
      lastError = errBody.detail || `桌面端返回 HTTP ${res.status}`;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Error && /配对码|失效|过期|Too many/i.test(e.message)) {
        throw e;
      }
      lastError = e instanceof Error ? e.message : lastError;
    }
  }
  throw new Error(lastError);
}

export function routeModeLabel(mode: RouteMode): string {
  switch (mode) {
    case "lan":
      return "局域网直连";
    case "tailscale":
      return "Tailscale 直连";
    case "relay":
      return "无状态盲隧道";
    default:
      return "服务端";
  }
}
