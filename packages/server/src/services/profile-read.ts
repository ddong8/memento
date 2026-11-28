// Resident profile read/format/sanitize helpers (server/server/services/profile_service.py).
import { and, desc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import { cacheGet, cacheSet } from "../cache";
import type { Db } from "../db/client";
import { userProfiles } from "../db/pulled/schema";
import {
  cleanDeviceName,
  joinProfileScopes,
  normScopeName,
  PROFILE_BEGIN,
  PROFILE_END,
  PROFILE_MAX_CHARS,
  SCOPED_MAX_CHARS,
  splitProfileScopes,
} from "./profile-scopes";

export type UserProfileRow = typeof userProfiles.$inferSelect;

export const DEVICE_PITFALLS_HEADING = "### 这台设备上反复踩过的坑";
export const DEVICE_PITFALLS_NOTE = "Memento 每晚复盘自动整理：近 30 天在这台设备上又遇到过的环境问题，做相关操作时直接用后面的办法。";
const PITFALL_PARTS_RE = /^(?:【([^】]{1,60})】)?(.+?)。现象：.*?；解决：(.+)$/s;
const PRIVATE_IP_RE =
  /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})(?::\d+)?\b/g;
const SECRET_RE = /\b(?:sk|ghp|gho|ghs|github_pat|xox[bp])[-_][A-Za-z0-9_-]{12,}/g;
const PITFALL_FIX_CHARS = 120;

export interface ProfileSaturation {
  general_chars: number;
  general_limit: number;
  ratio: number;
  saturated: boolean;
}

export function profileSaturation(content: string | null | undefined): ProfileSaturation {
  const scopes = splitProfileScopes(content || "");
  const general_chars = scopes.general.length;
  const ratio = Math.round((general_chars / PROFILE_MAX_CHARS) * 1000) / 1000;
  return {
    general_chars,
    general_limit: PROFILE_MAX_CHARS,
    ratio,
    saturated: ratio >= 0.9,
  };
}

export function capText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const sections: number[][] = [[]];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith("#")) sections.push([]);
    else if (line.trim()) sections[sections.length - 1]!.push(i);
  }
  const dropped = new Set<number>();
  let size = text.length;
  while (size > limit) {
    let longestIdx = -1;
    let longestLen = -1;
    for (let s = 0; s < sections.length; s++) {
      const sec = sections[s]!;
      const len = sec.reduce((acc, idx) => acc + lines[idx]!.length + 1, 0);
      if (len > longestLen) {
        longestLen = len;
        longestIdx = s;
      }
    }
    if (longestIdx === -1 || !sections[longestIdx]!.length) break;
    const sec = sections[longestIdx]!;
    // Protect the most recently appended rule (tail) when the section has >= 2 lines:
    // drop the most verbose earlier line first to recover maximum character budget.
    let dropPos = sec.length - 1;
    if (sec.length >= 2) {
      let maxLineLen = -1;
      for (let p = 0; p < sec.length - 1; p++) {
        const l = lines[sec[p]!]!.length;
        if (l > maxLineLen) {
          maxLineLen = l;
          dropPos = p;
        }
      }
    }
    const [i] = sec.splice(dropPos, 1);
    if (i === undefined) break;
    dropped.add(i);
    size -= lines[i]!.length + 1;
  }
  const kept = lines.filter((_, i) => !dropped.has(i));
  const out: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i]!;
    if (line.trimStart().startsWith("#")) {
      const following = kept.slice(i + 1).find((x) => x.trim()) ?? "";
      if (!following || following.trimStart().startsWith("#")) continue;
    }
    out.push(line);
  }
  let result = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (result.length > limit) {
    const cut = result.lastIndexOf("\n", limit);
    result = result.slice(0, cut > 0 ? cut : limit).trimEnd();
  }
  return result;
}

export function deduplicateRuleLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith("-") || stripped.startsWith("*")) {
      const norm = stripped
        .replace(/^[-*• \t]+/, "")
        .toLowerCase()
        .replace(/[\s，,。；;！!]+/g, "");
      if (seen.has(norm)) continue;
      seen.add(norm);
    }
    deduped.push(line);
  }
  return deduped;
}

export function sanitizeProfileContent(text: string | null | undefined): string {
  if (!text) return "";
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    const nl = cleaned.indexOf("\n");
    cleaned = nl >= 0 ? cleaned.slice(nl + 1) : cleaned;
    if (cleaned.trimEnd().endsWith("```")) cleaned = cleaned.trimEnd().slice(0, -3);
  }
  cleaned = cleaned.replaceAll("<!--", "").replaceAll("-->", "").trim();
  const scopes = splitProfileScopes(cleaned);
  scopes.general = capText(deduplicateRuleLines(scopes.general.split("\n")).join("\n"), PROFILE_MAX_CHARS);
  for (const bucket of [scopes.projects, scopes.devices]) {
    for (const [name, lines] of Object.entries(bucket)) {
      const deduped = deduplicateRuleLines(lines);
      bucket[name] = deduped.length ? capText(deduped.join("\n"), SCOPED_MAX_CHARS).split("\n") : [];
    }
  }
  return joinProfileScopes(scopes);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function pitfallLine(content: string): string {
  let text = (content || "").replaceAll("<!--", "").replaceAll("-->", "").replace(/\s+/g, " ").trim();
  text = text.replace(PRIVATE_IP_RE, "内网地址").replace(SECRET_RE, "***");
  const m = PITFALL_PARTS_RE.exec(text);
  if (!m) return `- ${clip(text, PITFALL_FIX_CHARS + 40)}`;
  const head = m[1] ? `【${m[1]}】` : "";
  return `- ${head}${m[2]!.trim()}：${clip(m[3]!.trim(), PITFALL_FIX_CHARS)}`;
}

