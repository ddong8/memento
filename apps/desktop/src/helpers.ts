/**
 * The desktop app's pure helpers, kept out of main.ts (which needs Electron) so they can be tested.
 */

import { deviceFilePath } from "@memento/daemon";

/** A notification shown twice within two minutes (from the push stream and the feed poll) is dropped;
 * "任务完成：xxx" and "xxx" with the same title count as the same one. */
export function createNotificationDeduper(windowMs = 120_000, now: () => number = Date.now) {
  const recent = new Map<string, number>();
  return (title: string, body: string): boolean => {
    const t = now();
    for (const [k, ts] of recent.entries()) {
      if (t - ts > windowMs) recent.delete(k);
    }
    const cleanTitle = (title || "").trim();
    const cleanBody = (body || "").trim();
    const colonIdx = cleanBody.indexOf("：");
    const coreBody = colonIdx !== -1 ? cleanBody.slice(colonIdx + 1).trim() : cleanBody;
    const fullKey = `${cleanTitle}:${cleanBody}`;
    const coreKey = `${cleanTitle}:${coreBody}`;
    if (recent.has(fullKey) || (coreBody && recent.has(coreKey))) {
      return true;
    }
    recent.set(fullKey, t);
    if (coreBody) recent.set(coreKey, t);
    return false;
  };
}

/** The local date as YYYY-MM-DD, the key app usage is counted under. */
export function getTodayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The app name usage is counted under: known apps by one name, system shells dropped (""). */
export function normalizeDesktopAppName(raw: string): string {
  const norm = raw.trim();
  const lower = norm.toLowerCase();

  if (
    !norm ||
    [
      "lockapp",
      "searchhost",
      "startmenuexperiencehost",
      "shellexperiencehost",
      "textinputhost",
      "loginwindow",
      "screensaverengine",
      "notification center",
    ].includes(lower)
  ) {
    return "";
  }

  if (lower.includes("cursor")) return "Cursor";
  if (lower.includes("antigravity")) return "Antigravity";
  if (lower.includes("workbuddy")) return "WorkBuddy";
  if (lower === "code" || lower === "vscode" || lower.includes("visual studio code")) return "VS Code";
  if (lower.includes("chrome")) return "Google Chrome";
  if (lower.includes("edge")) return "Microsoft Edge";
  if (lower.includes("firefox")) return "Firefox";
  if (lower.includes("safari")) return "Safari";
  if (lower.includes("wechat") || norm === "微信") return "微信";
  if (lower.includes("feishu") || lower.includes("lark") || norm === "飞书") return "飞书";
  if (lower.includes("dingtalk") || norm === "钉钉") return "钉钉";
  if (lower.includes("memento")) return "Memento";
  if (lower.includes("devenv")) return "Visual Studio";
  if (lower.includes("idea")) return "IntelliJ IDEA";
  if (lower.includes("pycharm")) return "PyCharm";
  if (lower.includes("webstorm")) return "WebStorm";
  if (lower.includes("goland")) return "GoLand";
  if (lower.includes("clion")) return "CLion";
  if (
    lower === "windowsterminal" ||
    lower.includes("terminal") ||
    lower === "iterm2" ||
    lower === "alacritty" ||
    lower === "kitty" ||
    lower === "konsole"
  ) {
    return norm;
  }
  return norm;
}

