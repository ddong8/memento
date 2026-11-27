// Core memory markdown export, safe JSON parser & pitfall persistence shared by P4 & P5
// (server/server/services/dreaming_service.py + retrospective_service.py).
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheDeletePrefix } from "../cache";
import { withoutNul, type Db } from "../db/client";
import { userMemories } from "../db/pulled/schema";
import { recordOnlineGraphObservation } from "./mind-resonance-service";

export function safeJsonLoads(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const v = JSON.parse(s.slice(start, end + 1));
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function readableMemory(content: string | null | undefined): string {
  const s = (content || "").trim();
  if (!s.startsWith("{")) return s;
  try {
    const data = JSON.parse(s) as Record<string, unknown>;
    if (!data || typeof data !== "object" || Array.isArray(data)) return s;
    const parts: string[] = [];
    if (data.name) parts.push(`名称：${data.name}`);
    if (data.mindset) parts.push(`心智模型：${data.mindset}`);
    if (Array.isArray(data.keywords) && data.keywords.length) parts.push(`关键词：${data.keywords.slice(0, 8).join("、")}`);
    if (Array.isArray(data.defense_rules) && data.defense_rules.length) parts.push(`防线：${data.defense_rules.join("；")}`);
    return parts.length ? `${parts.join("；")}。` : s;
  } catch {
    return s;
  }
}

const CATEGORY_TITLES: Record<string, string> = {
  rule: "1. 开发铁律与工程规范 (Rules & Guidelines)",
  architecture: "2. 核心架构决策与设计模式 (Architecture Decisions)",
  preference: "3. 个人偏好与工作流习惯 (Personal Preferences)",
  project: "4. 项目背景与业务核心约束 (Project Domain Knowledge)",
  general: "5. 综合常识与长期事实 (General Knowledge)",
};

const EXTRA_CATEGORY_TITLES: Record<string, string> = {
  pitfall: "6. 历史避坑与故障复盘 (Pitfalls & Lessons)",
  tools: "7. 工具链与工作流生态 (Tools & Ecosystem)",
  resonance_scenario: "8. 自进化领域场景 (Evolved Scenarios)",
};

export async function exportCoreMemoryMarkdown(db: Db, user: { id: string }, exclude?: string[] | null): Promise<string> {
  const rows = await db
    .select({
      category: userMemories.category,
      key: userMemories.key,
      isFolder: userMemories.isFolder,
      treePath: userMemories.treePath,
      confidence: userMemories.confidence,
      content: userMemories.content,
    })
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.status, "active")))
    .orderBy(asc(userMemories.category), asc(userMemories.key));

  const excludeSet = new Set(exclude ?? []);
  const leftOut: Record<string, number> = {};
  const kept = rows.filter((m) => {
    if (excludeSet.has(m.category)) {
      leftOut[m.category] = (leftOut[m.category] ?? 0) + 1;
      return false;
    }
    return true;
  });

  if (!kept.length) {
    return (
      "# MEMORY.md — 个人核心记忆与研发知识库\n\n" +
      "> 当前暂未沉淀长期记忆。您可以通过在聊天中交流、手动添加，或等待夜间做梦机制 (Dreaming Consolidation) 自动提炼生成。\n"
    );
  }

  const byCat = new Map<string, typeof kept>();
  for (const m of kept) {
    const arr = byCat.get(m.category) ?? [];
    arr.push(m);
    byCat.set(m.category, arr);
  }

  const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  const lines = [
    "# MEMORY.md — 个人核心记忆与研发知识库",
    "",
    "> 由 Memento 做梦机制 (Dreaming Consolidation) 自动萃取并保持同步。",
    `> 最后更新时间：${nowStr} UTC | 记忆条目总数：${kept.length}`,
  ];
  const leftEntries = Object.entries(leftOut);
  if (leftEntries.length) {
    lines.push(`> 未列出：${leftEntries.map(([c, n]) => `${c} ${n} 条`).join("、")}`);
  }
  lines.push("");

  for (const [catCode, catTitle] of Object.entries(CATEGORY_TITLES)) {
    const items = byCat.get(catCode);
    if (items?.length) {
      lines.push(`## ${catTitle}`);
      for (const it of items) {
        const prefix = it.isFolder ? "📁 " : "";
        const pathInfo = it.treePath ? ` \`${it.treePath}\`` : "";
        lines.push(`- ${prefix}**[${it.key}]**${pathInfo} (${Number(it.confidence ?? 0).toFixed(2)}): ${readableMemory(it.content)}`);
      }
      lines.push("");
    }
  }
  for (const [catCode, items] of byCat) {
    if (catCode in CATEGORY_TITLES) continue;
    lines.push(`## ${EXTRA_CATEGORY_TITLES[catCode] ?? `其他分类 (${catCode})`}`);
    for (const it of items) {
      const prefix = it.isFolder ? "📁 " : "";
      const pathInfo = it.treePath ? ` \`${it.treePath}\`` : "";
      lines.push(`- ${prefix}**[${it.key}]**${pathInfo}: ${readableMemory(it.content)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

const PITFALL_MAX = 600;
function squash(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim();
}

export function formatPitfall(item: Record<string, unknown>, project: string | null): string {
  const f = (k: string, lim: number) => squash(String(item[k] ?? "")).slice(0, lim);
  const head = project ? `【${project}】` : "";
  return `${head}${f("title", 80)}。现象：${f("symptom", 200)}；原因：${f("cause", 160)}；解决：${f("fix", 200)}`.slice(0, PITFALL_MAX);
}

export function pitfallKey(title: string): string {
  return `pitfall_${createHash("sha1").update((title || "").trim().toLowerCase()).digest("hex").slice(0, 10)}`;
}

export function projectKey(name: string | null | undefined): string {
  const leaf = (name || "").trim().split("/").pop()?.toLowerCase() ?? "";
  return leaf.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "general";
}

export async function savePitfall(
  db: Db,
  redis: Redis | null,
  user: { id: string },
  item: Record<string, unknown>,
  project: string | null,
  source: string,
) {
  if (!["title", "symptom", "fix"].every((k) => String(item[k] ?? "").trim())) return null;
  if (String(item.kind ?? "").toLowerCase() === "slip") return null;
  const display = (project || String(item.project ?? "")).trim().split("/").pop() || null;
  const folder = projectKey(display);
  const key = pitfallKey(String(item.title));
  const [exists] = await db
    .select({ id: userMemories.id })
    .from(userMemories)
    .where(and(eq(userMemories.userId, user.id), eq(userMemories.category, "pitfall"), eq(userMemories.key, key)))
    .limit(1);
  if (exists) return null;

  const nowIso = new Date().toISOString();
  const [mem] = await db
    .insert(userMemories)
    .values(
      withoutNul({
        id: randomUUID(),
        userId: user.id,
        category: "pitfall",
        key,
        content: formatPitfall(item, display),
        confidence: 0.85,
        source,
        treePath: `/pitfall/${folder}/${key}`,
        isFolder: false,
        recallCount: 0,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
    )
    .returning();

  await recordOnlineGraphObservation(
    db,
    redis,
    user.id,
    display || "工程实践",
    `${item.title}：原因【${item.cause ?? ""}】，解决【${item.fix}】`,
    { entityType: display ? "project" : "concept", summary: `避坑指南: ${item.title}` },
  ).catch(() => {});
  await cacheDeletePrefix(redis, `memory:resonance:${user.id}`).catch(() => {});
  await cacheDeletePrefix(redis, `learning:check:${user.id}`).catch(() => {});
  return mem ?? null;
}
