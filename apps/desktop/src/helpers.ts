/**
 * The desktop app's pure helpers, kept out of main.ts (which needs Electron) so they can be tested.
 */

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

/** The file a memento-media:// URL points at. */
export function parseMementoMediaFilePath(rawUrl: string, platform: NodeJS.Platform): string {
  const parsed = new URL(rawUrl);
  let filePath: string;
  if (parsed.host === "local" || parsed.host === "") {
    filePath = decodeURIComponent(parsed.pathname);
  } else {
    // When memento-media:///Users/... is navigated, Chromium treats the first segment (e.g. "users") as the host
    filePath = "/" + decodeURIComponent(parsed.host + parsed.pathname);
  }
  if (platform === "win32" && filePath.startsWith("/")) {
    filePath = filePath.slice(1);
  }
  return filePath;
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
