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
 * What the resume banner says about cost: the first step re-caching everything (right after another
 * client, or after the hour the cache lasts), and for a heavy session what raw vs compact resume means.
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
    if (cost.other_client_recent) {
      notes.push(`${cost.minutes_since_activity ?? 0} 分钟前刚在 ${cost.last_client} 里用过：两边的缓存不通用，第一步要重新缓存全部上下文（${sizeText}）。`);
    } else if (cost.cache_cold && cost.heavy) {
      notes.push(`已超过 1 小时没用，缓存已过期，第一步要重新缓存全部上下文（${sizeText}）。`);
    }
    if (cost.heavy) {
      notes.push(compactMode
        ? "这次从核心记忆快照新开一个会话接着做，之后都在新会话里原样继续。"
        : `接着在原会话里做，上下文由 Claude Code 按模型自己的大小压缩，不会新开会话；每一步都带着全部上下文（${sizeText}）。`);
    }
  } else {
    if (cost.other_client_recent) notes.push(`Used in ${cost.last_client} ${cost.minutes_since_activity ?? 0} min ago: caches aren't shared, the first step re-caches ${sizeText}.`);
    else if (cost.cache_cold && cost.heavy) notes.push(`Idle for over an hour: the cache has expired, the first step re-caches ${sizeText}.`);
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
        toolCalls.push({ name: m.tool_name, args: m.tool_input ? { command: m.tool_input } : {} });
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
        lastTurn.toolCalls.push({ name: m.tool_name || "tool", args: m.tool_input ? { command: m.tool_input } : {} });
      } else {
        // Tool output goes on the latest call
        const result = { stdout: content, status: "succeeded", exit_code: 0 };
        const lastCall = lastTurn.toolCalls[lastTurn.toolCalls.length - 1];
        if (lastCall) lastCall.result = result;
        else lastTurn.toolCalls.push({ name: "tool", args: {}, result });
      }
    }
  }
  return turns;
}
