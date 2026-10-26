import type { SessionResumeCost } from "@/lib/api-client";

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
export function resumeCostNotes(cost: SessionResumeCost | null | undefined, compactMode: boolean, zh: boolean): string[] {
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
        ? "已默认改为智能瘦身续接：先生成核心记忆快照，再开新会话接着做；确实需要完整上下文时可切回原生接续。"
        : `原生接续后每执行一步都要带上全部上下文（${sizeText}），额度消耗远高于新会话，建议智能瘦身续接。`);
    }
  } else {
    if (cost.other_client_recent) notes.push(`Used in ${cost.last_client} ${cost.minutes_since_activity ?? 0} min ago: caches aren't shared, the first step re-caches ${sizeText}.`);
    else if (cost.cache_cold && cost.heavy) notes.push(`Idle for over an hour: the cache has expired, the first step re-caches ${sizeText}.`);
    if (cost.heavy) notes.push(compactMode
      ? "Resuming from a compacted snapshot by default; switch to raw resume when the full context is needed."
      : `Every raw-resume step carries ${sizeText} of history; compact resume is recommended.`);
  }
  return notes;
}
