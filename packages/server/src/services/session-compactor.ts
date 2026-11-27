// Hierarchical sliding-window context compaction & session stats (server/server/services/session_compactor.py).
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { conversationMessages, documents } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import { callPlainChat, getAiProviders } from "./ai-provider";
import { resumeCost, sessionActivity } from "./claude-session";
import { parseConversation } from "./conversation-parser";

const BASE64_DATA_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{60,}/gi;
const RAW_BASE64_BLOB_RE = /[A-Za-z0-9+/]{120,}={0,2}/g;
const FILE_PATH_RE = /(?:^|[\s"'`(])((?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9_]{1,10})(?:$|[\s"'`)])/g;
const CC_SUMMARY_MARK = "This session is being continued from a previous conversation";
const CC_SUMMARY_TAIL_RE = /\n\s*If you need specific details from before compaction[\s\S]*$/;
const INJECTED_CONTEXT_RE = /^【前序会话核心记忆快照[\s\S]*?当前用户指令[：:]\s*/;
const INJECTED_HEAD_RE = /^【前序会话核心记忆快照[^】]*】\s*/;
const INJECTED_RULES_MARK = "【执行规则】";
const INJECTED_PROMPT_RE = /\n\s*当前用户指令[：:]\s*/;
const NOISE_TAG_RE = /<system-reminder>[\s\S]*?<\/system-reminder>|<artifact-content-authored-by-others\/>/g;
const THINKING_TYPES = new Set(["pb_thinking", "reasoning", "thinking"]);

const DIGEST_DETAIL_CHARS = 24_000;
const DIGEST_OUTLINE_CHARS = 8_000;
const EARLIER_SUMMARY_CHARS = 12_000;
const RECENT_USER_CHARS = 1_500;
const RECENT_REPLY_CHARS = 1_500;
const RECENT_LAST_REPLY_CHARS = 4_000;
const RECENT_DROPPED_CHARS = 2_000;
const OVERFLOW_CONTEXT_TOKENS = 500_000;

export interface SessionStats {
  session_id: string;
  message_count: number;
  char_count: number;
  estimated_tokens: number;
  file_size_bytes: number;
  base64_blobs_found: number;
  status: "normal" | "heavy" | "overflow_risk";
  compact_recommended: boolean;
  resume: Record<string, unknown>;
}

export interface CompactMessage {
  role: string;
  content: string;
  thinking?: string | null;
  timestamp?: string | null;
  raw_type?: string;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) cjk++;
  }
  const other = text.length - cjk;
  return Math.trunc(cjk * 1.5 + other / 3.5);
}

export function calculateSessionStats(sessionId: string, messages: CompactMessage[], fileSizeBytes = 0): SessionStats {
  let totalChars = 0;
  let estTokens = 0;
  let base64Blobs = 0;
  for (const m of messages) {
    const combined = `${m.content || ""}\n${m.thinking || ""}`;
    totalChars += combined.length;
    estTokens += estimateTokens(combined);
    const blobs = combined.match(BASE64_DATA_RE);
    if (blobs) base64Blobs += blobs.length;
    else if (combined.length > 5000) base64Blobs += (combined.match(RAW_BASE64_BLOB_RE) ?? []).length;
  }
  const isOverflow = estTokens > 90_000 || fileSizeBytes > 700_000 || messages.length > 80;
  const isHeavy = (estTokens > 35_000 || fileSizeBytes > 300_000 || messages.length > 35) && !isOverflow;
  const status: SessionStats["status"] = isOverflow ? "overflow_risk" : isHeavy ? "heavy" : "normal";
  return {
    session_id: sessionId,
    message_count: messages.length,
    char_count: totalChars,
    estimated_tokens: estTokens,
    file_size_bytes: fileSizeBytes,
    base64_blobs_found: base64Blobs,
    status,
    compact_recommended: status !== "normal",
    resume: {},
  };
}

