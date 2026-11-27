// BUSINESS_BLUEPRINT.md parser, rule coverage & resolution (server/server/services/business_blueprint.py).
import { and, desc, eq, like, or, type SQL } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Db } from "../db/client";
import { documents, projects } from "../db/pulled/schema";
import { getPublishedProfileContent } from "./profile-read";
import { normScopeName, splitProfileScopes } from "./profile-scopes";
import { machineFilter } from "./visibility";

export const BUSINESS_FILE = "BUSINESS_BLUEPRINT.md";
const ENTRY_RE = /^###\s+([TFRS]-[A-Z0-9][A-Z0-9-]*)\s+(.+?)\s*$/;
const FIELD_RE = /^\s*[-*]\s*(来源|说明|定义)\s*[:：]\s*(.*)$/;
const SUMMARY_RE = /规则\s*(\d+)（✅\s*(\d+)\s*·\s*⚠️\s*(\d+)\s*·\s*❌\s*(\d+)）\s*·\s*流程\s*(\d+)\s*·\s*术语\s*(\d+)\s*·\s*状态\s*(\d+)/;
const CHECK_START = "<!-- memento:business-check:start";
const NOISE_RE = /[\s，。、；：:;,.!?！？「」『』“”"'`（）()【】[\]<>《》\-—_/\\|*#]+/g;

export interface BusinessEntry {
  id: string;
  kind: "term" | "flow" | "rule" | "state";
  title: string;
  texts: string[];
}

export function parseEntries(text: string): BusinessEntry[] {
  const entries: BusinessEntry[] = [];
  let cur: BusinessEntry | null = null;
  const kindMap: Record<string, BusinessEntry["kind"]> = { T: "term", F: "flow", R: "rule", S: "state" };
  for (const line of (text || "").split("\n")) {
    if (line.startsWith(CHECK_START)) break;
    const m = ENTRY_RE.exec(line);
    if (m) {
      cur = { id: m[1]!, kind: kindMap[m[1]![0]!] ?? "rule", title: m[2]!, texts: [] };
      entries.push(cur);
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      cur = null;
      continue;
    }
    if (cur) {
      const f = FIELD_RE.exec(line);
      if (f) cur.texts.push(f[2]!.trim());
    }
  }
  return entries;
}

export function checkSummary(text: string) {
  const m = SUMMARY_RE.exec(text || "");
  if (!m) return null;
  const [, rules, ok, warn, fail, flows, terms, states] = m.map(Number) as [number, number, number, number, number, number, number, number];
  const problems: string[] = [];
  const start = (text || "").indexOf(CHECK_START);
  if (start >= 0) {
    for (const line of text.slice(start).split("\n")) {
      if (line.startsWith("- ❌") || line.startsWith("- ⚠️")) problems.push(line.slice(2).trim());
    }
  }
  return { rules, ok, warn, fail, flows, terms, states, problems: problems.slice(0, 30) };
}

function norm(s: string): string {
  return (s || "").replace(/\*\*|__/g, "").replace(NOISE_RE, "").toLowerCase();
}

function bigrams(s: string): Set<string> {
  if (s.length <= 1) return new Set([s]);
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

export function ruleCovered(rule: string, entries: BusinessEntry[]): boolean {
  const r = norm(rule.replace(/^\s*[-*]\s*/, ""));
  if (r.length < 4) return true;
  const rb = bigrams(r);
  for (const e of entries) {
    for (const t of [e.title, ...e.texts]) {
      const n = norm(t);
      if (!n) continue;
      if (n.includes(r) || (n.length >= 8 && r.includes(n))) return true;
      const nb = bigrams(n);
      let shared = 0;
      for (const b of rb) if (nb.has(b)) shared++;
      if (shared / rb.size >= 0.6) return true;
    }
  }
  return false;
}

export function ruleClauses(rule: string): string[] {
  const body = (rule || "").replace(/^\s*[-*]\s*/, "").trim().replace(/[。.]+$/, "");
  return body
    .split(/[；;]/)
    .map((c) => c.trim().replace(/[。.]+$/, ""))
    .filter((c) => norm(c).length >= 4);
}

export function uncoveredRules(text: string, rules: string[]): string[] {
  const entries = parseEntries(text).filter((e) => e.kind === "rule");
  const out: string[] = [];
  for (const r of rules) {
    for (const clause of ruleClauses(r)) {
      if (!ruleCovered(clause, entries) && !out.includes(clause)) out.push(clause);
    }
  }
  return out;
}

export function rulesTotal(rules: string[]): number {
  return rules.reduce((acc, r) => acc + ruleClauses(r).length, 0);
}

export async function resolveBusinessBlueprint(
  db: Db,
  project: Pick<typeof projects.$inferSelect, "id" | "title" | "slug">,
  mids: string[] | null,
  preferMachine?: string | null,
): Promise<[string, string | null] | null> {
  const conds: SQL[] = [eq(documents.projectId, project.id)];
  for (const key of [project.title, project.slug]) {
    if (key) {
      const leaf = key.split("/").pop()!;
      conds.push(eq(documents.relativePath, `${leaf}/${BUSINESS_FILE}`));
    }
  }
  const whereParts: SQL[] = [
    or(eq(documents.relativePath, BUSINESS_FILE), like(documents.relativePath, `%/${BUSINESS_FILE}`))!,
    or(...conds)!,
  ];
  const mf = machineFilter(mids, documents.machineId);
  if (mf) whereParts.push(mf);
  const rows = (
    await db
      .select({ content: documents.content, syncedAt: documents.syncedAt, projectId: documents.projectId, machineId: documents.machineId })
      .from(documents)
      .where(and(...whereParts))
      .orderBy(desc(documents.syncedAt))
      .limit(20)
  ).filter((r) => Boolean(r.content));
  if (!rows.length) return null;
  if (preferMachine) {
    const same = rows.find((r) => r.machineId === preferMachine);
    if (same) return [same.content!, same.machineId];
  }
  const own = rows.find((r) => r.projectId === project.id) ?? rows[0]!;
  return [own.content!, own.machineId];
}

export async function projectRules(
  db: Db,
  redis: Redis | null,
  user: Pick<UserRow, "id">,
  project: Pick<typeof projects.$inferSelect, "title" | "slug">,
): Promise<string[]> {
  const content = await getPublishedProfileContent(db, redis, user);
  if (!content) return [];
  const scopes = splitProfileScopes(content);
  const keys = new Set([project.title, project.slug].filter((k): k is string => Boolean(k)).map((k) => normScopeName(k.split("/").pop()!)));
  const out: string[] = [];
  for (const [name, lines] of Object.entries(scopes.projects)) {
    if (keys.has(normScopeName(name))) {
      for (const line of lines) if (/^\s*[-*]/.test(line)) out.push(line);
    }
  }
  return out;
}

export function generationPrompt(projectName: string, rules: string[], hasFile: boolean): string {
  const ruleLines = rules.map((r) => `- ${r.replace(/^\s*[-*]\s*/, "")}`).join("\n") || "（画像里还没有这个项目的专属规则）";
  const action = hasFile
    ? "更新仓库根目录已有的 BUSINESS_BLUEPRINT.md：保留已有条目，修好失效的代码位置，补上缺的规则"
    : "在仓库根目录新建 BUSINESS_BLUEPRINT.md";
  return (
    `请为项目 ${projectName} ${action}。这是业务蓝图：项目应该做成什么样，每一条落在哪段代码、由哪个测试或检查保证，用来发现"用户定的规则和代码实现对不上"这类问题。\n\n` +
    `先读根目录代码蓝图 CODE_BLUEPRINT.md（旧版客户端生成的叫 PROJECT_BLUEPRINT.md）开头的「0. 速览与章节索引」了解代码结构。\n\n` +
    `这个项目的用户规则：\n${ruleLines}\n\n` +
    `写完后运行核对，直到没有 ❌：node ~/.memento/scripts/project_blueprint.mjs --business --root .`
  );
}
