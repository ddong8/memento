// User voice sanitization, batching & signal extraction for Dreaming & Learning (server/server/services/dreaming_voice.py).
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import type { Db } from "../db/client";
import { callPlainChat, getAiProviders } from "./ai-provider";
import { safeJsonLoads } from "./dreaming-core";
import { cleanDeviceName } from "./profile-scopes";

export const SUBAGENT_PATH_REGEX = "(^|/)agent-[0-9a-f]+\\.jsonl$";
export const GENERATED_PROMPT_SQL_RE = "^请为项目 .{1,120}? (更新仓库根目录已有的|在仓库根目录新建) BUSINESS_BLUEPRINT\\.md";
export const SUBAGENT_IMAGE_SQL_RE =
  "^\\s*(((Generated|Final|Saved|Output) image( path)?\\s*:\\s*)?`?\\S*/\\.gemini/antigravity(-cli)?/brain/|Generate an? [^\\n]{0,120}?(image|keyframe|still|portrait))";

const BASE64_DATA_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{40,}/gi;
const RAW_BASE64_BLOB_RE = /[A-Za-z0-9+/]{120,}={0,2}/g;

export const EMBEDDED_CONTEXT_RE =
  /<(system-reminder|ide_selection|ide_opened_file|environment_context|user_instructions|external_codex_apps_open_page)>[\s\S]*?<\/\1>/g;

export const CORRECTION_RE =
  /不对|错了|不要|别再|不用|我说过|说了多少|以后|每次|永远|一律|必须|禁止|记住|怎么又|还是没|为什么|\bdon'?t\b|\bnever\b|\balways\b|\bstop\b|\bwrong\b|\binstead\b|\bremember\b/i;

const NON_USER_PREFIXES = [
  "[Result]",
  "[Tool:",
  '{"tool_use_id"',
  "<command-",
  "<local-command",
  "<system-reminder>",
  "<task-notification>",
  "<environment_context>",
  "<user_instructions>",
  "# AGENTS.md",
  "Caveat:",
  "This session is being continued",
  "[Request interrupted",
  "[OpenClaw heartbeat",
  "<conversation_history_summary>",
  "<cb_summary>",
  "<analysis>",
  "<original_task>",
];

const TRIVIAL_REPLIES = new Set([
  "continue", "go on", "ok", "okay", "yes", "y", "no", "n", "thanks",
  "继续", "好", "好的", "嗯", "是", "对", "可以", "行", "需要", "提交", "在吗", "谢谢",
]);

const SCRIPTED_PROMPT_RE =
  /^(?:你是|您是)(?:一[名位个])?[^，,。！？!?\n]{0,24}?(?:专家|助手|工程师|负责人|分析师|顾问|评审|审稿人|架构师|研究员|翻译)[。，,.:：；;！!\s]|^you are (?:an?|the) [^.\n]{0,60}?(?:expert|assistant|engineer|reviewer|analyst|specialist|architect|consultant|researcher|translator)\b/i;
const SCRIPTED_PROMPT_MIN_CHARS = 120;

const INJECTED_CONTEXT_RE =
  /^(?:Memento: )?(?:【前序会话核心记忆快照|【前文对话历史(?:（[^】]{0,60}）)?】)[\s\S]*?(?:当前用户指令[：:]|【当前用户指令】)\s*/;
const INJECTED_CONTEXT_HEADS = ["【前序会话核心记忆快照", "【前文对话历史", "Memento: 【前序会话核心记忆快照"];