export function getMediaMimeType(filePath: string): string {
  const ext = (filePath.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "avi":
      return "video/x-msvideo";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "vtt":
      return "text/vtt; charset=utf-8";
    case "srt":
      return "text/plain; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** The file a memento-media:// URL points at, spelled the way this computer's file system wants it
 * (Git Bash's "/c/Users/..." is C:/Users/... on Windows). */
export function parseMementoMediaFilePath(rawUrl: string, platform: NodeJS.Platform): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "";
  }
  if (parsed.protocol !== "memento-media:") return "";
  let filePath: string;
  if (parsed.host === "local" || parsed.host === "") {
    filePath = decodeURIComponent(parsed.pathname);
  } else {
    // When memento-media:///Users/... is navigated, Chromium treats the first segment (e.g. "users") as the host
    filePath = "/" + decodeURIComponent(parsed.host + parsed.pathname);
  }
  return deviceFilePath(filePath, platform);
}

/**
 * Where to get a memento-media:// file that isn't on this computer (it is on another of the user's devices):
 * the server relay the page put in the URL's "remote" parameter, and only when that is a device-file route
 * of memento's own server, so a page can't make the app fetch anything else.
 */
export function mediaRemoteUrl(rawUrl: string, serverOrigins: string[]): string | null {
  const remote = new URL(rawUrl).searchParams.get("remote");
  if (!remote) return null;
  try {
    const u = new URL(remote);
    return serverOrigins.includes(u.origin) && u.pathname.startsWith("/api/devices/") ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A single "bytes=" range of a file of `size` bytes (RFC 9110 14.1.2): null to send the whole file
 * (no or unparsable header), "unsatisfiable" for a 416. "bytes=-500" is the last 500 bytes, and an end
 * past the file is cut to its last byte, so Content-Length matches what is sent.
 */
export function parseByteRange(header: string | null | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    // suffix range: the last N bytes
    const n = Number(m[2]);
    if (n <= 0 || size <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export interface PageMenuItem {
  id: string;
  label: string;
  type?: "separator";
  checked?: boolean;
  enabled?: boolean;
}

/**
 * When a link asks for a new window (`target="_blank"` / `window.open`), decide whether it belongs
 * inside Memento's own window (same web origin, non-API page route) instead of opening externally.
 * Returns the in-app path (`pathname + search + hash`) to navigate to, or null to open externally.
 */
export function resolveSameOriginAppPath(rawUrl: string, appOrigins: string[]): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!appOrigins.includes(u.origin)) return null;
    if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/")) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/** The menu items a page asked for, kept to plain labels (at most 40, 120 characters each). */
export function normalizeMenuItems(raw: unknown): PageMenuItem[] {
  if (!Array.isArray(raw)) return [];
  const out: PageMenuItem[] = [];
  for (const r of raw.slice(0, 40)) {
    if (!r || typeof r !== "object") continue;
    const it = r as Record<string, unknown>;
    if (it.type === "separator") {
      if (out.length && out[out.length - 1]?.type !== "separator") out.push({ id: "", label: "", type: "separator" });
      continue;
    }
    const label = typeof it.label === "string" ? it.label.trim().slice(0, 120) : "";
    if (!label) continue;
    out.push({
      id: typeof it.id === "string" ? it.id.slice(0, 80) : label,
      label,
      ...(typeof it.checked === "boolean" ? { checked: it.checked } : {}),
      ...(it.enabled === false ? { enabled: false } : {}),
    });
  }
  while (out.length && out[out.length - 1]?.type === "separator") out.pop();
  return out;
}

/** True when both URLs point at the same loopback host/port (localhost, 127.0.0.1, ::1). */
export function isSameLocalOrigin(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const localHost = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    return localHost(ua.hostname) && localHost(ub.hostname) && (ua.port || "80") === (ub.port || "80");
  } catch {
    return false;
  }
}

/**
 * True only when a persisted config file (JSON or legacy TOML) explicitly recorded a server URL or token.
 * An empty `{}` or unrelated file must NOT disable fresh-install standalone mode.
 */
export function hasConfiguredServer(rawText: string | undefined): boolean {
  if (!rawText || !rawText.trim()) return false;
  const trimmed = rawText.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const hasStr = (k: string) => typeof obj[k] === "string" && (obj[k] as string).trim().length > 0;
      return hasStr("server_url") || hasStr("token") || hasStr("server_token");
    } catch {
      return false;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if ((key === "url" || key === "server_url" || key === "token") && val.length > 0) return true;
  }
  return false;
}

export type DesktopStartupMode = "embedded-fresh" | "embedded-existing" | "server";

/**
 * Decide whether the desktop app launches into zero-Docker standalone mode or connects to a remote server.
 * New installs ALWAYS default to standalone mode unless managed IT policy or MEMENTO_SERVER_URL overrides it;
 * once the user explicitly switches to a remote server, subsequent launches stay in server mode until switched back.
 */
export function resolveStartupMode(opts: {
  embeddedAvailable: boolean;
  managedServerUrl?: string;
  hasSavedServerConfig: boolean;
  envServerUrl?: string;
  configServerUrl?: string;
  embeddedUrl: string;
}): DesktopStartupMode {
  if (!opts.embeddedAvailable || opts.managedServerUrl || opts.envServerUrl) return "server";
  if (!opts.hasSavedServerConfig) return "embedded-fresh";
  if (isSameLocalOrigin(opts.configServerUrl, opts.embeddedUrl)) return "embedded-existing";
  return "server";
}

/** Default initial route inside the desktop window: never drop unauthenticated desktop users onto the marketing landing page. */
export function resolveDefaultDesktopRoute(opts: { target?: string; lastRoute?: string; hasToken: boolean }): string {
  if (opts.target) return opts.target;
  if (!opts.hasToken) return "/auth/login";
  if (opts.lastRoute && opts.lastRoute !== "/") return opts.lastRoute;
  return "/ask";
}