export function pruneMessagePayloads(messages: CompactMessage[], maxToolOutputChars = 800): CompactMessage[] {
  return messages.map((m) => {
    let content = (m.content || "").replace(BASE64_DATA_RE, "[图片附件: base64 数据已在历史记录中处理]");
    if (content.length > 3000) content = content.replace(RAW_BASE64_BLOB_RE, "[二进制/Base64数据已省略]");
    if ((m.role === "tool" || m.role === "system" || m.raw_type === "tool_output" || m.raw_type === "tool_result") && content.length > maxToolOutputChars) {
      const half = Math.floor(maxToolOutputChars / 2);
      content = `${content.slice(0, half)}\n\n...[历史工具长输出截断，省略 ${content.length - maxToolOutputChars} 字符]...\n\n${content.slice(-half)}`;
    }
    let thinking = m.thinking;
    if (thinking && thinking.length > 1000) thinking = `${thinking.slice(0, 1000)}...[思考链已精简]`;
    return { ...m, content, ...(thinking !== undefined ? { thinking } : {}) };
  });
}

export function isDialogue(m: CompactMessage): boolean {
  if ((m.role !== "user" && m.role !== "assistant") || THINKING_TYPES.has(m.raw_type ?? "")) return false;
  const c = m.content || "";
  return Boolean(c.trim()) && !c.startsWith("[Tool:") && !c.startsWith("[Result]");
}

function isCcSummary(m: CompactMessage): boolean {
  return m.role === "user" && (m.content || "").slice(0, 2000).includes(CC_SUMMARY_MARK);
}

function cleanText(content: string): string {
  return content.replace(INJECTED_CONTEXT_RE, "").replace(NOISE_TAG_RE, "").trim();
}

function clipHeadTail(text: string, limit: number): string {
  const s = text.trim();
  if (s.length <= limit) return s;
  const half = Math.floor(limit / 2);
  return `${s.slice(0, half)}\n…[省略 ${s.length - limit} 字]…\n${s.slice(-half)}`;
}

function stampUtc8(ts: string | null | undefined): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  const d = new Date(t + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function splitInjectedContext(content: string): [string, string] | null {
  if (!INJECTED_HEAD_RE.test(content)) return null;
  const rules = content.indexOf(INJECTED_RULES_MARK);
  let carried: string;
  let prompt: string;
  if (rules >= 0) {
    const tail = content.slice(rules);
    const ask = INJECTED_PROMPT_RE.exec(tail);
    carried = content.slice(0, rules);
    prompt = ask ? tail.slice(ask.index + ask[0].length) : "";
  } else {
    const m = INJECTED_CONTEXT_RE.exec(content);
    if (!m) return null;
    carried = content.slice(0, m[0].length).replace(INJECTED_PROMPT_RE, "");
    prompt = content.slice(m[0].length);
  }
  return [carried.replace(INJECTED_HEAD_RE, "").trim(), prompt.trim()];
}

function splitAtLatestSummary(messages: CompactMessage[]): [string, string, CompactMessage[]] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (isCcSummary(m)) {
      const text = m.content || "";
      const pos = text.indexOf("Summary:");
      const body = pos >= 0 ? text.slice(pos + "Summary:".length) : text.slice(text.indexOf(CC_SUMMARY_MARK));
      return [body.replace(CC_SUMMARY_TAIL_RE, "").trim(), stampUtc8(m.timestamp), messages.slice(i + 1)];
    }
    if (m.role === "user") {
      const inj = splitInjectedContext(m.content || "");
      if (inj && inj[0]) {
        const [carried, prompt] = inj;
        const rest = messages.slice(i + 1);
        return [carried, stampUtc8(m.timestamp), prompt ? [{ ...m, content: prompt }, ...rest] : rest];
      }
    }
  }
  return ["", "", messages];
}

function splitSlidingWindow(messages: CompactMessage[], recentTurns = 6): [CompactMessage[], CompactMessage[]] {
  const users: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user" && !isCcSummary(messages[i]!)) users.push(i);
  }
  if (users.length <= recentTurns) return [[], [...messages]];
  const splitIdx = users[users.length - recentTurns]!;
  return [messages.slice(0, splitIdx), messages.slice(splitIdx)];
}

