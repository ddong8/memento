// Resident profile draft synthesis, publishing & user scope listing (server/server/services/profile_service.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import { cacheDeletePrefix } from "../cache";
import type { Settings } from "../config";
import type { Db } from "../db/client";
import { documents, learningEvals, machines, projects, userMemories, userProfiles } from "../db/pulled/schema";
import { callPlainChat, getAiProviders } from "./ai-provider";
import { fetchUserVoiceRows, planUserVoiceBatches, renderUserVoice } from "./dreaming-voice";
import { getDraftProfile, getPublishedProfile, sanitizeProfileContent, type UserProfileRow } from "./profile-read";
import { cleanDeviceName, normScopeName, PROFILE_MAX_CHARS, SCOPED_MAX_CHARS, splitProfileScopes } from "./profile-scopes";

export const PROFILE_VOICE_DAYS = 30;
export const PROJECT_ACTIVE_DAYS = 120;

const PROFILE_PROMPT = (args: {
  current: string;
  days: number;
  voice: string;
  memories: string;
  projects: string;
  devices: string;
  stubborn: string;
  compressionNote: string;
}) => `你在为一位用户维护一段"常驻画像"。它会在用户每次打开 Claude Code、Codex、Gemini 等 AI 工具时自动加载，让 AI 一开始就知道该怎么和这位用户协作。

## 当前已发布的画像
${args.current}

## 近期反复被违犯的高频红线（必须优先保留在常驻核心，严禁裁掉）
${args.stubborn}

## 用户最近 ${args.days} 天亲口说的话（只含用户本人输入）
${args.voice}

## 用户的偏好与铁律类长期记忆（按召回频次与正负反馈综合排序）
${args.memories}

## 用户的项目与设备（原话前的 [项目 @ 设备] 标注用的就是这些名字）
项目：${args.projects}
设备：${args.devices}

## 要求
- 在当前画像基础上增删改，不要无故重写。已有条目除非被新证据推翻，否则保留；不要为了给新内容腾地方删掉已有的高频通用条目。${args.compressionNote}
- 只写能指导 AI 行为的内容：沟通方式、必须遵守的规则、工作习惯、技术偏好。不写提交哈希、一次性任务。
- 通用部分不写某套具体系统的操作细节（某台服务器、某个集群、某个站点的命令、路径、版本号、账号）。这类内容能判断出属于哪个项目的，放进那个项目的小节；判断不出的，不写。放不下时，先合并语义重叠的条目，再将低频细节下沉到对应项目小节。
- 每条都必须能在上面的原话或记忆里找到依据；只在一次随口的话里出现过的，不写。
- 直接对 AI 下指令的祈使句（如"始终用中文回复"），不要写成"用户喜欢……"。
- 分清作用域。默认写成通用规矩；只在某个项目里才成立的（涉及那个项目的业务领域、数据格式、专有工具或目录，例如化学结构式、某个站点的字段），放进"## 项目：项目名"小节；只在某台设备上成立的（那台机器的磁盘、路径、本机服务），放进"## 设备：设备名"小节。项目名、设备名照抄上面列表里的写法。当前画像里已有的这类条目，按原话标注判断归属后挪过去；判断不出属于哪个项目的，保持通用。沟通方式、工作习惯这类到哪都适用的，即使只在一个项目里说过，也写成通用。
- Markdown。通用部分按这几个小标题分组，没有内容的省略：### 沟通、### 铁律、### 工作方式、### 技术偏好。项目、设备小节放在最后，条目直接写在小节下面，不再分小标题。每条一行，以"- "开头。
- 通用部分不超过 ${PROFILE_MAX_CHARS} 个字符（建议控制在 ${Math.floor(PROFILE_MAX_CHARS * 0.9)} 字以内以预留成长空间），每个项目或设备小节不超过 ${SCOPED_MAX_CHARS} 个字符。
- 只输出画像正文，不要解释、前言或代码块包裹。`;

