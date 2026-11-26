// Agents memento runs on a device. The four with their own integrations, and the Agent Client Protocol ones
// the daemon (1.0.162+) drives through its generic ACP runner, offered only where the device has them.
import type { ExecutionMode } from "./turns";

export const ACP_MODES = [
  { id: "opencode", label: "OpenCode", color: "#F59E0B" },
  { id: "gemini", label: "Gemini CLI", color: "#4285F4" },
  { id: "cursor", label: "Cursor", color: "#7C8CFF" },
  { id: "kiro", label: "Kiro", color: "#9B5DE5" },
  { id: "copilot", label: "Copilot CLI", color: "#22C55E" },
] as const satisfies readonly { id: ExecutionMode; label: string; color: string }[];

export type AcpMode = (typeof ACP_MODES)[number]["id"];

const CLI_AGENT_MODES = new Set<string>(["claude", "codex", "antigravity", "workbuddy", ...ACP_MODES.map((m) => m.id)]);

/** A coding agent run on a device (has a session, a project folder, a worktree...), not AI 编排 or a shell. */
export function isCliAgentMode(mode: string): boolean {
  return CLI_AGENT_MODES.has(mode);
}

export function isAcpMode(mode: string): mode is AcpMode {
  return ACP_MODES.some((m) => m.id === mode);
}

/** The ACP agents to offer for a device: the ones it reported, plus the current mode so a restored one shows. */
export function acpModesFor(installed: readonly string[] | undefined, current: string) {
  const have = new Set(installed ?? []);
  return ACP_MODES.filter((m) => have.has(m.id) || m.id === current);
}