function buildDigest(messages: CompactMessage[]): string {
  const detail: string[] = [];
  const outline: string[] = [];
  let used = 0;
  let i = messages.length - 1;
  while (i >= 0) {
    const m = messages[i]!;
    const text = cleanText(m.content || "").replace(/\s+/g, " ").trim();
    if (text) {
      const line =
        m.role === "user"
          ? `[${stampUtc8(m.timestamp)}] 用户: ${text.slice(0, 600)}`
          : `[${stampUtc8(m.timestamp)}] 助手: ${text.slice(0, i === messages.length - 1 || messages[i + 1]!.role === "user" ? 1200 : 240)}`;
      if (used + line.length > DIGEST_DETAIL_CHARS) break;
      detail.push(line);
      used += line.length;
    }
    i--;
  }
  used = 0;
  let dropped = 0;
  while (i >= 0) {
    const m = messages[i]!;
    if (m.role === "user") {
      const text = cleanText(m.content || "").replace(/\s+/g, " ").trim();
      if (text) {
        const line = `[${stampUtc8(m.timestamp)}] 用户: ${text.slice(0, 160)}`;
        if (used + line.length > DIGEST_OUTLINE_CHARS) {
          dropped = i + 1;
          break;
        }
        outline.push(line);
        used += line.length;
      }
    }
    i--;
  }
  const parts: string[] = [];
  if (dropped) parts.push(`…（更早的 ${dropped} 条消息已省略）`);
  if (outline.length) {
    parts.push("（较早阶段：只保留用户指令）");
    parts.push(...outline.reverse());
    parts.push("（最近阶段：用户与助手的对话）");
  }
  parts.push(...detail.reverse());
  return parts.join("\n");
}

function recentFiles(messages: CompactMessage[], extra = "", limit = 15): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const texts = [...messages].reverse().map((m) => m.content || "");
  texts.push(extra);
  for (const text of texts) {
    for (const m of text.matchAll(FILE_PATH_RE)) {
      const f = m[1]!;
      if (f.includes("/") && !f.startsWith("http") && f.length < 80 && !seen.has(f)) {
        seen.add(f);
        found.push(f);
        if (found.length >= limit) return found;
      }
    }
  }
  return found;
}

function renderRecent(messages: CompactMessage[]): string[] {
  const dialogue = messages.filter((m) => isDialogue(m) && !isCcSummary(m));
  const kept = dialogue.filter((m, i) => m.role === "user" || i === dialogue.length - 1 || dialogue[i + 1]!.role === "user");
  const lines: string[] = [];
  kept.forEach((m, i) => {
    const isUser = m.role === "user";
    const limit = isUser ? RECENT_USER_CHARS : i === kept.length - 1 ? RECENT_LAST_REPLY_CHARS : RECENT_REPLY_CHARS;
    const text = clipHeadTail(cleanText(m.content || ""), limit);
    if (text) {
      const stamp = stampUtc8(m.timestamp);
      lines.push(`- ${stamp ? `[${stamp}] ` : ""}${isUser ? "用户" : "助手"}: ${text}`);
    }
  });
  return lines;
}

function recentDropsContent(messages: CompactMessage[]): boolean {
  const said = messages
    .filter((m) => isDialogue(m) && !isCcSummary(m))
    .reduce((acc, m) => acc + cleanText(m.content || "").length, 0);
  const kept = renderRecent(messages).reduce((acc, l) => acc + l.length, 0);
  return said - kept > RECENT_DROPPED_CHARS;
}

