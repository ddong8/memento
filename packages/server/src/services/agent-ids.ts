// Device OS detection & agent session id validation (server/server/services/agent_ids.py).

const PLATFORM_SUFFIX_RE = /\((darwin|macos|windows|linux|ios|android)\)\s*$/i;
const OS_OF_SUFFIX: Record<string, string> = {
  darwin: "macos",
  macos: "macos",
  windows: "windows",
  linux: "linux",
  ios: "ios",
  android: "android",
};

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REPORTED_SESSION_RE = /^session id:\s*(\S+)/gim;

/** "macos", "windows", "linux", "ios" or "android" from the device's name; null when unknown. */
export function deviceOs(name: string | null | undefined): string | null {
  const m = PLATFORM_SUFFIX_RE.exec(name ?? "");
  return m ? (OS_OF_SUFFIX[m[1]!.toLowerCase()] ?? null) : null;
}

/** The session id, trimmed, when an agent could have made it; null for anything else. */
export function cleanSessionId(value: unknown, binary?: string | null): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!SESSION_ID_RE.test(s)) return null;
  const b = (binary ?? "").toLowerCase();
  if ((b.includes("agy") || b.includes("antigravity")) && !UUID_RE.test(s)) return null;
  return s;
}

/** The session memento's runners name on stderr ("session id: <id>", last line counts). */
export function reportedSessionId(stderr: string | null | undefined, binary?: string | null): string | null {
  if (!stderr) return null;
  let last: string | null = null;
  REPORTED_SESSION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REPORTED_SESSION_RE.exec(stderr)) !== null) {
    const sid = cleanSessionId(m[1], binary);
    if (sid) last = sid;
  }
  return last;
}
