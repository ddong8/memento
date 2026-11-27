// Context budgeting, history compression & loop compaction for Ask/Orchestrator
// (server/server/services/orchestrator_context.py).
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import { callPlainChat } from "./ai-provider";
import { cleanText, estimateTokens } from "./session-compactor";

export const AI_CONTEXT_WINDOW_TOKENS = 128_000;
export const AI_HISTORY_BUDGET_TOKENS = 48_000;
export const AI_HISTORY_AUTO_COMPACT_TOKENS = 36_000;
export const AI_LOOP_BUDGET_TOKENS = 84_000;
export const AI_RECENT_VERBATIM_TURNS = 8;
export const AI_RECENT_TURN_MAX_CHARS = 6_000;
export const AI_TOOL_OUTPUT_OLD_MAX_CHARS = 800;

export interface HistoryTurn {
  role?: string;
  content?: string;
  thinking?: string;
  steps?: Record<string, unknown>[];
  created_at?: string | null;
  [k: string]: unknown;
}

export interface CompactState {
  summary?: string;
  covered_turns?: number;
  updated_at?: string;
  auto?: boolean;
}

const OVERFLOW_CUES = [
  "context_length_exceeded",
  "maximum context length",
  "context window",
  "too many tokens",
  "prompt is too long",
  "input is too long",
  "token limit",
  "max_prompt_tokens",
  "exceeds the maximum",
  "reduce the length of the messages",
  "request too large",
  "413",
];

export function isContextOverflowError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err ?? "").toLowerCase();
  return OVERFLOW_CUES.some((c) => msg.includes(c));
}

function messageTokens(msg: Record<string, unknown>): number {
  const content = msg.content;
  let chars = 0;
  if (typeof content === "string") {
    chars = estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p === "object") {
        const rec = p as Record<string, unknown>;
        if (typeof rec.text === "string") chars += estimateTokens(rec.text);
        else if (rec.type === "image_url") chars += 1000;
      }
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    chars += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  return chars + 12;
}

export function estimateMessagesTokens(messages: Record<string, unknown>[]): number {
  let total = 0;
  for (const m of messages) total += messageTokens(m);
  return total;
}

function summarizeTurnForCompaction(t: HistoryTurn): string {
  const role = t.role === "assistant" ? "助手" : "用户";
  const text = cleanText(String(t.content || "")).trim();
  const limit = role === "用户" ? 1200 : 1800;
  const clipped = text.length > limit ? `${text.slice(0, limit)}…` : text;
  const steps = Array.isArray(t.steps) && t.steps.length ? ` [调用了 ${t.steps.length} 步工具]` : "";
  return `${role}${steps}: ${clipped}`;
}

function heuristicSummary(turns: HistoryTurn[], prevSummary?: string): string {
  const lines: string[] = [];
  if (prevSummary?.trim()) lines.push(prevSummary.trim().slice(0, 3000));
  for (const t of turns.slice(-24)) {
    const line = summarizeTurnForCompaction(t);
    if (line.length > 6) lines.push(`- ${line.slice(0, 400)}`);
  }
  return lines.join("\n").slice(0, 6000);
}

