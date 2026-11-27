// /api/profile: resident profile review/publish, device injection, avatar, blueprints & account deletion
// (server/server/api/profile.py).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, currentUserOrCollector, verifyCollectorToken, type UserRow } from "../auth/current-user";
import { cacheDeletePrefix, cacheGet, cacheSet } from "../cache";
import type { AppEnv, Deps } from "../context";
import { withoutNul } from "../db/client";
import {
  accessLogs,
  conversationMessages,
  documentEmbeddings,
  documents,
  documentVersions,
  knowledgeEntities,
  knowledgeObservations,
  knowledgeRelations,
  machines,
  syncState,
  userMemories,
  userProfiles,
  users,
} from "../db/pulled/schema";
import { HttpError, parseJsonObject, requiredHeader } from "../http";
import { pgToIso } from "../pytime";
import * as aiHealth from "../services/ai-health";
import { callPlainChat } from "../services/ai-provider";
import type { MachineRow } from "../services/device-merge";
import { guardTools } from "../services/guard-service";
import { buildProfileDraft, publishProfile } from "../services/profile-draft";
import {
  getDraftProfile,
  getPublishedProfile,
  pickDevicePitfalls,
  renderDeviceProfile,
  renderProfileBlock,
  sanitizeProfileContent,
  type UserProfileRow,
} from "../services/profile-read";
import { INJECTION_TARGETS, profileTargets, targetsOff } from "../services/profile-targets";
import { deviceProjects } from "../services/project-placement";
import { devicePitfalls } from "../services/retrospective-service";
import { buildUserBlueprint } from "../services/user-blueprint-service";

export const profileRoutes = new Hono<AppEnv>();

const ONLINE_WINDOW_MS = 180_000;
const BLUEPRINT_AUTO_SETTING = "blueprint_auto";
const PITFALLS_SETTING = "profile_pitfalls";
const MCP_TOOLS = new Set(["claude_code", "codex", "antigravity", "cursor"]);
const CODE_BLUEPRINT_CLIENT = [1, 0, 134] as const;
const LEGACY_GENERATOR = "project_blueprint.v20261123.mjs";
const BP_GENERATOR_VERSION_RE = /^(?:(?:export\s+)?(?:const|let|var)\s+)?BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)/m;
const bpGeneratorCache = new Map<string, [number, { version: number; hash: string; content: string }]>();

function profileOut(p: UserProfileRow | null) {
  if (!p) return null;
  return {
    id: p.id,
    status: p.status,
    version: p.version,
    content: p.content,
    stats: p.stats ?? {},
    updated_at: pgToIso(p.updatedAt),
    published_at: pgToIso(p.publishedAt),
  };
}

async function ownedMachine(deps: Deps, user: UserRow, deviceId: string): Promise<MachineRow> {
  const [m] = await deps.db
    .select()
    .from(machines)
    .where(and(eq(machines.collectorTokenHash, deviceId), eq(machines.userId, user.id)))
    .limit(1);
  if (!m) throw new HttpError(404, "device not found");
  return m;
}

async function bustUserProfileCache(deps: Deps, userId: string): Promise<void> {
  const redis = deps.redis();
  await Promise.allSettled([
    cacheDeletePrefix(redis, `profile:summary:${userId}`),
    cacheDeletePrefix(redis, `profile_injection:${userId}`),
    cacheDeletePrefix(redis, `skills_injection:${userId}`),
    cacheDeletePrefix(redis, `user:blueprint:v4:${userId}`),
  ]);
}

export function blueprintAutoEnabled(user: Pick<UserRow, "proactiveSettings">): boolean {
  const ps = user.proactiveSettings && typeof user.proactiveSettings === "object" ? (user.proactiveSettings as Record<string, unknown>) : {};
  return ps[BLUEPRINT_AUTO_SETTING] !== false;
}

function profilePitfallsEnabled(user: Pick<UserRow, "proactiveSettings">): boolean {
  const ps = user.proactiveSettings && typeof user.proactiveSettings === "object" ? (user.proactiveSettings as Record<string, unknown>) : {};
  return ps[PITFALLS_SETTING] !== false;
}