const AGENT_REPORT_RE = /^[\w.-]+ pipeline (?:completed|failed)\b|\*\*Worker Report\*\*|Skepticism Disclaimer/i;
const SUBAGENT_IMAGE_REPORT_RE =
  /^(?:(?:Generated|Final|Saved|Output) image(?: path)?\s*:\s*)?`?\S*\/\.gemini\/antigravity(?:-cli)?\/brain\//i;
const SUBAGENT_IMAGE_TASK_RE = /^Generate an? [^\n]{0,120}?\b(?:image|keyframe|still|portrait)\b/i;
const GENERATED_PROMPT_RE = /^请为项目 .{1,120}? (?:更新仓库根目录已有的|在仓库根目录新建) BUSINESS_BLUEPRINT\.md/;
const EXECUTOR_HINT_RE = /^\[只在这里改代码\][\s\S]*?(?:\n-{3,}\n|$)\s*/;
const CLIENT_INJECTED_BLOCK_RE = /(?:【用户上传了(?:图片|附件)\s*#\d+】[\s\S]*?(?:\n\n|$)|\[本轮答复已输出[^\]]*\])/g;

export const USER_VOICE_MSG_CHARS = 300;
export const USER_VOICE_BATCH_CHARS = 12000;
export const USER_VOICE_MAX_BATCHES = 6;
export const USER_VOICE_FETCH_LIMIT = 4000;

export function sanitizeTransientText(text: string | null | undefined): string {
  if (!text) return "";
  let cleaned = text.replace(BASE64_DATA_RE, "[image_base64_omitted]").replace(RAW_BASE64_BLOB_RE, "[binary_blob_omitted]");
  if (cleaned.length > 2500) {
    cleaned = `${cleaned.slice(0, 1500)}\n...[中段内容修剪]...\n${cleaned.slice(-800)}`;
  }
  return cleaned.trim();
}

export function cleanUserVoice(content: string | null | undefined): string | null {
  if (!content) return null;
  let text = content.replace(CLIENT_INJECTED_BLOCK_RE, "").trim();
  text = text.replace(INJECTED_CONTEXT_RE, "").trim();
  text = text.replace(EXECUTOR_HINT_RE, "").trim();
  if (!text || GENERATED_PROMPT_RE.test(text)) return null;
  if (NON_USER_PREFIXES.some((p) => text.startsWith(p)) || INJECTED_CONTEXT_HEADS.some((p) => text.startsWith(p))) {
    return null;
  }
  text = text.replace(EMBEDDED_CONTEXT_RE, "");
  text = sanitizeTransientText(text).replace(/\s+/g, " ").trim();
  if (text.length < 2 || /^\d+$/.test(text) || TRIVIAL_REPLIES.has(text.toLowerCase().replace(/^[ .!！。]+|[ .!！。]+$/g, ""))) {
    return null;
  }
  if (text.length >= SCRIPTED_PROMPT_MIN_CHARS && SCRIPTED_PROMPT_RE.test(text)) return null;
  if (AGENT_REPORT_RE.test(text) || SUBAGENT_IMAGE_REPORT_RE.test(text) || SUBAGENT_IMAGE_TASK_RE.test(text)) return null;
  if (text.length > USER_VOICE_MSG_CHARS) text = `${text.slice(0, USER_VOICE_MSG_CHARS)}…`;
  return text;
}

export interface VoiceRow {
  content: string | null;
  timestamp: string | null;
  source?: string | null;
}

export function planUserVoiceBatches(rows: VoiceRow[]): { batches: string[][]; stats: Record<string, number> } {
  const seen = new Set<string>();
  const corrections: [number, string][] = [];
  const others: [number, string][] = [];

  for (const row of rows) {
    const text = cleanUserVoice(row.content);
    if (!text) continue;
    const low = text.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    const tagged = row.source ? `[${row.source}] ${text}` : text;
    const ts = row.timestamp ? Date.parse(row.timestamp.includes("T") ? row.timestamp : row.timestamp.replace(" ", "T")) : 0;
    const item: [number, string] = [Number.isFinite(ts) ? ts : 0, tagged];
    if (CORRECTION_RE.test(text)) corrections.push(item);
    else others.push(item);
  }

  const packed: [number, string][][] = [];
  let current: [number, string][] = [];
  let size = 0;
  let capped = false;
  for (const item of [...corrections, ...others]) {
    const cost = item[1].length + 16;
    if (current.length && size + cost > USER_VOICE_BATCH_CHARS) {
      packed.push(current);
      current = [];
      size = 0;
      if (packed.length === USER_VOICE_MAX_BATCHES) {
        capped = true;
        break;
      }
    }
    current.push(item);
    size += cost;
  }
  if (!capped && current.length) packed.push(current);

  const fmtTs = (ms: number) => {
    if (!ms) return "?";
    const d = new Date(ms);
    const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    const h = String(d.getUTCHours()).padStart(2, "0");
    const mi = String(d.getUTCMinutes()).padStart(2, "0");
    return `${mo}-${da} ${h}:${mi}`;
  };

  const batches = packed.map((batch) =>
    [...batch].sort((a, b) => a[0] - b[0]).map(([ms, t]) => `[${fmtTs(ms)}] ${t}`),
  );
  const stats = {
    candidates: rows.length,
    kept: corrections.length + others.length,
    corrections: corrections.length,
    used: batches.reduce((acc, b) => acc + b.length, 0),
    batches: batches.length,
  };
  return { batches, stats };
}

export async function fetchUserVoiceRows(
  db: Db,
  userId: string,
  sinceIso: string,
  untilIso: string,
  withSource = false,
): Promise<VoiceRow[]> {
  if (!withSource) {
    const rows = (await db.execute(sql`
      SELECT cm.content, cm.timestamp
      FROM conversation_messages cm
      JOIN documents d ON d.id = cm.document_id
      WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid)
        AND cm.role = 'user'
        AND cm.timestamp >= ${sinceIso}::timestamptz
        AND cm.timestamp <= ${untilIso}::timestamptz
        AND cm.content NOT LIKE '[Result]%'
        AND NOT (d.relative_path ~ ${SUBAGENT_PATH_REGEX})
        AND NOT COALESCE(d.metadata ? 'parent_session_id', false)
      ORDER BY cm.timestamp DESC
      LIMIT ${USER_VOICE_FETCH_LIMIT}
    `)) as unknown as { content: string | null; timestamp: string | null }[];
    return rows.map((r) => ({ content: r.content, timestamp: r.timestamp ? String(r.timestamp) : null }));
  }

  const rows = (await db.execute(sql`
    SELECT cm.content, cm.timestamp, p.title AS project, m.name AS machine
    FROM conversation_messages cm
    JOIN documents d ON d.id = cm.document_id
    LEFT JOIN projects p ON p.id = d.project_id
    LEFT JOIN machines m ON m.id = d.machine_id
    WHERE d.machine_id IN (SELECT id FROM machines WHERE user_id = ${userId}::uuid)
      AND cm.role = 'user'
      AND cm.timestamp >= ${sinceIso}::timestamptz
      AND cm.timestamp <= ${untilIso}::timestamptz
      AND cm.content NOT LIKE '[Result]%'
      AND NOT (d.relative_path ~ ${SUBAGENT_PATH_REGEX})
      AND NOT COALESCE(d.metadata ? 'parent_session_id', false)
    ORDER BY cm.timestamp DESC
    LIMIT ${USER_VOICE_FETCH_LIMIT}
  `)) as unknown as { content: string | null; timestamp: string | null; project: string | null; machine: string | null }[];
  return rows.map((r) => {
    const dev = r.machine ? cleanDeviceName(r.machine) : null;
    const source = [r.project, dev].filter(Boolean).join(" @ ") || null;
    return { content: r.content, timestamp: r.timestamp ? String(r.timestamp) : null, source };
  });
}

const VOICE_SIGNAL_PROMPT = (quotes: string) => `下面是用户本人在各个 AI 工具里亲手输入的话（已去掉工具输出和系统注入内容），按时间排序。
请只从这些原话中提取能长期指导 AI 如何与该用户协作的信号：
- correction：用户指出 AI 做错了什么、要求别再怎么做
- preference：沟通语言、回复风格、工作流、技术选型习惯
- rule：用户明确要求"以后 / 每次 / 必须 / 禁止"的规则
忽略一次性的任务指令（如"帮我修这个 bug"）。每条信号都必须能在原话里找到依据，不要推测。

