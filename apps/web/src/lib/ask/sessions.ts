import type { ToolCallItem } from "@/components/ExecutionCard";
import type { SessionResumeCost } from "@/lib/api-client";
import type { Turn } from "@/lib/ask/turns";

/** An agent session as the session picker lists it. */
export interface AgentSessionItem {
  session_id: string;
  title: string;
  conversation_id: string;
  message_count: number;
  timestamp: string;
  file_size_bytes?: number;
  estimated_tokens?: number;
  compact_recommended?: boolean;
  resume?: SessionResumeCost | null;
  device_id?: string | null;
  device_name?: string | null;
  messages?: Array<{
    role: string;
    content: string;
    timestamp?: string;
    raw_type?: string;
    subagent_name?: string;
  }>;
}

/** "约 66 万 token" / "~664k tokens" */
export function formatContextTokens(n: number, zh: boolean): string {
  if (!zh) return `~${Math.max(1, Math.round(n / 1000))}k tokens`;
  return n >= 10_000 ? `约 ${Math.round(n / 10_000)} 万 token` : `约 ${Math.max(1, Math.round(n / 1000))} 千 token`;
}

/** A title the agent gave a session before anything was said in it, so not worth showing. */
export function isJunkSessionTitle(val?: string): boolean {
  if (!val) return true;
  const low = val.trim().toLowerCase();
  return !low || low === "start" || low.startsWith("starting the conversation") || low.startsWith("starting conversation") || low === "新对话" || low === "untitled";
}

/**
 * What the resume banner says about cost: the first step re-caching everything after the hour the cache
 * lasts, and for a heavy session what raw vs compact resume means.
 */
export function resumeCostNotes(
  cost: SessionResumeCost | null | undefined,
  compactMode: boolean,
  zh: boolean,
): string[] {
  if (!cost) return [];
  const sizeText = formatContextTokens(cost.context_tokens, zh);
  const notes: string[] = [];
  if (zh) {
    if (cost.cache_cold && cost.heavy) {
      notes.push(`已超过 1 小时没用，缓存已过期，第一步要重新缓存全部上下文（${sizeText}）。`);
    }
    if (cost.heavy) {
      notes.push(compactMode
        ? "这次从核心记忆快照新开一个会话接着做，之后都在新会话里原样继续。"
        : `接着在原会话里做，上下文由 Claude Code 按模型自己的大小压缩，不会新开会话；每一步都带着全部上下文（${sizeText}）。`);
    }
  } else {
    if (cost.cache_cold && cost.heavy) notes.push(`Idle for over an hour: the cache has expired, the first step re-caches ${sizeText}.`);
    if (cost.heavy) notes.push(compactMode
      ? "A new session starts from a snapshot; later turns go on in it in place."
      : `It goes on in the same session, compacted by Claude Code by its model's own context; each step carries ${sizeText}.`);
  }
  return notes;
}

/** How many of a session's latest messages show when the conversation continuing it has no turns of its own yet */
export const SESSION_PREVIEW_MESSAGES = 100;

/** A collected session's message, as /api/conversations/{id}/messages returns it. */
export interface SessionMessage {
  role?: string | null;
  content?: string | null;
  images?: string[] | null;
  thinking?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  raw_type?: string | null;
  timestamp?: string | null;
  created_at?: string | null;
}

type GetMessages = (
  id: string,
  offset: number,
  limit: number,
) => Promise<{ total: number; messages: SessionMessage[] } | null | undefined>;

/**
 * A session's latest `limit` messages, oldest first. The endpoint pages from the start, so a long
 * session's first page is only its opening (seen 2026-11-12: a 1021-message session showed its first
 * evening, not that day's work).
 */
export async function fetchLatestSessionMessages(
  getMessages: GetMessages,
  documentId: string,
  limit = SESSION_PREVIEW_MESSAGES,
): Promise<SessionMessage[]> {
  let page = await getMessages(documentId, 0, limit);
  if (page && page.total > limit) {
    page = await getMessages(documentId, page.total - limit, limit);
  }
  return page?.messages || [];
}