export function pickDevicePitfalls(pitfalls: readonly string[]): [number, string][] {
  let used = DEVICE_PITFALLS_HEADING.length + DEVICE_PITFALLS_NOTE.length + 2;
  const picked: [number, string][] = [];
  for (let i = 0; i < pitfalls.length; i++) {
    const line = pitfallLine(pitfalls[i]!);
    if (picked.some(([, seen]) => seen === line)) continue;
    if (used + line.length + 1 > SCOPED_MAX_CHARS) break;
    picked.push([i, line]);
    used += line.length + 1;
  }
  return picked;
}

export function renderDeviceProfile(
  content: string,
  deviceName: string,
  projectsHere: Record<string, string>,
  pitfalls: readonly string[] = [],
): string {
  const scopes = splitProfileScopes(content);
  const parts: string[] = scopes.general ? [scopes.general] : [];
  const deviceKey = normScopeName(cleanDeviceName(deviceName));
  const own: string[] = [];
  for (const [name, lines] of Object.entries(scopes.devices)) {
    if (normScopeName(cleanDeviceName(name)) === deviceKey) own.push(...lines);
  }
  if (own.length) parts.push(`### 本机专属\n${own.join("\n")}`);
  const picked = pickDevicePitfalls(pitfalls);
  if (picked.length) {
    parts.push(`${DEVICE_PITFALLS_HEADING}\n${DEVICE_PITFALLS_NOTE}\n${picked.map(([, l]) => l).join("\n")}`);
  }
  const paths = new Map<string, string>();
  for (const [name, path] of Object.entries(projectsHere)) paths.set(normScopeName(name), path);
  const here: [string, string, string[]][] = [];
  for (const [name, lines] of Object.entries(scopes.projects)) {
    const p = paths.get(normScopeName(name));
    if (lines.length && p) here.push([name, p, lines]);
  }
  if (here.length) {
    const sections = here.map(([name, path, lines]) => `#### ${name}（\`${path}\`）\n${lines.join("\n")}`);
    parts.push(`### 只在对应项目里适用\n在下面这些目录（含子目录）里工作时才适用，在其他项目里忽略。\n\n${sections.join("\n\n")}`);
  }
  return parts.join("\n\n");
}

export function renderProfileBlock(version: number, content: string): string {
  return (
    `${PROFILE_BEGIN} v${version} · 由 Memento 生成，请在 Memento 中修改，手改此段会被覆盖 -->\n` +
    "## 关于我（Memento 长期记忆）\n\n" +
    `${content.trim()}\n\n` +
    "进入项目或排查架构问题时，若项目根目录存在 CODE_BLUEPRINT.md（代码蓝图；旧版客户端生成的叫 PROJECT_BLUEPRINT.md），先读开头「0. 速览与章节索引」，再按索引里的行号只读需要的章节，避免整份读入或盲目全库 grep。\n" +
    "项目根目录若有 BUSINESS_BLUEPRINT.md（业务蓝图：用户定的业务规则、术语、流程、状态归属，各挂代码位置和测试），改动前先看开头索引里相关的条目；改了条目里列出的代码，确认规则仍成立；用户提出新的长期规则时按其格式补一条。\n" +
    "需要了解用户的跨项目工程版图、全域技术栈、核心业务领域与学科交叉背景时，读 ~/.memento/USER_BLUEPRINT.md（个人全域蓝图）开头的「0. 速览」。\n" +
    "需要更多上下文时，用 memento-memory MCP 的 memory_search / memory_core / memory_blueprint 查询。\n" +
    `${PROFILE_END}\n`
  );
}

export async function getPublishedProfile(db: Db, user: { id: string }): Promise<UserProfileRow | null> {
  const [row] = await db
    .select()
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, user.id), eq(userProfiles.status, "published")))
    .orderBy(desc(userProfiles.version))
    .limit(1);
  return row ?? null;
}

export async function getDraftProfile(db: Db, user: { id: string }): Promise<UserProfileRow | null> {
  const [row] = await db
    .select()
    .from(userProfiles)
    .where(and(eq(userProfiles.userId, user.id), eq(userProfiles.status, "draft")))
    .orderBy(desc(userProfiles.updatedAt))
    .limit(1);
  return row ?? null;
}

export async function getPublishedProfileContent(db: Db, redis: Redis | null, user: { id: string }): Promise<string | null> {
  const cacheKey = `profile_content:${user.id}`;
  try {
    const cached = await cacheGet(redis, cacheKey);
    if (cached && typeof cached === "object" && "content" in (cached as Record<string, unknown>)) {
      const c = (cached as { content?: string }).content;
      return c ? c : null;
    }
  } catch {
    /* ignore */
  }
  const prof = await getPublishedProfile(db, user);
  const content = prof?.content?.trim() ? prof.content.trim() : "";
  await cacheSet(redis, cacheKey, { content }, 3600).catch(() => {});
  return content || null;
}
