// What an AI should know before it acts: user rules, past pitfalls, and learned skills
// (server/server/services/guidance_service.py + touch_recalled from memory_lifecycle.py).
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Db } from "../db/client";
import { skills, userMemories } from "../db/pulled/schema";
import { segment } from "./tokenize";

export const ALWAYS_ON = ["rule", "rules", "preference"] as const;
export const ACTIVE = "active";
export const DORMANT = "dormant";
export const SUPERSEDED = "superseded";

const INJECTED_FALLBACK = new Map<string, { ids: string[]; expiresAt: number }>();
const INJECTED_TTL_SEC = 7200;
const INJECTED_MAX = 30;

export function feedbackMultiplier(pos: number | null | undefined, neg: number | null | undefined): number {
  const p = Math.max(0, Number(pos ?? 0));
  const n = Math.max(0, Number(neg ?? 0));
  return Math.max(0.55, Math.min(1.45, Math.round((1 + 0.08 * p - 0.14 * n) * 1000) / 1000));
}

export async function recordMemoryFeedback(
  db: Db,
  ids: Iterable<string>,
  kind: "pos" | "neg",
): Promise<number> {
  const list = [...new Set([...ids].filter(Boolean))];
  if (!list.length) return 0;
  try {
    const updated =
      kind === "pos"
        ? await db
            .update(userMemories)
            .set({
              feedbackPos: sql`coalesce(${userMemories.feedbackPos}, 0) + 1`,
              confidence: sql`least(1.0, coalesce(${userMemories.confidence}, 0.8) + 0.03)`,
              updatedAt: sql`${userMemories.updatedAt}`,
            })
            .where(inArray(userMemories.id, list))
            .returning({ id: userMemories.id })
        : await db
            .update(userMemories)
            .set({
              feedbackNeg: sql`coalesce(${userMemories.feedbackNeg}, 0) + 1`,
              confidence: sql`greatest(0.2, coalesce(${userMemories.confidence}, 0.8) - 0.06)`,
              updatedAt: sql`${userMemories.updatedAt}`,
            })
            .where(inArray(userMemories.id, list))
            .returning({ id: userMemories.id });
    return updated.length;
  } catch {
    return 0;
  }
}

export async function trackInjectedMemories(
  redis: Redis | null,
  userId: string,
  ids: Iterable<string>,
): Promise<void> {
  const fresh = [...new Set([...ids].filter(Boolean))];
  if (!userId || !fresh.length) return;
  const key = `injected_memories:${userId}`;
  const prev = await getRecentlyInjectedMemoryIds(redis, userId);
  const merged = [...new Set([...prev, ...fresh])].slice(-INJECTED_MAX);
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(merged), "EX", INJECTED_TTL_SEC);
      INJECTED_FALLBACK.delete(key);
      return;
    } catch {
      /* fallback */
    }
  }
  INJECTED_FALLBACK.set(key, { ids: merged, expiresAt: Date.now() + INJECTED_TTL_SEC * 1000 });
}

export async function getRecentlyInjectedMemoryIds(redis: Redis | null, userId: string): Promise<string[]> {
  if (!userId) return [];
  const key = `injected_memories:${userId}`;
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      }
      return [];
    } catch {
      /* fallback */
    }
  }
  const hit = INJECTED_FALLBACK.get(key);
  if (!hit || hit.expiresAt < Date.now()) {
    INJECTED_FALLBACK.delete(key);
    return [];
  }
  return [...hit.ids];
}

const ACTION_SYNONYMS: Record<string, readonly string[]> = {
  deploy: ["部署", "上线", "发布", "k8s", "kubectl", "fleet", "pod"],
  release: ["发版", "发布", "版本", "tag", "release"],
  migration: ["迁移", "数据库", "表", "schema", "migration"],
  db: ["数据库", "表", "postgres", "sql"],
  build: ["构建", "编译", "打包", "build", "镜像"],
  push: ["推送", "提交", "push", "git"],
  commit: ["提交", "commit", "git"],
  git: ["git", "提交", "分支"],
  test: ["测试", "test"],
  config: ["配置", "config", "设置"],
  update: ["更新", "升级", "update"],
  delete: ["删除", "清理", "rm"],
  backup: ["备份", "backup"],
  data: ["数据", "表", "标注"],
  refactor: ["重构", "refactor"],
  install: ["安装", "依赖", "install"],
};

const RULES_LIMIT = 10;
const PITFALL_LIMIT = 8;
const SKILL_LIMIT = 3;

export async function touchRecalled(db: Db, ids: Iterable<string>): Promise<void> {
  const list = [...new Set([...ids].filter(Boolean))];
  if (!list.length) return;
  try {
    await db
      .update(userMemories)
      .set({
        lastRecalledAt: sql`now()`,
        recallCount: sql`${userMemories.recallCount} + 1`,
        updatedAt: sql`${userMemories.updatedAt}`,
      })
      .where(inArray(userMemories.id, list));
  } catch {
    /* best effort */
  }
}

