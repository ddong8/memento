// Two-pass daily summary: per-conversation digest -> merged daily report (server/server/services/ai_summary_service.py).
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import { callPlainChat, getAiProviders } from "./ai-provider";

const CONCURRENCY = 5;

export interface ConvDigest {
  tool_id: string;
  title: string;
  digest: string;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function generateDailySummaryFromDigests(
  settings: Settings,
  redis: Redis | null,
  summaryDateIso: string,
  conversations: ConvDigest[],
  opts: { user?: { llmSettings?: unknown } | null; requireComplete?: boolean } = {},
): Promise<string | null> {
  if (!getAiProviders(settings, { user: opts.user }).length) return null;
  const validConvs = conversations.filter((c) => (c.digest || "").trim());
  if (!validConvs.length) return null;

  const convSummaries = await mapLimited(validConvs, CONCURRENCY, async (c) => {
    if (c.digest.length < 200) return { tool_id: c.tool_id, title: c.title, summary: c.digest, ok: true };
    const digest = c.digest.length > 8000 ? `${c.digest.slice(0, 8000)}\n\n...(内容已截断)` : c.digest;
    const prompt =
      `请用 2-5 句话简要总结以下 AI 编程对话的内容。重点说明：用户想做什么、最终结果如何、解决了什么问题。\n\n` +
      `对话标题：${c.title}\n工具：${c.tool_id}\n\n对话内容：\n${digest}`;
    const result = await callPlainChat(
      settings,
      redis,
      [
        { role: "system", content: "你是一个技术对话摘要助手，擅长从 AI 编程对话中提炼关键信息。输出简洁的中文摘要。" },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: 500, timeoutSec: 90, user: opts.user },
    );
    return { tool_id: c.tool_id, title: c.title, summary: result || digest.slice(0, 300), ok: Boolean(result) };
  });

  const failed = convSummaries.filter((cs) => !cs.ok).length;
  if (failed && opts.requireComplete) return null;

  const byTool = new Map<string, typeof convSummaries>();
  for (const cs of convSummaries) {
    const arr = byTool.get(cs.tool_id) ?? [];
    arr.push(cs);
    byTool.set(cs.tool_id, arr);
  }
  const lines: string[] = [];
  for (const [toolId, items] of byTool) {
    lines.push(`## ${toolId} (${items.length} 个对话)`);
    for (const item of items) {
      lines.push(`### ${item.title}`);
      lines.push(item.summary);
      lines.push("");
    }
  }
  let summariesText = lines.join("\n");
  if (summariesText.length > 15000) summariesText = `${summariesText.slice(0, 15000)}\n\n...(已截断)`;

  const prompt =
    `你是 AI 工作日报助手。以下是 ${summaryDateIso} 每个对话的摘要，请合并生成一份工作日报。\n\n` +
    `要求：\n` +
    `1) 使用通俗易懂的语言，只陈述已完成的工作成果，不要提问题、风险、报错或未完成事项，突出业务内容与实际价值\n` +
    `2) 先写「今日概要」（2-3 句话概括今天完成的核心业务内容与工作成果）\n` +
    `3) 按项目分组（不是按工具分组），列出每个项目已完成的工作进展，编号统一使用 1), 2), 3) 形式，不要用角标\n` +
    `4) 如果有多个对话围绕同一个项目，合并总结已完成事项\n` +
    `5) 全文严禁使用 ** 这类 Markdown 加粗符号\n` +
    `6) 控制在 800 字以内\n\n` +
    `各对话摘要：\n${summariesText}`;

  return callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "你是专业的工作日报助手，擅长用通俗语言将技术工作提炼为突出业务内容、只陈述已完成工作的精炼日报，且不使用 ** 加粗符号。" },
      { role: "user", content: prompt },
    ],
    { temperature: 0.3, maxTokens: 2000, timeoutSec: 90, user: opts.user },
  );
}