async function generateCheckpointSummary(
  settings: Settings,
  redis: Redis | null,
  user: UserRow | null,
  messages: CompactMessage[],
  sessionTitle = "",
  toolId = "",
  earlierSummary = "",
  earlierUntil = "",
): Promise<string> {
  if (!messages.length && !earlierSummary) return "";
  const stamps = messages.map((m) => stampUtc8(m.timestamp)).filter(Boolean);
  const span = stamps.length ? `${stamps[0]} ~ ${stamps[stamps.length - 1]}` : "未知";
  const files = recentFiles(messages, earlierSummary);
  const fileHints = files.length ? files.join(", ") : "未显式指定";

  if (getAiProviders(settings, { user }).length) {
    const sections: string[] = [];
    if (earlierSummary) {
      sections.push(`【第一部分：截至 ${earlierUntil || "压缩时"} 的早期历史摘要】\n${clipHeadTail(earlierSummary, EARLIER_SUMMARY_CHARS)}`);
    }
    if (messages.length) {
      const label = earlierSummary ? "第二部分：之后的对话流水" : "对话流水";
      sections.push(`【${label}（按时间先后排列，越往后越新）】\n${buildDigest(messages)}`);
    }
    const prompt = `你是一个高级 AI 编程会话记忆提炼专家。
请把下面这个 AI 编程会话的历史提炼成一份高密度、结构化的「核心记忆快照（Context Checkpoint）」，交给接手的新会话继续工作。

会话主题：${sessionTitle || "未知任务"}
工具环境：${toolId || "通用 Agent"}
时间跨度：${span}（共 ${messages.length} 条对话消息${earlierSummary ? "，另有更早历史见第一部分" : ""}）
最近涉及的文件：${fileHints}

${sections.join("\n\n")}

【要求】
1) 以最新进展为准：后面的内容覆盖前面的；已经完成、已经上线的事项不要写成进行中或待办。
2) 「当前遗留状态与未决问题」只写会话最后阶段仍未完成的事、用户最后的指令和还没回答的问题。
3) 保留关键文件路径、提交号、版本号、命令和用户明确提出的要求；不要写入密钥、口令、Token 的具体值。
4) 用中文、Markdown，控制在 600-1000 字。

【输出格式】
### 核心记忆快照 (Context Checkpoint)
- 任务核心目标：整个会话要达成什么，最近一段在做什么。
- 已完成的关键工作与进展：按时间列出关键修复或开发及结果（提交号、上线版本）。
- 修改/涉及的关键文件：核心改动或关注的文件路径及主要修改内容。
- 关键决议与技术约定：架构方案、环境参数、避坑要点、用户定下的规矩。
- 当前遗留状态与未决问题：会话最后停在哪里，还有什么没做完。
`;
    try {
      const summary = await callPlainChat(
        settings,
        redis,
        [
          { role: "system", content: "你擅长提炼高密度的技术上下文记忆快照，语言精炼准确，保留关键技术细节与文件名。" },
          { role: "user", content: prompt },
        ],
        { user, temperature: 0.2, maxTokens: 2000, timeoutSec: 90 },
      );
      if (summary && summary.trim()) return summary.trim();
    } catch {
      /* heuristic fallback */
    }
  }

  const userPrompts = messages
    .filter((m) => m.role === "user")
    .map((m) => cleanText(m.content || "").replace(/\s+/g, " ").trim().slice(0, 200))
    .filter(Boolean);
  const initialGoal = userPrompts[0] ?? "无明确初始目标";
  let md = `### 核心记忆快照 (Context Checkpoint)\n- 任务核心目标：${initialGoal}\n- 涉及核心文件：${fileHints}\n- 前序轮次总结：该会话前序已交互 ${messages.length} 条对话消息（${span}）。`;
  if (userPrompts.length > 1) {
    const latest = userPrompts
      .slice(-3)
      .map((p, idx) => `${idx + 1}) ${p}`)
      .join("；");
    md += `\n- 最近的用户指令：${latest}`;
  }
  if (earlierSummary) {
    md += `\n- 更早历史（截至 ${earlierUntil || "压缩时"} 的摘要）：\n${clipHeadTail(earlierSummary, 4000)}`;
  }
  return md;
}

