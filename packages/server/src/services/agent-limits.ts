// Detection of agent subscription quota exhaustion (server/server/services/agent_limits.py).

export const USAGE_LIMIT = "usage_limit";

const USAGE_LIMIT_RE = /You(?:'|’)ve hit your [\w' ]*limit[^\n"]*|You(?:'|’)ve hit your team(?:'|’)s shared budget[^\n"]*|usage limit reached[^\n"]*/gi;
const MODEL_LIMIT_RE =
  /^(?:You(?:'|’)ve hit your (?:Opus|Sonnet|Fable|Haiku) limit|You(?:'|’)ve hit your team(?:'|’)s shared budget|You(?:'|’)ve hit your usage limit for )/i;
const AGY_QUOTA_RE = /Individual quota reached[^\n"]*/i;

/** The quota message an agent task ended on (only checks error and stderr, never stdout). */
export function usageLimitMessage(result: Record<string, unknown> | null | undefined): string | null {
  if (!result || String(result.action || "agent") !== "agent") return null;
  const failed = result.status === "failed";
  for (const key of ["error", "stderr"] as const) {
    const text = String(result[key] ?? "");
    USAGE_LIMIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USAGE_LIMIT_RE.exec(text)) !== null) {
      if (failed || !MODEL_LIMIT_RE.test(m[0])) return m[0].trim();
    }
    if (failed) {
      const am = AGY_QUOTA_RE.exec(text);
      if (am) return am[0].trim();
    }
  }
  return null;
}

/** Mutates and returns `result` marked failed with USAGE_LIMIT when an agent hit its account quota. */
export function markUsageLimit(result: Record<string, unknown>): Record<string, unknown> {
  const msg = usageLimitMessage(result);
  if (msg) {
    result.status = "failed";
    result.error_type = USAGE_LIMIT;
    result.error = msg;
  }
  return result;
}
