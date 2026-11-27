// Which AI tools on a device carry the resident profile & skills (server/server/services/profile_targets.py).

export const INJECTION_TARGETS = ["claude_code", "codex", "antigravity", "workbuddy", "openclaw", "hermes"] as const;

export function profileTargets(machine: { profileTargetsOff?: unknown } | null | undefined): string[] {
  const raw = machine?.profileTargetsOff;
  const off = new Set(Array.isArray(raw) ? raw.map(String) : []);
  return INJECTION_TARGETS.filter((t) => !off.has(t));
}

export function targetsOff(wanted: Iterable<string>): string[] {
  const on = new Set(wanted);
  return INJECTION_TARGETS.filter((t) => !on.has(t));
}