/** Legacy "[Tool: <name>]\n<input>" blocks embedded in an assistant message's text. */
function parseLegacyToolContent(text: string) {
  const toolIdx = text.indexOf("[Tool:");
  if (toolIdx === -1) return null;
  const preText = text.slice(0, toolIdx).trim();
  const match = text.slice(toolIdx).match(/^\[Tool:\s*([^\]]+)\]\s*([\s\S]*)$/);
  if (!match) return null;
  const name = match[1].trim();
  const inputStr = match[2].trim();
  let command = inputStr;
  try {
    const parsed = JSON.parse(inputStr);
    if (typeof parsed === "object" && parsed !== null && parsed.command) command = parsed.command;
  } catch {}
  return { preText, name, command };
}

/**
 * A collected tool call's input as an object. Claude Code / Codex store JSON; Antigravity's collector
 * stores the Python repr of its args dict ({'CommandLine': '"cd …"', …}), each value itself a JSON
 * string. That repr went on the card as is (seen 2026-11-14).
 */
export function parseToolInput(raw: string | null | undefined): Record<string, unknown> | null {
  const text = (raw || "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {}
  if (!text.startsWith("{'")) return null;
  const out: Record<string, unknown> = {};
  const pair = /'([A-Za-z_][\w]*)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+(?:\.\d+)?|True|False|None))/g;
  for (const m of text.matchAll(pair)) {
    const quoted = m[2] ?? m[3];
    if (quoted === undefined) {
      const lit = m[4];
      out[m[1]] = lit === "True" ? true : lit === "False" ? false : lit === "None" ? null : Number(lit);
      continue;
    }
    let value = quoted.replace(/\\(\\|'|"|n|t|r)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c));
    // Antigravity args are JSON-encoded strings inside the repr
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        const inner = JSON.parse(value);
        if (typeof inner === "string") value = inner;
      } catch {}
    }
    out[m[1]] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Keys that say what a tool call is about, in the order worth showing (as the daemon's live timeline). */
const TOOL_DETAIL_KEYS = [
  "command", "cmd", "CommandLine", "Command",
  "file_path", "notebook_path", "path", "filePath", "file", "target_file", "TargetFile", "AbsolutePath", "Path", "File",
  "url", "Url", "query", "Query", "q", "pattern", "Pattern", "SearchPath", "DirectoryPath",
  "description", "skill", "name", "title", "prompt", "message",
];

/** What a collected tool call works on, as one line for its card; the raw input when nothing tells. */
export function toolCallDetail(raw: string | null | undefined): string {
  const args = parseToolInput(raw);
  if (!args) return (raw || "").trim();
  for (const k of TOOL_DETAIL_KEYS) {
    const v = args[k];
    if (typeof v !== "string" || !v.trim()) continue;
    let detail = v.trim();
    const from = args.StartLine;
    const to = args.EndLine;
    if (/path|file/i.test(k) && (typeof from === "string" || typeof from === "number") && String(from)) {
      detail += to !== undefined && String(to) ? `:${from}-${to}` : `:${from}`;
    }
    return detail;
  }
  // An MCP call names its server and tool; its arguments are a JSON string
  const tool = typeof args.ToolName === "string" ? args.ToolName : typeof args.tool_name === "string" ? args.tool_name : "";
  if (tool) {
    const server = typeof args.ServerName === "string" ? args.ServerName : typeof args.server_name === "string" ? args.server_name : "";
    const callArgs = typeof args.Arguments === "string" ? args.Arguments : typeof args.arguments === "string" ? args.arguments : "";
    return [[server, tool].filter(Boolean).join("/"), callArgs].filter(Boolean).join("  ");
  }
  // Else a few short values, never the repr itself
  const pairs = Object.entries(args)
    .filter(([k, v]) => !/^(toolSummary|toolAction|WaitMsBeforeAsync|SafeToAutoRun)$/.test(k) && (typeof v === "string" || typeof v === "number") && String(v).trim())
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).length > 120 ? `${String(v).slice(0, 120)}…` : v}`);
  return pairs.length > 0 ? pairs.join("  ") : (raw || "").trim();
}

/**
 * A collected tool output without Antigravity's step header ("Created At: …", "Completed At: …",
 * "Command exited with code N.", "Command output:"); the exit code comes back separately.
 */
export function cleanToolOutput(text: string): { stdout: string; exitCode: number } {
  let rest = text.replace(/\r\n/g, "\n");
  let exitCode = 0;
  for (;;) {
    const m = rest.match(/^\s*(?:Created At|Completed At):[^\n]*\n?/);
    if (!m) break;
    rest = rest.slice(m[0].length);
  }
  const exited = rest.match(/^\s*Command exited with code (-?\d+)\.?[^\n]*\n?/);
  if (exited) {
    exitCode = Number(exited[1]) || 0;
    rest = rest.slice(exited[0].length);
    rest = rest.replace(/^\s*Command output:[^\n]*\n?/, "");
  }
  return { stdout: rest.replace(/^\n+/, "").replace(/\s+$/, ""), exitCode };
}

/** A session's messages as conversation turns: tool calls and their output go on the assistant turn before them. */
export function sessionMessagesToTurns(messages: SessionMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    let role = m.role || "user";
    let content = m.content || "";
    const rawType = m.raw_type || "";
    const msgTime = m.timestamp || m.created_at || undefined;

    // Legacy [Result] on the user role is tool output
    if (role === "user" && content.startsWith("[Result]")) {
      role = "tool";
      content = content.replace(/^\[Result\]\s*/, "");
    }
    const legacyCall = role === "assistant" ? parseLegacyToolContent(content) : null;
    if (legacyCall) {
      content = legacyCall.preText;
      role = content ? "assistant" : "tool";
    }

    if (role === "user") {
      // Tool/meta noise never shows as the user's words
      if (content.startsWith("[Tool:") || content.startsWith("[Result]") || content.startsWith('{"tool_use_id"')) {
        continue;
      }
      turns.push({ role: "user", content, images: m.images || undefined, created_at: msgTime });
    } else if (role === "assistant") {
      const toolCalls: ToolCallItem[] = [];
      if (legacyCall) {
        toolCalls.push({ name: legacyCall.name, args: { command: legacyCall.command } });
      } else if (m.tool_name) {
        toolCalls.push({ name: m.tool_name, args: m.tool_input ? { command: toolCallDetail(m.tool_input) } : {} });
      }
      const prevTurn = turns[turns.length - 1];
      turns.push({
        role: "assistant",
        content,
        thinking: m.thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        created_at: msgTime,
        started_at: prevTurn?.role === "user" ? prevTurn.created_at : undefined,
      });
    } else if (role === "tool") {
      let lastTurn = turns[turns.length - 1];
      if (!lastTurn || lastTurn.role !== "assistant") {
        lastTurn = {
          role: "assistant",
          content: "",
          toolCalls: [],
          created_at: msgTime,
          started_at: lastTurn?.role === "user" ? lastTurn.created_at : undefined,
        };
        turns.push(lastTurn);
      } else if (msgTime) {
        lastTurn.created_at = msgTime;
      }
      if (!lastTurn.toolCalls) lastTurn.toolCalls = [];

      if (legacyCall) {
        lastTurn.toolCalls.push({ name: legacyCall.name, args: { command: legacyCall.command } });
      } else if (rawType === "tool_call" || m.tool_name) {
        lastTurn.toolCalls.push({ name: m.tool_name || "tool", args: m.tool_input ? { command: toolCallDetail(m.tool_input) } : {} });
      } else {
        // Tool output goes on the latest call
        const { stdout, exitCode } = cleanToolOutput(content);
        const result = { stdout, status: exitCode === 0 ? "succeeded" : "failed", exit_code: exitCode };
        const lastCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1];
        if (lastCall) lastCall.result = result;
        else lastTurn.toolCalls.push({ name: "tool", args: {}, result });
      }
    }
  }
  return turns;
}