export async function compactAiConversation(
  settings: Settings,
  redis: Redis | null,
  turns: HistoryTurn[],
  opts: {
    user?: { llmSettings?: unknown } | null;
    existingState?: CompactState | null;
    keepRecent?: number;
    instruction?: string | null;
  } = {},
): Promise<{
  summary: string;
  covered_turns: number;
  kept_turns: number;
  before_tokens: number;
  after_tokens: number;
  state: CompactState;
}> {
  const keepRecent = Math.max(2, opts.keepRecent ?? AI_RECENT_VERBATIM_TURNS);
  const beforeTokens = turns.reduce((acc, t) => acc + estimateTokens(String(t.content || "")), 0);
  if (turns.length <= keepRecent) {
    const summary = opts.existingState?.summary || "";
    const state: CompactState = { summary, covered_turns: 0, updated_at: new Date().toISOString() };
    return { summary, covered_turns: 0, kept_turns: turns.length, before_tokens: beforeTokens, after_tokens: beforeTokens, state };
  }

  const cutoff = turns.length - keepRecent;
  const prevCovered = Math.min(Math.max(0, Number(opts.existingState?.covered_turns ?? 0)), cutoff);
  const prevSummary = (opts.existingState?.summary || "").trim();
  const deltaTurns = turns.slice(prevCovered, cutoff);

  let summary = prevSummary;
  if (deltaTurns.length) {
    const transcript = deltaTurns.map(summarizeTurnForCompaction).join("\n").slice(0, 28_000);
    const prompt = [
      "请将以下多轮对话历史压缩为高密度、可无缝续接的结构化记忆摘要（中文 Markdown，不超过 2200 字）。",
      "必须保留：1) 核心目标与已定方案；2) 关键文件路径、命令、配置、实体名与精确结论；3) 已完成事项与未完成待办；4) 用户明确提出的要求或纠偏。",
      opts.instruction?.trim() ? `额外侧重：${opts.instruction.trim()}` : "",
      prevSummary ? `\n【已有前序摘要】\n${prevSummary}` : "",
      `\n【新增对话片段（共 ${deltaTurns.length} 条）】\n${transcript}`,
    ]
      .filter(Boolean)
      .join("\n");

    const aiOut = await callPlainChat(
      settings,
      redis,
      [
        { role: "system", content: "你是对话上下文压缩专家，精准提炼事实、结论、代码路径与约束，绝不编造。" },
        { role: "user", content: prompt },
      ],
      { temperature: 0.2, maxTokens: 2000, timeoutSec: 90, user: opts.user, background: true },
    );
    summary = aiOut?.trim() || heuristicSummary(deltaTurns, prevSummary);
  }

  const kept = turns.slice(cutoff);
  const afterTokens = estimateTokens(summary) + kept.reduce((acc, t) => acc + estimateTokens(String(t.content || "")), 0);
  const state: CompactState = {
    summary,
    covered_turns: cutoff,
    updated_at: new Date().toISOString(),
  };
  return {
    summary,
    covered_turns: cutoff,
    kept_turns: kept.length,
    before_tokens: beforeTokens,
    after_tokens: afterTokens,
    state,
  };
}

export function trimAiTurns(turns: HistoryTurn[], budgetTokens = AI_HISTORY_BUDGET_TOKENS): Record<string, unknown>[] {
  const selected: Record<string, unknown>[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    const role = t.role === "assistant" ? "assistant" : "user";
    let text = cleanText(String(t.content || "")).trim();
    if (!text) continue;
    if (text.length > AI_RECENT_TURN_MAX_CHARS) {
      text = `${text.slice(0, AI_RECENT_TURN_MAX_CHARS - 1200)}\n…[中间省略]…\n${text.slice(-1000)}`;
    }
    const tok = estimateTokens(text) + 12;
    if (used + tok > budgetTokens && selected.length >= 2) break;
    selected.unshift({ role, content: text });
    used += tok;
  }
  return selected;
}