function formatInjectedContext(checkpointSummary: string, recentMessages: CompactMessage[], originalSessionId = ""): string {
  const parts: string[] = [];
  const sidHint = originalSessionId ? `（原会话 ID: ${originalSessionId.slice(0, 8)}...）` : "";
  parts.push(`【前序会话核心记忆快照${sidHint}】`);
  parts.push(checkpointSummary ? checkpointSummary.trim() : "*(前序会话较短，内容都在下面的最近上下文里)*");
  const recent = renderRecent(recentMessages);
  if (recent.length) {
    parts.push("\n【承接前序会话的最近上下文（保持精确细节）】");
    parts.push(...recent);
  }
  parts.push("\n【执行规则】");
  parts.push("你已完整继承以上前序会话的全部背景、修改记录和决议。请紧密结合前序上下文，直接执行用户的最新指令，无需重复提问已知背景。");
  return parts.join("\n");
}

async function findSession(db: Db, sessionId: string, machineIds: string[] | null) {
  const mCond = machineIds !== null ? (machineIds.length ? inArray(documents.machineId, machineIds) : sql`false`) : sql`true`;
  const [byMeta] = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      title: documents.title,
      machineId: documents.machineId,
      fileSizeBytes: documents.fileSizeBytes,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(or(sql`${documents.metadata}->>'session_id' = ${sessionId}`, sql`${documents.metadata}->>'cascade_id' = ${sessionId}`), mCond))
    .orderBy(desc(documents.syncedAt))
    .limit(1);
  if (byMeta) return byMeta;
  const docUuid = normalizeUuid(sessionId);
  if (!docUuid) return null;
  const [byId] = await db
    .select({
      id: documents.id,
      toolId: documents.toolId,
      title: documents.title,
      machineId: documents.machineId,
      fileSizeBytes: documents.fileSizeBytes,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(and(eq(documents.id, docUuid), mCond))
    .limit(1);
  return byId ?? null;
}

async function claudeContext(db: Db, doc: { id: string; metadata: unknown }): Promise<Record<string, unknown>> {
  const meta = { ...((doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {}) as Record<string, unknown>) };
  if (!("context_tokens" in meta)) {
    const [tailRow] = await db
      .select({ tail: sql<string>`right(${documents.content}, 2000000)` })
      .from(documents)
      .where(eq(documents.id, doc.id))
      .limit(1);
    const found = sessionActivity(tailRow?.tail ?? "");
    if (Object.keys(found).length) {
      Object.assign(meta, found);
      await db.update(documents).set({ metadata: meta }).where(eq(documents.id, doc.id));
    }
  }
  return meta;
}

export async function sessionMachineId(db: Db, sessionId: string, machineIds: string[] | null = null): Promise<string | null> {
  const doc = await findSession(db, sessionId, machineIds);
  return doc?.machineId ?? null;
}

export async function claudeResumeCost(db: Db, settings: Settings, sessionId: string, machineIds: string[] | null = null): Promise<Record<string, unknown>> {
  const doc = await findSession(db, sessionId, machineIds);
  if (!doc || doc.toolId !== "claude_code") return {};
  return resumeCost(await claudeContext(db, doc), settings);
}

export async function getSessionStats(db: Db, settings: Settings, sessionId: string, machineIds: string[] | null = null): Promise<SessionStats> {
  const doc = await findSession(db, sessionId, machineIds);
  if (doc && doc.toolId === "claude_code") {
    const resume = resumeCost(await claudeContext(db, doc), settings);
    if (Object.keys(resume).length) {
      const tokens = Number(resume.context_tokens ?? 0);
      const status: SessionStats["status"] = tokens > OVERFLOW_CONTEXT_TOKENS ? "overflow_risk" : tokens > settings.sessionHeavyTokens ? "heavy" : "normal";
      const [cnt] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(conversationMessages)
        .where(eq(conversationMessages.documentId, doc.id));
      return {
        session_id: sessionId,
        message_count: Number(cnt?.c ?? 0),
        char_count: 0,
        estimated_tokens: tokens,
        file_size_bytes: doc.fileSizeBytes ?? 0,
        base64_blobs_found: 0,
        status,
        compact_recommended: status !== "normal",
        resume,
      };
    }
  }

  let messages: CompactMessage[] = [];
  let fileSizeBytes = 0;
  if (doc) {
    fileSizeBytes = doc.fileSizeBytes ?? 0;
    const rows = await db
      .select({ role: conversationMessages.role, content: conversationMessages.content, metadata: conversationMessages.metadata })
      .from(conversationMessages)
      .where(eq(conversationMessages.documentId, doc.id))
      .orderBy(asc(conversationMessages.lineNumber));
    if (rows.length) {
      messages = rows
        .filter((r) => Boolean(r.content))
        .map((r) => ({
          role: r.role || "user",
          content: r.content,
          thinking: ((r.metadata as Record<string, unknown> | null)?.thinking as string | undefined) ?? null,
        }));
    } else {
      const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, doc.id)).limit(1);
      if (cRow?.content) {
        messages = parseConversation(cRow.content, doc.toolId)
          .filter((p) => Boolean(p.content))
          .map((p) => ({ role: p.role, content: p.content, thinking: p.thinking }));
      }
    }
  }
  return calculateSessionStats(sessionId, messages, fileSizeBytes);
}