${quotes}

原话前面如果有 [项目 @ 设备] 标注，把它原样填进 source，没有就留空。

只输出 JSON：{"signals": [{"kind": "correction|preference|rule", "statement": "一句话概括", "evidence": "原话片段", "source": ""}]}`;

export async function renderUserVoice(
  settings: Settings,
  redis: Redis | null,
  user: { llmSettings?: unknown } | null,
  batches: string[][],
): Promise<string> {
  if (!batches.length) return "";
  if (batches.length === 1 || !getAiProviders(settings, { background: true, user }).length) {
    return batches[0]!.join("\n");
  }

  const results: Record<string, unknown>[][] = new Array(batches.length).fill([]);
  let next = 0;
  const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= batches.length) break;
      try {
        const raw = await callPlainChat(
          settings,
          redis,
          [
            { role: "system", content: "You extract durable user preferences. Respond only with valid JSON." },
            { role: "user", content: VOICE_SIGNAL_PROMPT(batches[idx]!.join("\n")) },
          ],
          { maxTokens: 1200, background: true, user },
        );
        const signals = safeJsonLoads(raw).signals;
        results[idx] = Array.isArray(signals)
          ? (signals as Record<string, unknown>[]).filter((s) => s && typeof s === "object" && String(s.statement ?? "").trim())
          : [];
      } catch {
        results[idx] = [];
      }
    }
  });
  await Promise.all(workers);

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const signals of results) {
    for (const s of signals) {
      const stmt = String(s.statement ?? "").trim();
      if (!stmt || seen.has(stmt.toLowerCase())) continue;
      seen.add(stmt.toLowerCase());
      const ev = String(s.evidence ?? "").trim().slice(0, 120);
      const kind = String(s.kind ?? "signal").trim();
      const src = String(s.source ?? "").trim().replace(/^\[+|\]+$/g, "").slice(0, 80);
      lines.push(`- [${kind}] ${stmt}${ev ? `（原话：${ev}）` : ""}${src ? `（出自 ${src}）` : ""}`);
    }
  }
  return lines.length ? lines.join("\n") : batches[0]!.join("\n");
}