export async function userScopes(db: Db, user: Pick<UserRow, "id">, days = PROJECT_ACTIVE_DAYS): Promise<[string[], string[]]> {
  const machineRows = await db.select().from(machines).where(eq(machines.userId, user.id));
  const devices = [...new Set(machineRows.map((m) => cleanDeviceName(m.name)).filter(Boolean))].sort();
  if (!machineRows.length) return [[], devices];

  const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
  const rows = await db
    .select({ title: projects.title, n: sql<number>`count(${documents.id})`.mapWith(Number) })
    .from(documents)
    .innerJoin(projects, eq(projects.id, documents.projectId))
    .where(and(inArray(documents.machineId, machineRows.map((m) => m.id)), sql`${documents.syncedAt} >= ${sinceIso}::timestamptz`))
    .groupBy(projects.title)
    .orderBy(desc(sql`max(${documents.syncedAt})`))
    .limit(40);

  const names = new Map<string, [string, number]>();
  for (const r of rows) {
    if (!r.title) continue;
    const key = normScopeName(r.title);
    const prev = names.get(key);
    if (!prev || r.n > prev[1]) names.set(key, [r.title, r.n]);
  }
  return [[...names.values()].map(([t]) => t), devices];
}

export async function publishProfile(db: Db, redis: Redis | null, user: Pick<UserRow, "id">, rawContent: string): Promise<UserProfileRow> {
  const content = sanitizeProfileContent(rawContent);
  if (!content) throw new Error("profile content is empty");
  const [maxRow] = await db
    .select({ v: sql<number>`coalesce(max(${userProfiles.version}), 0)` })
    .from(userProfiles)
    .where(eq(userProfiles.userId, user.id));
  const nextVer = Number(maxRow?.v ?? 0) + 1;
  const draft = await getDraftProfile(db, user);
  const nowIso = new Date().toISOString();

  let profile: UserProfileRow;
  if (draft) {
    const [updated] = await db
      .update(userProfiles)
      .set({ status: "published", version: nextVer, content, publishedAt: nowIso, updatedAt: nowIso })
      .where(eq(userProfiles.id, draft.id))
      .returning();
    profile = updated!;
  } else {
    const [inserted] = await db
      .insert(userProfiles)
      .values({
        id: randomUUID(),
        userId: user.id,
        status: "published",
        version: nextVer,
        content,
        stats: { source: "manual" },
        publishedAt: nowIso,
      })
      .returning();
    profile = inserted!;
  }
  await Promise.allSettled([
    cacheDeletePrefix(redis, `memory:resonance:${user.id}`),
    cacheDeletePrefix(redis, `learning:check:${user.id}`),
    cacheDeletePrefix(redis, `profile_content:${user.id}`),
    cacheDeletePrefix(redis, `profile_injection:${user.id}`),
    cacheDeletePrefix(redis, `user:blueprint:v4:${user.id}`),
  ]);
  return profile;
}

