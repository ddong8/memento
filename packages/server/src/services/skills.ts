// Skills business logic (server/server/services/skill_service.py).
import { createHash } from "node:crypto";

import { and, count, eq, isNotNull, ne } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Db } from "../db/client";
import { machines, skills } from "../db/pulled/schema";
import { pgToIso } from "../pytime";
import { profileTargets } from "./profile-targets";

export type SkillRow = typeof skills.$inferSelect;
export type MachineRow = typeof machines.$inferSelect;

export const SLUG_MAX = 64;
export const DESCRIPTION_MAX = 1024;
export const TITLE_MAX = 120;
export const BODY_MAX = 20000;
export const EVIDENCE_KEEP = 10;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SKILL_DIR_FOR_TARGET: Record<string, string> = {
  claude_code: "claude",
  codex: "agents",
  antigravity: "agents",
  workbuddy: "workbuddy",
};

/** Python str[:n] slices by Unicode code points, not UTF-16 code units. */
function pySlice(s: string, n: number): string {
  const cp = [...s];
  return cp.length <= n ? s : cp.slice(0, n).join("");
}

export function isValidSlug(slug: string): boolean {
  return Boolean(slug) && slug.length <= SLUG_MAX && SLUG_RE.test(slug);
}

export function slugify(text: string | null | undefined, fallbackSeed = ""): string {
  let s = (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  s = s.replace(/-{2,}/g, "-").slice(0, SLUG_MAX).replace(/^-+|-+$/g, "");
  if (!s) {
    s = "skill-" + createHash("sha1").update(fallbackSeed || text || "").digest("hex").slice(0, 8);
  }
  return s;
}

export async function uniqueSlug(db: Db, user: Pick<UserRow, "id">, base: string, excludeId?: string): Promise<string> {
  const cleanBase = slugify(base);
  const rows = await db
    .select({ slug: skills.slug })
    .from(skills)
    .where(excludeId ? and(eq(skills.userId, user.id), ne(skills.id, excludeId)) : eq(skills.userId, user.id));
  const taken = new Set(rows.map((r) => r.slug));
  if (!taken.has(cleanBase)) return cleanBase;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = cleanBase.slice(0, SLUG_MAX - suffix.length).replace(/^-+|-+$/g, "") + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return slugify("", `${cleanBase}${new Date().toISOString()}`);
}

export function oneLine(text: string | null | undefined, limit: number): string {
  return pySlice((text ?? "").replace(/\s+/g, " ").trim(), limit);
}

export function cleanBody(text: string | null | undefined): string {
  return pySlice((text ?? "").replace(/\r\n/g, "\n").trim(), BODY_MAX);
}

export function renderSkillMd(skill: Pick<SkillRow, "slug" | "description" | "id" | "version" | "title" | "body">): string {
  const description = oneLine(skill.description, DESCRIPTION_MAX);
  return (
    "---\n" +
    `name: ${skill.slug}\n` +
    `description: ${JSON.stringify(description)}\n` +
    "metadata:\n" +
    "  source: memento\n" +
    `  memento-id: "${skill.id}"\n` +
    `  memento-version: ${skill.version}\n` +
    "---\n\n" +
    `# ${oneLine(skill.title, TITLE_MAX)}\n\n` +
    `${cleanBody(skill.body)}\n`
  );
}

export function skillOut(skill: SkillRow, full = true): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: skill.id,
    slug: skill.slug,
    title: skill.title,
    description: skill.description,
    project: skill.project,
    status: skill.status,
    version: skill.version,
    times_seen: skill.timesSeen,
    edited_by_user: skill.editedByUser,
    has_update: Boolean(skill.pendingUpdate),
    evidence: Array.isArray(skill.evidence) ? skill.evidence : [],
    first_seen_at: pgToIso(skill.firstSeenAt),
    last_seen_at: pgToIso(skill.lastSeenAt),
    published_at: pgToIso(skill.publishedAt),
    updated_at: pgToIso(skill.updatedAt),
  };
  if (full) {
    out.body = skill.body;
    out.pending_update = skill.pendingUpdate ?? null;
    out.skill_md = renderSkillMd(skill);
  }
  return out;
}

export interface SkillEdits {
  title?: string;
  description?: string;
  body?: string;
  slug?: string;
  project?: string;
}

export async function buildSkillEditPatch(
  db: Db,
  user: Pick<UserRow, "id">,
  skill: SkillRow,
  edits: SkillEdits,
): Promise<Partial<typeof skills.$inferInsert>> {
  const patch: Partial<typeof skills.$inferInsert> = {};
  if (edits.title !== undefined) {
    patch.title = oneLine(edits.title, TITLE_MAX) || skill.title;
  }
  if (edits.description !== undefined) {
    const desc = oneLine(edits.description, DESCRIPTION_MAX);
    if (!desc) throw new Error("说明不能为空：AI 靠它判断什么时候用这个技能");
    patch.description = desc;
  }
  if (edits.body !== undefined) {
    const body = cleanBody(edits.body);
    if (!body) throw new Error("步骤不能为空");
    patch.body = body;
  }
  if (edits.project !== undefined) {
    patch.project = oneLine(edits.project, 120) || null;
  }
  if (edits.slug !== undefined && edits.slug !== skill.slug) {
    const slug = String(edits.slug).trim().toLowerCase();
    if (!isValidSlug(slug)) throw new Error("名称只能用小写字母、数字和单个连字符，最长 64 个字符");
    if ((await uniqueSlug(db, user, slug, skill.id)) !== slug) throw new Error(`已经有叫 ${slug} 的技能了`);
    patch.slug = slug;
  }
  patch.editedByUser = true;
  return patch;
}

export async function injectionFor(db: Db, user: Pick<UserRow, "id">, machine: MachineRow) {
  const dirs = [...new Set(profileTargets(machine).map((t) => SKILL_DIR_FOR_TARGET[t]).filter((x): x is string => Boolean(x)))].sort();
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.status, "published")))
    .orderBy(skills.slug);
  return {
    targets: dirs,
    skills: rows.map((s) => ({
      slug: s.slug,
      version: s.version,
      id: s.id,
      content: renderSkillMd(s),
    })),
  };
}

export async function skillCounts(db: Db, user: Pick<UserRow, "id">) {
  const rows = await db
    .select({ status: skills.status, n: count() })
    .from(skills)
    .where(eq(skills.userId, user.id))
    .groupBy(skills.status);
  const counts = new Map(rows.map((r) => [r.status, Number(r.n)]));
  const [pending] = await db
    .select({ n: count() })
    .from(skills)
    .where(and(eq(skills.userId, user.id), eq(skills.status, "published"), isNotNull(skills.pendingUpdate)));
  return {
    draft: counts.get("draft") ?? 0,
    published: counts.get("published") ?? 0,
    dismissed: counts.get("dismissed") ?? 0,
    retired: counts.get("retired") ?? 0,
    updates: Number(pending?.n ?? 0),
  };
}
