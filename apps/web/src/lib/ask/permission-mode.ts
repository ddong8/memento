// When the agent must ask before running commands or editing files. Sent with every ask and kept in the
// conversation's config; the daemon maps it to the agent's own mode (Claude Code: --permission-mode) and turns
// the tool calls the mode leaves open into approval cards in the reply. "full" is how memento always ran.
export type PermissionMode = "full" | "auto_edits" | "supervised" | "auto";

export const PERMISSION_MODE_OPTIONS: readonly { id: PermissionMode; zh: string; en: string }[] = [
  { id: "full", zh: "全部放行（不询问）", en: "Full access" },
  { id: "auto_edits", zh: "自动接受改文件，命令要问", en: "Auto-accept edits" },
  { id: "auto", zh: "智能体自动判断，危险的才问", en: "Auto (agent reviews)" },
  { id: "supervised", zh: "每步都问", en: "Supervised" },
];

const STORAGE_KEY = "memento_permission_mode";

export function normalizePermissionMode(mode: unknown): PermissionMode {
  return PERMISSION_MODE_OPTIONS.some((o) => o.id === mode) ? (mode as PermissionMode) : "full";
}

export function permissionModeLabel(mode: PermissionMode, isZh: boolean): string {
  const opt = PERMISSION_MODE_OPTIONS.find((o) => o.id === mode) ?? PERMISSION_MODE_OPTIONS[0]!;
  return isZh ? opt.zh : opt.en;
}

/** The mode a new conversation starts with: the last one picked on this device. */
export function defaultPermissionMode(): PermissionMode {
  try {
    return normalizePermissionMode(typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null);
  } catch {
    return "full";
  }
}

export function rememberPermissionMode(mode: PermissionMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode: the conversation's own config still keeps it
  }
}

/** Agents whose approvals memento can bring to the user: Claude Code, Codex, Antigravity and the ACP agents. */
export function supportsPermissionModes(mode: string): boolean {
  return ["claude", "codex", "antigravity", "opencode", "gemini", "cursor", "kiro", "copilot"].includes(mode);
}