export function termsFor(...texts: (string | null | undefined)[]): string[] {
  const raw: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[\s_\-/,，;；]+/)) {
      if (word) {
        raw.push(word);
        const syns = ACTION_SYNONYMS[word];
        if (syns) raw.push(...syns);
      }
    }
    for (const t of segment(text)) raw.push(t.toLowerCase());
  }
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const rawTerm of raw) {
    const term = rawTerm.trim();
    if (term.length < 2 && !/[\u4e00-\u9fff]/.test(term)) continue;
    if (!seenSet.has(term)) {
      seenSet.add(term);
      seen.push(term);
    }
    if (seen.length >= 40) break;
  }
  return seen;
}

export function score(text: string | null | undefined, terms: string[]): number {
  const low = (text || "").toLowerCase();
  let s = 0;
  for (const t of terms) if (low.includes(t)) s++;
  return s;
}

function projectOf(treePath: string | null | undefined): string | null {
  const parts = (treePath || "").replace(/^\/+|\/+$/g, "").split("/");
  return parts.length >= 3 && (parts[0] === "pitfall" || parts[0] === "project") ? parts[1]!.toLowerCase() : null;
}

export type UserMemoryRow = typeof userMemories.$inferSelect;

export function memoryOut(mem: UserMemoryRow) {
  return {
    id: String(mem.id),
    category: mem.category,
    key: mem.key,
    content: mem.content,
    source: mem.source,
    tree_path: mem.treePath,
  };
}

export async function guidanceFor(
  db: Db,
  user: { id: string },
  action: string | null | undefined,
  project?: string | null,
  query?: string | null,
) {
  const terms = termsFor(action, query);
  const proj = (project || "").trim().toLowerCase() || null;

  const memories = await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, user.id),
        eq(userMemories.status, ACTIVE),
        eq(userMemories.isFolder, false),
        inArray(userMemories.category, [...ALWAYS_ON, "pitfall", "project", "architecture"]),
      ),
    );

  const rules: [number, UserMemoryRow][] = [];
  const pitfalls: [number, UserMemoryRow][] = [];
  const alwaysOnSet = new Set<string>(ALWAYS_ON);

  for (const mem of memories) {
    const text = `${mem.key} ${mem.treePath || ""} ${mem.content}`;
    const s = score(text, terms);
    const fb = feedbackMultiplier(mem.feedbackPos, mem.feedbackNeg);
    const memProj = projectOf(mem.treePath);
    const inProject = Boolean(proj && (memProj === proj || (mem.treePath || "").toLowerCase().includes(proj)));
    if (alwaysOnSet.has(mem.category)) {
      if (s || mem.source === "manual") rules.push([(s || 0.5) * fb, mem]);
    } else if (mem.category === "pitfall") {
      if (s || inProject) pitfalls.push([(s + (inProject ? 3 : 0)) * fb, mem]);
    } else if (inProject && s) {
      rules.push([s * fb, mem]);
    }
  }

  const best = (items: [number, UserMemoryRow][], n: number) =>
    items
      .sort((a, b) => {
        if (b[0] !== a[0]) return b[0] - a[0];
        const am = a[1].source === "manual" ? 1 : 0;
        const bm = b[1].source === "manual" ? 1 : 0;
        if (bm !== am) return bm - am;
        return (b[1].updatedAt || "").localeCompare(a[1].updatedAt || "");
      })
      .slice(0, n)
      .map(([, m]) => m);

  const chosenRules = best(rules, RULES_LIMIT);
  const chosenPitfalls = best(pitfalls, PITFALL_LIMIT);

  const pubSkills = await db
    .select()
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.status, "published")));

  const chosenSkills = pubSkills
    .map((s) => ({
      sc:
        score(`${s.slug} ${s.title} ${s.description} ${s.project || ""}`, terms) +
        (proj && (s.project || "").toLowerCase() === proj ? 3 : 0),
      s,
    }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, SKILL_LIMIT)
    .map((x) => x.s);

  await touchRecalled(db, [...chosenRules, ...chosenPitfalls].map((m) => m.id));

  return {
    action: action ?? null,
    project: project ?? null,
    rules: chosenRules.map(memoryOut),
    pitfalls: chosenPitfalls.map(memoryOut),
    skills: chosenSkills.map((s) => ({ slug: s.slug, title: s.title, description: s.description })),
  };
}

export function renderGuidance(g: {
  action?: string | null;
  project?: string | null;
  rules: { content: string }[];
  pitfalls: { content: string }[];
  skills: { slug: string; title: string; description: string }[];
}): string {
  const head = `# 执行「${g.action || "操作"}」前的检查${g.project ? `（项目：${g.project}）` : ""}`;
  const lines = [head];
  if (g.rules.length) {
    lines.push("\n## 必须遵守的规矩");
    for (const m of g.rules) lines.push(`- ${m.content}`);
  }
  if (g.pitfalls.length) {
    lines.push("\n## 以前踩过的坑");
    for (const m of g.pitfalls) lines.push(`- ${m.content}`);
  }
  if (g.skills.length) {
    lines.push("\n## 可以直接照做的技能");
    for (const s of g.skills) lines.push(`- \`${s.slug}\` ${s.title}：${s.description}`);
  }
  if (lines.length === 1) lines.push("\n没有找到相关的规矩或踩坑记录，按常规做法进行。");
  return lines.join("\n");
}
