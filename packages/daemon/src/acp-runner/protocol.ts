// The parts of memento's generic ACP runner that don't touch processes: which agents speak the Agent Client
// Protocol and how to start them, how a permission request is answered under each permission mode, and how
// session/update notifications become memento's agent events.
// Start commands are from each vendor's docs (checked 2026-11-26): OpenCode https://opencode.ai/docs/acp/ ,
// Cursor https://cursor.com/docs/cli/acp , Kiro https://kiro.dev/docs/cli/acp/ , Copilot CLI (GitHub changelog
// 2026-01-28), Gemini CLI `gemini --help` ("--experimental-acp  Starts the agent in ACP mode").

export type Json = Record<string, unknown>;
export type PermissionMode = "full" | "auto_edits" | "supervised" | "auto";

export interface AcpAgent {
  /** memento's execution mode / binary id */
  id: string;
  label: string;
  /** Executables to look for, in order */
  bins: string[];
  args: string[];
}

export const ACP_AGENTS: readonly AcpAgent[] = [
  { id: "opencode", label: "OpenCode", bins: ["opencode"], args: ["acp"] },
  { id: "gemini", label: "Gemini CLI", bins: ["gemini"], args: ["--experimental-acp"] },
  { id: "cursor", label: "Cursor", bins: ["cursor-agent", "agent"], args: ["acp"] },
  { id: "kiro", label: "Kiro", bins: ["kiro-cli"], args: ["acp"] },
  { id: "copilot", label: "Copilot CLI", bins: ["copilot"], args: ["--acp"] },
];

export function acpAgent(id: string): AcpAgent | undefined {
  const k = id.trim().toLowerCase();
  return ACP_AGENTS.find((a) => a.id === k);
}

export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

/** Tool kinds that only look (never change anything): allowed in every mode but "every step asks". */
const READ_ONLY_KINDS = new Set(["read", "search", "think", "fetch"]);
const EDIT_KINDS = new Set(["edit", "delete", "move"]);

/**
 * The option to pick on its own for a session/request_permission, or null when the user must decide.
 * Full access allows everything (preferring "allow once": memento keeps no standing grants for the agent);
 * auto-accept edits also allows file changes; "auto" allows what only reads; supervised asks for all.
 */
export function autoPermissionOption(options: PermissionOption[], toolKind: string, mode: PermissionMode): string | null {
  const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
  if (!allow) return null;
  const kind = toolKind.toLowerCase();
  if (mode === "full") return allow.optionId;
  if (mode === "supervised") return null;
  if (READ_ONLY_KINDS.has(kind)) return allow.optionId;
  if (mode === "auto_edits" && EDIT_KINDS.has(kind)) return allow.optionId;
  return null;
}

/** The option matching what the user chose on the approval card ("允许" / "本次都允许 …" / anything else = no). */
export function chosenPermissionOption(options: PermissionOption[], answer: string): { optionId: string; allowAll: boolean } | null {
  const a = answer.trim();
  const allowAll = a.startsWith("本次都允许");
  if (a === "允许" || allowAll) {
    const o = allowAll
      ? options.find((x) => x.kind === "allow_always") ?? options.find((x) => x.kind === "allow_once")
      : options.find((x) => x.kind === "allow_once") ?? options.find((x) => x.kind === "allow_always");
    return o ? { optionId: o.optionId, allowAll } : null;
  }
  const no = options.find((x) => x.kind === "reject_once") ?? options.find((x) => x.kind === "reject_always");
  return no ? { optionId: no.optionId, allowAll: false } : null;
}

/** One line for a tool call: its title, else what it touches. */
export function toolDetail(tc: Json): string {
  const title = str(tc.title);
  const loc = Array.isArray(tc.locations) && isObj(tc.locations[0]) ? str(tc.locations[0].path) : "";
  const raw = isObj(tc.rawInput) ? tc.rawInput : {};
  const cmd = str(raw.command) || (Array.isArray(raw.command) ? raw.command.join(" ") : "");
  return clip(title || cmd || loc || str(tc.kind) || "tool", 300);
}

/** Text of a tool call's content blocks (its output), for the timeline. */
export function toolOutput(tc: Json): string {
  if (!Array.isArray(tc.content)) return "";
  const parts: string[] = [];
  for (const c of tc.content) {
    if (!isObj(c)) continue;
    if (c.type === "content" && isObj(c.content) && typeof c.content.text === "string") parts.push(c.content.text);
    else if (c.type === "diff") parts.push(`改动 ${str(c.path)}`);
  }
  return clip(parts.join("\n").trim(), 4000);
}

export interface UpdateState {
  /** Tool calls seen, with the name they were opened under */
  tools: Map<string, string>;
}

/** A session/update notification as memento agent events (none for kinds memento doesn't show). */
export function updateToEvents(update: Json, state: UpdateState): Json[] {
  const kind = str(update.sessionUpdate);
  switch (kind) {
    case "agent_message_chunk": {
      const text = isObj(update.content) ? str(update.content.text) : "";
      return text ? [{ kind: "text_delta", text }] : [];
    }
    case "agent_thought_chunk": {
      const text = isObj(update.content) ? str(update.content.text) : "";
      return text ? [{ kind: "thinking", text }] : [];
    }
    case "tool_call": {
      const id = str(update.toolCallId);
      if (!id) return [];
      const name = str(update.kind) || "tool";
      state.tools.set(id, name);
      const status = str(update.status);
      const done = status === "completed" || status === "failed";
      return [{
        kind: "tool",
        id,
        name,
        detail: toolDetail(update),
        status: status === "failed" ? "failed" : done ? "done" : "running",
        ...(done && toolOutput(update) ? { output: toolOutput(update) } : {}),
      }];
    }
    case "tool_call_update": {
      const id = str(update.toolCallId);
      if (!id) return [];
      const status = str(update.status);
      if (status !== "completed" && status !== "failed") {
        return update.title ? [{ kind: "tool", id, detail: toolDetail(update), status: "running" }] : [];
      }
      const out = toolOutput(update);
      return [{ kind: "tool", id, status: status === "failed" ? "failed" : "done", ...(out ? { output: out } : {}) }];
    }
    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries.filter(isObj) : [];
      if (!entries.length) return [];
      const lines = entries.map((e) => `${str(e.status) === "completed" ? "☑" : "☐"} ${str(e.content)}`);
      return [{ kind: "thinking", text: `计划：\n${lines.join("\n")}\n` }];
    }
    default:
      return [];
  }
}
