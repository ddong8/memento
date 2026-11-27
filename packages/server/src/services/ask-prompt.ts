// Prompt construction for Ask: system prompt, history + RAG + Mind Resonance + user profile
// (server/server/services/ask_prompt.py).
import { pgToIso } from "../pytime";
import { getPublishedProfileContent } from "./profile-read";
import { renderMindResonanceMarkdown, senseResonance } from "./mind-resonance-service";
import type { Db } from "../db/client";
import type { Redis } from "ioredis";

export const SYSTEM_PROMPT = `你是用户的 AI 个人记忆助手（Memento）。你的知识库里保存了用户在多个 AI 编程/办公工具（Claude Code、Codex、OpenClaw、Obsidian 等）上的全部历史对话、笔记、工作流、方案与记忆。

请遵守以下回答准则：
1. **基于检索到的上下文回答**：只依据提供的历史片段作答，不要编造未出现过的文件路径、命令、配置、人名或日期。
2. **明确引用来源**：在关键事实后用 \`[编号]\` 标明出自哪条参考资料（例如 \`[1]\`、\`[2]\`）。
3. **如实说明缺失**：如果上下文不足以回答用户的全部问题，先回答有依据的部分，再直白告诉用户缺少哪些记录，不要硬凑。
4. **综合整理而非机械摘抄**：多条记录互补或有先后演变时，按时间线或主题归纳出结论，最新记录优先。
5. **匹配用户的语言**：用户用中文问就用中文答，用英文问就用英文答；给出具体的命令、代码、路径或方案要点。
6. **避免空话套话**：直奔主题，不用“根据提供的参考资料，我为您整理如下”之类客套开场白。`;

export const CONTINUE_PATTERNS = [
  "继续",
  "接着",
  "继续说",
  "继续写",
  "继续做",
  "继续完成",
  "往下说",
  "然后呢",
  "还有呢",
  "展开说说",
  "详细说说",
  "详细讲讲",
  "再具体点",
  "具体点",
  "详细点",
  "说具体点",
  "展开讲",
  "continue",
  "go on",
  "more",
  "keep going",
  "tell me more",
  "elaborate",
  "details",
];

const RETRIEVE_CUES = [
  "查",
  "搜",
  "找",
  "看看",
  "历史",
  "之前",
  "以前",
  "上次",
  "昨天",
  "上周",
  "项目",
  "笔记",
  "文档",
  "代码",
  "记忆",
  "总结",
  "日报",
  "设备",
  "机器",
  "search",
  "find",
  "check",
  "history",
  "previous",
  "last time",
  "project",
  "note",
  "doc",
  "memory",
];

export type ContinuationKind = "none" | "continue" | "followup";

export function classifyContinuation(question: string, history: { role?: string; content?: string }[] | null | undefined): ContinuationKind {
  if (!history?.length) return "none";
  const q = (question || "").trim();
  if (!q) return "none";
  const low = q.toLowerCase().replace(/[。！!？?.,，\s]+$/g, "");
  if (CONTINUE_PATTERNS.includes(low)) return "continue";
  if (q.length <= 14 && !RETRIEVE_CUES.some((c) => low.includes(c))) {
    if (["对", "好", "好的", "行", "嗯", "是的", "可以", "没问题", "ok", "yes", "sure", "yep", "yeah", "不错", "谢谢", "明白"].includes(low)) {
      return "continue";
    }
    if (/^(第[一二三四五六七八九十\d]+[个条点步]|[1-9]\b|那个|这个|上面|刚才|再|那|所以|为什么|怎么)/.test(low)) {
      return "followup";
    }
  }
  return "none";
}

export function formatContext(
  items: {
    tool_id?: string | null;
    project_title?: string | null;
    title?: string | null;
    relative_path?: string | null;
    synced_at?: string | null;
    snippet?: string | null;
  }[],
  maxTotalChars = 14_000,
): string {
  if (!items.length) return "";
  const blocks: string[] = [];
  let used = 0;
  items.forEach((it, idx) => {
    const meta = [
      it.tool_id || "",
      it.project_title || "",
      it.title || it.relative_path || "",
      it.synced_at ? String(it.synced_at).slice(0, 10) : "",
    ].filter(Boolean);
    const header = `[${idx + 1}] ${meta.join(" · ")}`;
    const body = String(it.snippet || "").trim();
    const block = `${header}\n${body}`;
    if (used + block.length > maxTotalChars && blocks.length > 0) return;
    blocks.push(block);
    used += block.length + 2;
  });
  return blocks.join("\n\n---\n\n");
}

function formatHistoryTurns(history: { role?: string; content?: string; images?: unknown }[], maxTurns = 10): Record<string, unknown>[] {
  const recent = history.slice(-maxTurns);
  const out: Record<string, unknown>[] = [];
  for (const h of recent) {
    const role = h.role === "assistant" ? "assistant" : "user";
    const text = String(h.content || "").trim();
    if (!text) continue;
    out.push({ role, content: text.slice(0, 4000) });
  }
  return out;
}

export async function buildMessages(
  db: Db,
  redis: Redis | null,
  user: { id: string },
  opts: {
    question: string;
    contextItems?: {
      tool_id?: string | null;
      project_title?: string | null;
      title?: string | null;
      relative_path?: string | null;
      synced_at?: string | null;
      snippet?: string | null;
    }[];
    history?: { role?: string; content?: string; images?: unknown }[];
    images?: string[];
    project?: string | null;
    liveRules?: string[] | null;
    systemExtra?: string | null;
  },
): Promise<{ messages: Record<string, unknown>[]; resonanceMd: string }> {
  const sysParts = [SYSTEM_PROMPT];

  try {
    const prof = await getPublishedProfileContent(db, redis, user);
    if (prof) {
      sysParts.push(`\n## 关于当前用户（常驻画像，请始终遵守）\n${prof}`);
    }
  } catch {
    /* ignore */
  }

  let resonanceMd = "";
  try {
    const res = await senseResonance(db, redis, user, {
      query: opts.question,
      project: opts.project ?? null,
      action: "ask",
    });
    resonanceMd = renderMindResonanceMarkdown(res, opts.liveRules);
    if (resonanceMd) sysParts.push(`\n${resonanceMd}`);
  } catch {
    /* ignore */
  }

  if (opts.systemExtra?.trim()) {
    sysParts.push(`\n${opts.systemExtra.trim()}`);
  }

  const nowStr = pgToIso(new Date().toISOString()) ?? new Date().toISOString();
  sysParts.push(`\n当前 UTC 时间：${nowStr}`);

  const messages: Record<string, unknown>[] = [{ role: "system", content: sysParts.join("\n") }];
  if (opts.history?.length) {
    messages.push(...formatHistoryTurns(opts.history));
  }

  const ctx = opts.contextItems?.length ? formatContext(opts.contextItems) : "";
  const userText = ctx
    ? `以下是从用户历史记录中检索到的参考上下文：\n\n${ctx}\n\n---\n\n用户问题：${opts.question}`
    : opts.question;

  if (opts.images?.length) {
    const contentParts: Record<string, unknown>[] = [{ type: "text", text: userText }];
    for (const img of opts.images.slice(0, 6)) {
      if (typeof img === "string" && (img.startsWith("data:image/") || img.startsWith("http://") || img.startsWith("https://"))) {
        contentParts.push({ type: "image_url", image_url: { url: img } });
      }
    }
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: userText });
  }

  return { messages, resonanceMd };
}