export async function buildCompactedContinuation(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow | null,
  sessionId: string,
  newUserPrompt: string,
  recentTurns = 6,
  machineIds: string[] | null = null,
) {
  const doc = await findSession(db, sessionId, machineIds);
  if (!doc) {
    return {
      session_id: sessionId,
      title: sessionId.slice(0, 8),
      tool_id: "",
      stats: calculateSessionStats(sessionId, []),
      checkpoint: "",
      recent_messages: [],
      injected_context: "",
      new_prompt_with_context: newUserPrompt,
    };
  }
  const rows = await db
    .select({
      role: conversationMessages.role,
      content: conversationMessages.content,
      timestamp: conversationMessages.timestamp,
      messageType: conversationMessages.messageType,
    })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.documentId, doc.id), inArray(conversationMessages.role, ["user", "assistant"])))
    .orderBy(asc(conversationMessages.lineNumber));
  let messages: CompactMessage[];
  if (rows.length) {
    messages = rows.map((r) => ({
      role: r.role || "user",
      content: r.content,
      timestamp: pgToIso(r.timestamp),
      raw_type: r.messageType || "",
    }));
  } else {
    const [cRow] = await db.select({ content: documents.content }).from(documents).where(eq(documents.id, doc.id)).limit(1);
    messages = cRow?.content
      ? parseConversation(cRow.content, doc.toolId).map((p) => ({
          role: p.role,
          content: p.content,
          timestamp: p.timestamp || null,
          raw_type: p.rawType,
        }))
      : [];
  }
  messages = messages.filter(isDialogue);

  const stats = calculateSessionStats(sessionId, messages, doc.fileSizeBytes ?? 0);
  const pruned = pruneMessagePayloads(messages);
  const [earlier, earlierUntil, after] = splitAtLatestSummary(pruned);
  const [older, recent] = splitSlidingWindow(after, recentTurns);

  let checkpoint = "";
  if (older.length || earlier || recentDropsContent(recent)) {
    checkpoint = await generateCheckpointSummary(settings, redis, user, after, doc.title ?? "", doc.toolId || "claude_code", earlier, earlierUntil);
  }
  const injectedContext = formatInjectedContext(checkpoint, recent, sessionId);
  return {
    session_id: sessionId,
    title: doc.title || sessionId.slice(0, 8),
    tool_id: doc.toolId || "claude_code",
    stats,
    checkpoint,
    recent_messages: recent,
    injected_context: injectedContext,
    new_prompt_with_context: newUserPrompt ? `${injectedContext}\n\n当前用户指令：\n${newUserPrompt}` : injectedContext,
  };
}