export async function prepareAiHistory(
  settings: Settings,
  redis: Redis | null,
  turns: HistoryTurn[],
  opts: {
    user?: { llmSettings?: unknown } | null;
    compactState?: CompactState | null;
    budgetTokens?: number;
    autoCompact?: boolean;
  } = {},
): Promise<{
  messages: Record<string, unknown>[];
  summary: string | null;
  newCompactState: CompactState | null;
  autoCompacted: boolean;
}> {
  const budget = opts.budgetTokens ?? AI_HISTORY_BUDGET_TOKENS;
  let state = opts.compactState ?? null;
  let autoCompacted = false;

  const covered = Math.min(Math.max(0, Number(state?.covered_turns ?? 0)), turns.length);
  const uncovered = turns.slice(covered);
  const uncoveredTokens = uncovered.reduce((acc, t) => acc + estimateTokens(String(t.content || "")), 0);

  if (opts.autoCompact !== false && uncovered.length > AI_RECENT_VERBATIM_TURNS + 4 && uncoveredTokens > AI_HISTORY_AUTO_COMPACT_TOKENS) {
    try {
      const compacted = await compactAiConversation(settings, redis, turns, { user: opts.user, existingState: state });
      state = { ...compacted.state, auto: true };
      autoCompacted = true;
    } catch {
      /* fallback to trim */
    }
  }

  const finalCovered = Math.min(Math.max(0, Number(state?.covered_turns ?? 0)), turns.length);
  const summary = state?.summary?.trim() || null;
  const tail = turns.slice(finalCovered);
  const tailBudget = Math.max(8_000, budget - (summary ? estimateTokens(summary) + 100 : 0));
  const messages = trimAiTurns(tail, tailBudget);

  if (summary) {
    messages.unshift({
      role: "system",
      content: `【前序对话压缩摘要（涵盖前 ${finalCovered} 条消息）】\n${summary}`,
    });
  }

  return { messages, summary, newCompactState: autoCompacted ? state : null, autoCompacted };
}

export function compactLoopMessages(messages: Record<string, unknown>[], budgetTokens = AI_LOOP_BUDGET_TOKENS): Record<string, unknown>[] {
  if (estimateMessagesTokens(messages) <= budgetTokens) return messages;
  const out = messages.map((m) => ({ ...m }));

  // Pass 1: truncate older tool responses
  const keepTail = Math.min(6, out.length);
  for (let i = 1; i < out.length - keepTail; i++) {
    const m = out[i]!;
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > AI_TOOL_OUTPUT_OLD_MAX_CHARS) {
      m.content = `${m.content.slice(0, 500)}\n…[已压缩，原长 ${m.content.length} 字符]…\n${m.content.slice(-200)}`;
    }
  }
  if (estimateMessagesTokens(out) <= budgetTokens) return out;

  // Pass 2: drop middle history turns (keep system[0] + last 6)
  const head = out[0] ? [out[0]] : [];
  const tail = out.slice(-keepTail);
  let middle = out.slice(1, -keepTail);
  while (middle.length > 0 && estimateMessagesTokens([...head, ...middle, ...tail]) > budgetTokens) {
    middle = middle.slice(1);
  }
  return [...head, ...middle, ...tail];
}

export function buildAiContextStats(
  convId: string,
  turns: HistoryTurn[],
  compactState?: CompactState | null,
) {
  const covered = Math.min(Math.max(0, Number(compactState?.covered_turns ?? 0)), turns.length);
  const summary = (compactState?.summary || "").trim();
  const activeTurns = turns.slice(covered);
  let totalChars = summary.length;
  let estTokens = summary ? estimateTokens(summary) : 0;
  for (const t of activeTurns) {
    const c = String(t.content || "");
    totalChars += c.length;
    estTokens += estimateTokens(c);
  }
  const usagePct = Math.min(100, Math.round((estTokens / AI_CONTEXT_WINDOW_TOKENS) * 1000) / 10);
  const status = estTokens > AI_HISTORY_BUDGET_TOKENS ? "overflow_risk" : estTokens > AI_HISTORY_AUTO_COMPACT_TOKENS * 0.7 ? "heavy" : "normal";
  return {
    conversation_id: convId,
    message_count: turns.length,
    active_message_count: activeTurns.length,
    covered_turns: covered,
    has_summary: Boolean(summary),
    summary_chars: summary.length,
    char_count: totalChars,
    estimated_tokens: estTokens,
    budget_tokens: AI_HISTORY_BUDGET_TOKENS,
    window_tokens: AI_CONTEXT_WINDOW_TOKENS,
    usage_pct: usagePct,
    status,
    compact_recommended: status !== "normal",
    updated_at: compactState?.updated_at ?? null,
  };
}