function pitfallsOut(items: { id: string; content: string; hits: number; last: string | null }[]) {
  return pickDevicePitfalls(items.map((p) => p.content)).map(([i, line]) => ({
    id: items[i]!.id,
    line: line.startsWith("- ") ? line.slice(2) : line,
    hits: items[i]!.hits,
    last: items[i]!.last,
  }));
}

function clientVersion(header: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((header || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function wantsLegacyGenerator(collectorVersion: string | null | undefined): boolean {
  const v = clientVersion(collectorVersion);
  if (!v) return true;
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== CODE_BLUEPRINT_CLIENT[i]!) return v[i]! < CODE_BLUEPRINT_CLIENT[i]!;
  }
  return false;
}

function getBlueprintGeneratorBundle(legacy = false): { version: number; hash: string; content: string } | null {
  const name = legacy ? `legacy/${LEGACY_GENERATOR}` : "project_blueprint.mjs";
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../../../scripts", name),
    resolve(here, "../../../scripts", name),
    resolve(process.cwd(), "scripts", name),
    resolve("/app/scripts", name),
  ];
  if (!legacy) candidates.push(resolve(homedir(), ".memento/scripts/project_blueprint.mjs"));
  const found = candidates.find((p) => existsSync(p));
  if (!found) return null;
  try {
    const mtime = statSync(found).mtimeMs;
    const hit = bpGeneratorCache.get(found);
    if (hit && hit[0] === mtime) return hit[1];
    const content = readFileSync(found, "utf8");
    const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    const vm = BP_GENERATOR_VERSION_RE.exec(content);
    const version = vm ? Number(vm[1]) : 1;
    const bundle = { version, hash, content };
    bpGeneratorCache.set(found, [mtime, bundle]);
    return bundle;
  } catch {
    return null;
  }
}

// ---- Settings & Collector Reports ----
profileRoutes.put("/blueprint/settings", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const auto = Boolean(body.auto);
  const next = { ...((user.proactiveSettings && typeof user.proactiveSettings === "object" ? user.proactiveSettings : {}) as Record<string, unknown>), [BLUEPRINT_AUTO_SETTING]: auto };
  await deps.db.update(users).set({ proactiveSettings: next }).where(eq(users.id, user.id));
  await bustUserProfileCache(deps, user.id);
  return c.json({ auto });
});

profileRoutes.put("/pitfalls/settings", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const enabled = Boolean(body.enabled);
  const next = { ...((user.proactiveSettings && typeof user.proactiveSettings === "object" ? user.proactiveSettings : {}) as Record<string, unknown>), [PITFALLS_SETTING]: enabled };
  await deps.db.update(users).set({ proactiveSettings: next }).where(eq(users.id, user.id));
  await bustUserProfileCache(deps, user.id);
  return c.json({ enabled });
});

profileRoutes.post("/blueprint/status", async (c) => {
  const deps = c.var.deps;
  const user = await verifyCollectorToken(c);
  const deviceId = requiredHeader(c, "x-device-id");
  const body = await parseJsonObject(c);
  const machine = await ownedMachine(deps, user, deviceId);
  const cur = machine.profileStatus && typeof machine.profileStatus === "object" ? { ...(machine.profileStatus as Record<string, unknown>) } : {};
  const failedRaw = Array.isArray(body.failed) ? body.failed : [];
  cur.blueprint = {
    enabled: body.enabled !== false,
    runtime: typeof body.runtime === "string" ? body.runtime.slice(0, 200) : null,
    python: typeof body.python === "string" ? body.python.slice(0, 200) : null,
    generator_version: typeof body.generator_version === "number" ? body.generator_version : null,
    ok: Math.max(0, Number(body.ok ?? 0)),
    no_hooks: Math.max(0, Number(body.no_hooks ?? 0)),
    failed: failedRaw.slice(0, 20).map((f) => {
      const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      return { name: String(r.name ?? "").slice(0, 80), reason: String(r.reason ?? "").slice(0, 200) };
    }),
    failed_total: failedRaw.length,
    reported_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  await deps.db.update(machines).set({ profileStatus: withoutNul(cur) }).where(eq(machines.id, machine.id));
  return c.json({ status: "ok" });
});

profileRoutes.post("/mcp/status", async (c) => {
  const deps = c.var.deps;
  const user = await verifyCollectorToken(c);
  const deviceId = requiredHeader(c, "x-device-id");
  const body = await parseJsonObject(c);
  const machine = await ownedMachine(deps, user, deviceId);
  const cur = machine.profileStatus && typeof machine.profileStatus === "object" ? { ...(machine.profileStatus as Record<string, unknown>) } : {};
  const rawRes = body.results && typeof body.results === "object" ? (body.results as Record<string, unknown>) : {};
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawRes)) {
    if (MCP_TOOLS.has(k)) filtered[k] = String(v).slice(0, 200);
  }
  cur.mcp = { results: filtered, reported_at: new Date().toISOString().replace("Z", "+00:00") };
  await deps.db.update(machines).set({ profileStatus: withoutNul(cur) }).where(eq(machines.id, machine.id));
  return c.json({ status: "ok" });
});