export async function buildProfileDraft(
  db: Db,
  settings: Settings,
  redis: Redis | null,
  user: UserRow,
): Promise<[UserProfileRow | null, string]> {
  if (!getAiProviders(settings, { background: true, user }).length) return [null, "no_llm"];
  const draft = await getDraftProfile(db, user);
  const draftStats = draft?.stats && typeof draft.stats === "object" ? (draft.stats as Record<string, unknown>) : {};
  if (draft && draftStats.edited_by_user) return [null, "user_editing"];

  const nowMs = Date.now();
  const sinceIso = new Date(nowMs - PROFILE_VOICE_DAYS * 86400_000).toISOString();
  const untilIso = new Date(nowMs).toISOString();
  const voiceRows = await fetchUserVoiceRows(db, user.id, sinceIso, untilIso, true);
  const { batches, stats: voiceStats } = planUserVoiceBatches(voiceRows);

  const rawMems = await db
    .select()
    .from(userMemories)
    .where(
      and(
        eq(userMemories.userId, user.id),
        inArray(userMemories.category, ["preference", "rule", "rules"]),
        eq(userMemories.isFolder, false),
        eq(userMemories.status, "active"),
      ),
    )
    .orderBy(desc(userMemories.updatedAt))
    .limit(120);
  const memories = rawMems
    .sort((a, b) => {
      const aScore = (a.source === "manual" ? 50 : 0) + Math.min(a.recallCount || 0, 30) + ((a.feedbackPos || 0) - (a.feedbackNeg || 0)) * 5 + (a.confidence ?? 0) * 10;
      const bScore = (b.source === "manual" ? 50 : 0) + Math.min(b.recallCount || 0, 30) + ((b.feedbackPos || 0) - (b.feedbackNeg || 0)) * 5 + (b.confidence ?? 0) * 10;
      return bScore - aScore;
    })
    .slice(0, 60);

  const published = await getPublishedProfile(db, user);
  const [projList, devList] = await userScopes(db, user);
  const voice = await renderUserVoice(settings, redis, user, batches);
  if (!voice && !memories.length) return [null, "no_input"];

  // Pull recently violated stubborn rules so profile synthesis never evicts high-risk redlines
  const [latestEval] = await db
    .select({ metrics: learningEvals.metrics })
    .from(learningEvals)
    .where(eq(learningEvals.userId, user.id))
    .orderBy(desc(learningEvals.week))
    .limit(1);
  const evalMetrics = latestEval?.metrics && typeof latestEval.metrics === "object" ? (latestEval.metrics as Record<string, unknown>) : {};
  const stubbornArr = Array.isArray(evalMetrics.stubborn) ? (evalMetrics.stubborn as { statement?: string; times?: number }[]) : [];
  const stubbornLines = stubbornArr
    .filter((x) => x && typeof x.statement === "string" && x.statement.trim())
    .map((x) => `- [近期再犯 ${x.times ?? 1} 次] ${x.statement!.trim()}`)
    .join("\n");

  const currentGeneralLen = published?.content ? splitProfileScopes(published.content).general.length : 0;
  const compressionNote =
    currentGeneralLen >= Math.floor(PROFILE_MAX_CHARS * 0.85)
      ? `\n- 重要：当前通用段已达 ${currentGeneralLen}/${PROFILE_MAX_CHARS} 字符（接近满载），请主动合并语义相近或措辞啰嗦的条目，将项目专属细则挪入「## 项目：...」小节，把通用段压缩至 ${Math.floor(PROFILE_MAX_CHARS * 0.88)} 字符以内，确保新学到的高频铁律不被截断。`
      : "";

  const memoryLines = memories
    .map((m) => `- [${m.category}·召回${m.recallCount || 0}] ${m.content.trim().slice(0, 200)}`)
    .join("\n");
  const raw = await callPlainChat(
    settings,
    redis,
    [
      { role: "system", content: "You maintain a concise user profile for AI assistants. Output only the profile body." },
      {
        role: "user",
        content: PROFILE_PROMPT({
          current: published?.content || "（尚无）",
          days: PROFILE_VOICE_DAYS,
          voice: voice || "（无）",
          memories: memoryLines || "（无）",
          projects: projList.join("、") || "（无）",
          devices: devList.join("、") || "（无）",
          stubborn: stubbornLines || "（无）",
          compressionNote,
        }),
      },
    ],
    { maxTokens: 6000, timeoutSec: 180, background: true, user },
  );
  const content = sanitizeProfileContent(raw);
  if (!content) return [null, "llm_failed"];
  if (published && content === published.content.trim()) return [null, "same_as_published"];

  const nowIso = new Date(nowMs).toISOString();
  const stats = { user_voice: voiceStats, memories: memories.length, generated_at: nowIso.replace("Z", "+00:00") };
  if (draft) {
    const [updated] = await db
      .update(userProfiles)
      .set({ content, stats, updatedAt: nowIso })
      .where(eq(userProfiles.id, draft.id))
      .returning();
    return [updated ?? draft, "updated"];
  }
  const [inserted] = await db
    .insert(userProfiles)
    .values({ id: randomUUID(), userId: user.id, status: "draft", content, stats, createdAt: nowIso, updatedAt: nowIso })
    .returning();
  return [inserted ?? null, "updated"];
}
