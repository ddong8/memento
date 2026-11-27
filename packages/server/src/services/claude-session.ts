// Claude Code session context & resume-cost metadata (server/server/services/claude_session.py).
import type { Settings } from "../config";

export const CACHE_TTL_MINUTES = 60;
export const MEMENTO_CLIENT = "memento";
export const CLIENT_NAMES: Record<string, string> = {
  "claude-vscode": "VS Code",
  cli: "终端",
  "sdk-cli": "Memento",
  [MEMENTO_CLIENT]: "Memento",
};

export function sessionActivity(content: string): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (Object.keys(found).length >= 4) break;
    const line = lines[i]!;
    if (!line.includes('"entrypoint"') && !line.includes('"usage"')) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const ts = entry.timestamp;
    if (!("last_client" in found) && entry.entrypoint && ts) {
      found.last_client = String(entry.entrypoint);
      found.last_client_at = String(ts);
    }
    const msg = entry.message && typeof entry.message === "object" ? (entry.message as Record<string, unknown>) : null;
    const usage = msg?.usage && typeof msg.usage === "object" ? (msg.usage as Record<string, unknown>) : null;
    if (!("context_tokens" in found) && entry.type === "assistant" && usage) {
      const tokens =
        Number(usage.input_tokens || 0) +
        Number(usage.cache_creation_input_tokens || 0) +
        Number(usage.cache_read_input_tokens || 0);
      if (tokens && msg?.model !== "<synthetic>") {
        found.context_tokens = tokens;
        found.context_at = String(ts || "");
      }
    }
  }
  return found;
}

function minutesSince(iso: unknown, nowMs: number): number | null {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

export function resumeCost(
  meta: Record<string, unknown> | null | undefined,
  settings?: Pick<Settings, "sessionHeavyTokens">,
  nowMs = Date.now(),
): Record<string, unknown> {
  const m = meta ?? {};
  const tokens = m.context_tokens;
  if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens <= 0) return {};
  const heavyThreshold = settings?.sessionHeavyTokens ?? 150_000;
  const client = typeof m.last_client === "string" ? m.last_client : null;
  const idle = minutesSince(m.last_client_at, nowMs);
  return {
    context_tokens: tokens,
    heavy: tokens > heavyThreshold,
    last_client: client ? (CLIENT_NAMES[client] ?? client) : null,
    minutes_since_activity: idle,
    cache_cold: Boolean(idle !== null && idle >= CACHE_TTL_MINUTES),
  };
}

export function mementoClient(llmSettings: Record<string, unknown> | null | undefined): boolean {
  const agent = llmSettings?.agent;
  return !(agent && typeof agent === "object" && (agent as Record<string, unknown>).claude_memento_client === false);
}

export function claudeEntrypoint(llmSettings: Record<string, unknown> | null | undefined): string {
  return mementoClient(llmSettings) ? MEMENTO_CLIENT : "sdk-cli";
}