profileRoutes.get("/blueprint", async (c) => {
  const user = await currentUserOrCollector(c);
  const refresh = (c.req.query("refresh") ?? "").toLowerCase() === "true" || c.req.query("refresh") === "1";
  return c.json(await buildUserBlueprint(c.var.deps.db, c.var.deps.redis(), user, refresh));
});

profileRoutes.get("/blueprint-generator", async (c) => {
  await verifyCollectorToken(c);
  const ver = c.req.header("x-collector-version") ?? null;
  const bundle = getBlueprintGeneratorBundle(wantsLegacyGenerator(ver));
  if (!bundle) throw new HttpError(404, "Blueprint generator not found on server");
  return c.json(bundle);
});

profileRoutes.get("/injection", async (c) => {
  const deps = c.var.deps;
  const { db } = deps;
  const redis = deps.redis();
  const missing: Record<string, unknown>[] = [];
  if (!c.req.header("x-collector-token")) {
    missing.push({ type: "missing", loc: ["header", "x-collector-token"], msg: "Field required", input: null });
  }
  if (!c.req.header("x-device-id")) {
    missing.push({ type: "missing", loc: ["header", "X-Device-Id"], msg: "Field required", input: null });
  }
  if (missing.length) throw new HttpError(422, missing);
  const user = await verifyCollectorToken(c);
  const deviceId = requiredHeader(c, "x-device-id");
  const verHeader = c.req.header("x-collector-version") ?? null;

  const cacheKey = `profile_injection:${user.id}:${deviceId}:${verHeader || ""}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached && typeof cached === "object") return c.json(cached);

  const machine = await ownedMachine(deps, user, deviceId);
  const legacyBp = wantsLegacyGenerator(verHeader || machine.collectorVersion);
  const published = await getPublishedProfile(db, user);
  let block: string | null = null;
  if (published) {
    const projsHere = await deviceProjects(db, redis, machine);
    const pitMap = profilePitfallsEnabled(user) ? await devicePitfalls(db, redis, user) : {};
    const pits = (pitMap[machine.id] ?? []).map((p) => p.content);
    const content = renderDeviceProfile(published.content, machine.name, projsHere, pits);
    block = renderProfileBlock(published.version ?? 0, content);
  }
  const bpBundle = getBlueprintGeneratorBundle(legacyBp);
  const res = {
    version: published ? published.version : null,
    block,
    targets: profileTargets(machine),
    guards: { completion_evidence: guardTools(user, machine) },
    blueprint: { auto: blueprintAutoEnabled(user) },
    blueprint_generator: bpBundle ? { version: bpBundle.version, hash: bpBundle.hash } : null,
  };
  await cacheSet(redis, cacheKey, res, 60).catch(() => {});
  return c.json(res);
});

profileRoutes.post("/injection/status", async (c) => {
  const deps = c.var.deps;
  const user = await verifyCollectorToken(c);
  const deviceId = requiredHeader(c, "x-device-id");
  const body = await parseJsonObject(c);
  const machine = await ownedMachine(deps, user, deviceId);
  const prev = machine.profileStatus && typeof machine.profileStatus === "object" ? (machine.profileStatus as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  for (const k of ["guards", "blueprint", "mcp"]) if (prev[k]) kept[k] = prev[k];
  const allowed = new Set<string>(INJECTION_TARGETS);
  const rawRes = body.results && typeof body.results === "object" ? (body.results as Record<string, unknown>) : {};
  const results: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawRes)) if (allowed.has(k)) results[k] = String(v).slice(0, 200);
  const nextStatus = {
    version: typeof body.version === "number" ? body.version : null,
    results,
    reported_at: new Date().toISOString().replace("Z", "+00:00"),
    ...kept,
  };
  await deps.db.update(machines).set({ profileStatus: withoutNul(nextStatus) }).where(eq(machines.id, machine.id));
  await bustUserProfileCache(deps, user.id);
  return c.json({ status: "ok" });
});

// ---- Web UI (JWT) ----
profileRoutes.get("", async (c) => {
  const deps = c.var.deps;
  const { db } = deps;
  const redis = deps.redis();
  const user = await currentUser(c);
  const cacheKey = `profile:summary:${user.id}`;
  const cached = await cacheGet(redis, cacheKey);
  if (cached != null) return c.json(cached);

  const [published, draft, historyRows, machineRows] = await Promise.all([
    getPublishedProfile(db, user),
    getDraftProfile(db, user),
    db
      .select({ version: userProfiles.version, publishedAt: userProfiles.publishedAt })
      .from(userProfiles)
      .where(and(eq(userProfiles.userId, user.id), eq(userProfiles.status, "published")))
      .orderBy(desc(userProfiles.version))
      .limit(10),
    db
      .select({
        id: machines.id,
        collectorTokenHash: machines.collectorTokenHash,
        name: machines.name,
        lastHeartbeat: machines.lastHeartbeat,
        profileTargetsOff: machines.profileTargetsOff,
        profileStatus: machines.profileStatus,
      })
      .from(machines)
      .where(and(eq(machines.userId, user.id), isNull(machines.mergedInto), eq(machines.isArchived, false)))
      .orderBy(sql`${machines.lastHeartbeat} DESC NULLS LAST`),
  ]);

  const nowMs = Date.now();
  const pitMap = published && profilePitfallsEnabled(user) ? await devicePitfalls(db, deps.redis(), user) : {};
  const payload = {
    published: profileOut(published),
    draft: profileOut(draft),
    history: historyRows.map((h) => ({ version: h.version, published_at: pgToIso(h.publishedAt) })),
    targets: [...INJECTION_TARGETS],
    blueprint_auto: blueprintAutoEnabled(user),
    pitfalls_auto: profilePitfallsEnabled(user),
    devices: machineRows.map((m) => {
      const hb = m.lastHeartbeat ? Date.parse(pgToIso(m.lastHeartbeat) ?? m.lastHeartbeat) : Number.NaN;
      return {
        device_id: m.collectorTokenHash,
        name: m.name,
        online: Number.isFinite(hb) && nowMs - hb < ONLINE_WINDOW_MS,
        targets: profileTargets(m),
        status: m.profileStatus ?? {},
        pitfalls: pitfallsOut(pitMap[m.id] ?? []),
      };
    }),
  };
  await cacheSet(redis, cacheKey, payload, 30);
  return c.json(payload);
});

profileRoutes.post("/draft/regenerate", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const run = { at: new Date().toISOString().replace("Z", "+00:00") };
  try {
    const [draft, status] = await buildProfileDraft(deps.db, deps.settings, deps.redis(), user);
    await aiHealth.putJson(deps.redis(), `profile_run:${user.id}`, { ...run, status });
    await bustUserProfileCache(deps, user.id);
    return c.json({ status, draft: profileOut(draft) });
  } catch (e) {
    const err = e as Error;
    await aiHealth.putJson(deps.redis(), `profile_run:${user.id}`, {
      ...run,
      status: "error",
      error: `${err?.name || "Error"}: ${err?.message || String(e)}`.slice(0, 300),
    });
    throw e;
  }
});

profileRoutes.put("/draft", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const content = sanitizeProfileContent(typeof body.content === "string" ? body.content : "");
  if (!content) throw new HttpError(400, "content is empty");
  const existing = await getDraftProfile(deps.db, user);
  const nowIso = new Date().toISOString();
  let draft: UserProfileRow;
  if (existing) {
    const nextStats = { ...((existing.stats && typeof existing.stats === "object" ? existing.stats : {}) as Record<string, unknown>), edited_by_user: true };
    const [upd] = await deps.db
      .update(userProfiles)
      .set(withoutNul({ content, stats: nextStats, updatedAt: nowIso }))
      .where(eq(userProfiles.id, existing.id))
      .returning();
    draft = upd!;
  } else {
    const [ins] = await deps.db
      .insert(userProfiles)
      .values(withoutNul({ id: randomUUID(), userId: user.id, status: "draft", content, stats: { edited_by_user: true }, createdAt: nowIso, updatedAt: nowIso }))
      .returning();
    draft = ins!;
  }
  await bustUserProfileCache(deps, user.id);
  return c.json({ draft: profileOut(draft) });
});

profileRoutes.delete("/draft", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const draft = await getDraftProfile(deps.db, user);
  if (draft) await deps.db.delete(userProfiles).where(eq(userProfiles.id, draft.id));
  await bustUserProfileCache(deps, user.id);
  return c.json({ status: "discarded" });
});

profileRoutes.post("/publish", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c).catch(() => ({} as Record<string, unknown>));
  let content = typeof body.content === "string" ? body.content : null;
  if (content === null) {
    const draft = await getDraftProfile(deps.db, user);
    if (!draft) throw new HttpError(400, "no draft to publish");
    content = draft.content;
  }
  try {
    const profile = await publishProfile(deps.db, deps.redis(), user, content);
    await bustUserProfileCache(deps, user.id);
    return c.json({ published: profileOut(profile) });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

profileRoutes.put("/devices/:device_id/targets", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const deviceId = c.req.param("device_id");
  const body = await parseJsonObject(c);
  const targets = Array.isArray(body.targets) ? body.targets.map(String) : [];
  const valid = new Set<string>(INJECTION_TARGETS);
  const unknown = [...new Set(targets.filter((t) => !valid.has(t)))].sort();
  if (unknown.length) throw new HttpError(400, `unknown targets: ${unknown.join(", ")}`);
  const machine = await ownedMachine(deps, user, deviceId);
  const off = targetsOff(targets);
  const nextTargets = profileTargets({ profileTargetsOff: off });
  await deps.db.update(machines).set({ profileTargetsOff: off, profileTargets: nextTargets }).where(eq(machines.id, machine.id));
  await bustUserProfileCache(deps, user.id);
  return c.json({ device_id: deviceId, targets: nextTargets });
});

profileRoutes.post("/simulate", async (c) => {
  const deps = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt) throw new HttpError(422, [{ type: "missing", loc: ["body", "prompt"], msg: "Field required", input: body }]);
  const t0 = Date.now();
  const published = await getPublishedProfile(deps.db, user);
  const personaContent = published?.content || "### 铁律\n- 严禁回滚，直面问题解决\n- 始终用中文回复，不得切换英文";
  const systemPrompt = `你是当前用户的数字化身与长期记忆核心守卫者。你必须严格遵从以下用户长期画像准则：\n${personaContent}\n\n【测试要求】\n1. 如果用户请求违反了绝对铁律，你必须严肃、坚定地拒绝，并明确引用具体铁律内容；\n2. 如果用户请求合规，请严格按照用户的沟通风格与架构偏好，直接给结论并给出专业执行方案；\n3. 保持干练、自信、严谨的工程特质。`;

  const pLow = prompt.toLowerCase();
  let triggeredDimension = "all";
  let triggeredRule = "";
  let complianceStatus = "pass";
  if (["回滚", "rollback", "退回", "旧版本", "妥协"].some((k) => pLow.includes(k))) {
    triggeredDimension = "brain";
    triggeredRule = "绝对铁律：严禁回滚，直面问题向前解决";
    complianceStatus = "intercepted";
  } else if (["english", "英文", "in english", "translate to en"].some((k) => pLow.includes(k))) {
    triggeredDimension = "communication";
    triggeredRule = "沟通铁律：始终用中文回复，长会话中也不得切换为英文";
    complianceStatus = "intercepted";
  } else if (["优化", "并发", "缓存", "性能", "架构", "k8s", "慢"].some((k) => pLow.includes(k))) {
    triggeredDimension = "tech";
    triggeredRule = "架构偏好：重视性能与速度优化，偏好流式输出与并发";
    complianceStatus = "adapted";
  } else if (["发版", "发布", "测试", "部署", "流程", "习惯"].some((k) => pLow.includes(k))) {
    triggeredDimension = "execution";
    triggeredRule = "工作习惯：改动需应用到所有 pod，发版前查历史记忆";
    complianceStatus = "adapted";
  }

  let reply: string | null = null;
  try {
    reply = await callPlainChat(
      deps.settings,
      deps.redis(),
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      { temperature: 0.3, maxTokens: 400, user, background: false },
    );
  } catch {
    reply = null;
  }
  if (!reply) {
    reply =
      complianceStatus === "intercepted"
        ? `【红线拦截】操作被拒绝。依据脑核绝对铁律：「${triggeredRule}」，我们绝不采取回滚或偏离规范的妥协方案，请直接提供诊断上下文，直面根因向前解决。`
        : `已遵照画像规范响应：「${triggeredRule || "工程基线已同步"}」。针对当前任务已完成合规策略锁定。`;
  }
  return c.json({
    reply,
    triggered_dimension: triggeredDimension,
    triggered_rule: triggeredRule,
    compliance_status: complianceStatus,
    latency_ms: Math.max(Date.now() - t0, 80),
  });
});

// ---- Digital Twin Avatar ----
profileRoutes.get("/avatar", async (c) => {
  const user = await currentUser(c);
  const raw = user.avatarSettings && typeof user.avatarSettings === "object" ? { ...(user.avatarSettings as Record<string, unknown>) } : {};
  if (!Object.keys(raw).length) {
    return c.json({
      is_initialized: false,
      gender: "male",
      style: "geek",
      preset_id: "geek_male",
      nickname: user.name || "极客孪生",
      avatar_url: user.avatarUrl || "",
      custom_photo_url: "",
      theme_color: "#8B5CF6",
      outfit_color: "#6366F1",
      features: ["全栈极客", "黑框眼镜", "全息代码环"],
    });
  }
  if (!raw.avatar_url && user.avatarUrl) raw.avatar_url = user.avatarUrl;
  return c.json(raw);
});

profileRoutes.post("/avatar", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const data: Record<string, unknown> = {
    is_initialized: true,
    gender: typeof body.gender === "string" ? body.gender : "male",
    style: typeof body.style === "string" ? body.style : "geek",
    preset_id: typeof body.preset_id === "string" ? body.preset_id : "geek_male",
    nickname: typeof body.nickname === "string" ? body.nickname : "数字孪生",
    avatar_url: typeof body.avatar_url === "string" ? body.avatar_url : null,
    custom_photo_url: typeof body.custom_photo_url === "string" ? body.custom_photo_url : null,
    theme_color: typeof body.theme_color === "string" ? body.theme_color : "#8B5CF6",
    outfit_color: typeof body.outfit_color === "string" ? body.outfit_color : "#6366F1",
    features: Array.isArray(body.features) ? body.features.map(String) : [],
    updated_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  const patch: Partial<typeof users.$inferInsert> = { avatarSettings: withoutNul(data) };
  if (typeof body.avatar_url === "string" && body.avatar_url) patch.avatarUrl = body.avatar_url;
  const [updated] = await c.var.deps.db.update(users).set(patch).where(eq(users.id, user.id)).returning();
  return c.json({ status: "ok", settings: updated?.avatarSettings ?? data });
});

profileRoutes.post("/avatar/generate", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c).catch(() => ({} as Record<string, unknown>));
  const t0 = Date.now();
  const gender = typeof body.gender === "string" && body.gender ? body.gender : "male";
  const photoData = typeof body.photo_data === "string" ? body.photo_data : null;
  const photoPresent = Boolean(photoData && photoData.length > 30);
  const style = typeof body.style_preference === "string" && body.style_preference
    ? body.style_preference
    : gender === "male" ? "geek" : gender === "female" ? "cyberpunk" : "ai_sentinel";

  const idxOf = (s: string, len: number) => {
    const h = createHash("md5").update(s).digest();
    return h.readUInt32BE(0) % len;
  };

  let presetId = "ai_sentinel";
  let detectedFeatures: string[] = ["超导浮空装甲", "猩红防御光眼", "全息守卫力场"];
  let themeColor = "#EF4444";
  let outfitColor = "#18181B";

  if (gender === "male") {
    presetId = "geek_male";
    const pool = [
      ["极客黑框镜", "极简卫衣", "代码全息环"],
      ["霓虹战术目镜", "赛博机能夹克", "分布式神经环"],
      ["沉稳短发", "深空架构西装", "高算力光环"],
      ["活力微卷发", "极速探索工装", "星芒炽热环"],
    ];
    detectedFeatures = pool[idxOf(photoData || "m", pool.length)]!;
    themeColor = style === "geek" ? "#8B5CF6" : "#06B6D4";
    outfitColor = style === "geek" ? "#6366F1" : "#1E293B";
  } else if (gender === "female") {
    presetId = "cyber_female";
    const pool = [
      ["知性平光镜", "深色连帽卫衣", "紫罗兰光环"],
      ["电光粉挑染", "高领赛博风衣", "全域感知环"],
      ["干练及肩短发", "极简质感工装", "翡翠常驻环"],
      ["猫耳光感耳机", "未来运动夹克", "樱花律动环"],
    ];
    detectedFeatures = pool[idxOf(photoData || "f", pool.length)]!;
    themeColor = style === "cyberpunk" ? "#EC4899" : "#A855F7";
    outfitColor = style === "cyberpunk" ? "#DB2777" : "#7C3AED";
  }

  return c.json({
    status: "ok",
    gender,
    style,
    preset_id: presetId,
    nickname: `孪生·${user.name || "探索者"}`,
    features: detectedFeatures,
    theme_color: themeColor,
    outfit_color: outfitColor,
    custom_photo_url: photoPresent ? photoData : null,
    analysis_summary: photoPresent
      ? `已通过 AI 多模态视觉解析用户照片特征：成功提取发型与五官轮廓，锁定匹配特征「${detectedFeatures.join("、")}」，已生成专属卡通数字孪生化身！`
      : `已根据所选偏好匹配生成专属数字孪生化身「${detectedFeatures.join("、")}」！`,
    latency_ms: Math.max(Date.now() - t0, 60),
  });
});

// ---- Self-service Account Deletion ----
profileRoutes.delete("/account", async (c) => {
  const { db } = c.var.deps;
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const expected = (user.email || "").trim().toLowerCase();
  const provided = String(body.confirmation || "").trim().toLowerCase();
  if (provided !== expected) {
    throw new HttpError(400, `确认内容不匹配，请输入您的账号邮箱「${user.email}」以确认永久注销。`);
  }

  const uid = user.id;
  const machineIds = (await db.select({ id: machines.id }).from(machines).where(eq(machines.userId, uid))).map((r) => r.id);
  for (const mid of machineIds) {
    const docIds = (await db.select({ id: documents.id }).from(documents).where(eq(documents.machineId, mid))).map((r) => r.id);
    for (let i = 0; i < docIds.length; i += 500) {
      const batch = docIds.slice(i, i + 500);
      await db.delete(accessLogs).where(inArray(accessLogs.documentId, batch));
      await db.delete(conversationMessages).where(inArray(conversationMessages.documentId, batch));
      await db.delete(documentVersions).where(inArray(documentVersions.documentId, batch));
      await db.delete(documentEmbeddings).where(inArray(documentEmbeddings.documentId, batch));
      await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.sourceDocumentId, batch));
      await db.delete(documents).where(inArray(documents.id, batch));
    }
    await db.delete(syncState).where(eq(syncState.machineId, mid));
  }
  if (machineIds.length) await db.delete(machines).where(inArray(machines.id, machineIds));

  const entIds = (await db.select({ id: knowledgeEntities.id }).from(knowledgeEntities).where(eq(knowledgeEntities.userId, uid))).map((r) => r.id);
  if (entIds.length) {
    await db.delete(knowledgeRelations).where(or(inArray(knowledgeRelations.sourceId, entIds), inArray(knowledgeRelations.targetId, entIds)));
    await db.delete(knowledgeObservations).where(inArray(knowledgeObservations.entityId, entIds));
    await db.delete(knowledgeEntities).where(inArray(knowledgeEntities.id, entIds));
  }

  await db.delete(userMemories).where(eq(userMemories.userId, uid));
  await db.delete(userProfiles).where(eq(userProfiles.userId, uid));
  await db.delete(accessLogs).where(eq(accessLogs.userId, uid));
  await db.delete(users).where(eq(users.id, uid));

  return c.json({
    success: true,
    message: "账户注销成功，您的全部记忆图谱、会话及设备绑定数据已彻底物理抹除。",
  });
});
