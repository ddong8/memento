// Collaborative multi-agent plans: split a big goal into parallel sub-tasks across devices & agents
// (server/server/services/plan_service.py).
import { randomUUID } from "node:crypto";

import { and, count, eq, gt, inArray, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import { withoutNul, type Db } from "../db/client";
import { agentPlans, deviceTasks, users } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { pgToIso } from "../pytime";
import { markUsageLimit } from "./agent-limits";
import { callPlainChat } from "./ai-provider";
import { cluster } from "./cluster";
import { getCachedDeviceCapabilities, getCachedDeviceQuotas } from "./device-reports";
import { notifyUser } from "./notify";
import { listUserDevices, runOnDevice } from "./orchestrator";
import { displayDeviceName } from "./task-alerts";
import { findMachineByIdOrHash } from "./user-filter";
import { wsManager } from "./ws-manager";

export type AgentPlanRow = typeof agentPlans.$inferSelect;

const TICK_MS = 5000;
const MAX_STEPS = Number(process.env.MEMENTO_PLAN_MAX_STEPS || "8") || 8;
const MAX_ATTEMPTS = Number(process.env.MEMENTO_PLAN_MAX_ATTEMPTS || "3") || 3;
const DEFAULT_PARALLEL = Number(process.env.MEMENTO_PLAN_PARALLEL || "4") || 4;
const STEP_TIMEOUT = Number(process.env.MEMENTO_PLAN_STEP_TIMEOUT || "1800") || 1800;
const MIN_QUOTA = Number(process.env.MEMENTO_PLAN_MIN_QUOTA || "10") || 10;
const WAIT_FOR_DEVICE_MS = 30 * 60_000;
const LOST_DISPATCH_MS = 3 * 60_000;

const OPEN = ["planning", "running", "integrating"] as const;
const DONE = new Set(["succeeded", "failed", "cancelled"]);
const STEP_DONE = new Set(["succeeded", "failed", "cancelled", "skipped"]);

const AGENTS = ["claude", "codex", "antigravity"] as const;
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", antigravity: "Antigravity" };
const BINARY_MAP: Record<string, string> = { claude: "claude", codex: "codex", antigravity: "agy" };
const BY_BINARY: Record<string, string> = { claude: "claude", codex: "codex", agy: "antigravity" };
const CAPS_KEY: Record<string, string> = { claude: "claude", codex: "codex", antigravity: "antigravity" };
const QUOTA_KEY: Record<string, string> = { claude: "claude_code", codex: "codex", antigravity: "antigravity" };
const AGENT_STRENGTHS: Record<string, string> = {
  claude: "跨文件重构、排查疑难问题、架构设计、复杂逻辑、代码审查，最聪明；但 Claude 订阅的 5 小时和每周额度整个账号共用，留给最难的活",
  codex: "按明确规格实现、大量机械性改动、批量修改、补测试、跑命令，速度快、额度宽裕，优先多用",
  antigravity: "前端界面与样式、看图和截图、网页相关、文档整理，额度单独计算，优先多用",
};

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const QUOTA_MAX_AGE_SEC = Number(process.env.MEMENTO_PLAN_QUOTA_MAX_AGE || "60") || 60;
const QUOTA_WAIT_MS = 8000;
const quotaAsked = new Map<string, number>();

const activeLocal = new Map<string, AbortController>();
let runnerTimer: ReturnType<typeof setTimeout> | null = null;
let runnerActive = false;

export interface PlanStep {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  acceptance: string;
  depends_on: string[];
  agent: string;
  device_id: string;
  device_name: string;
  model: string;
  status: string;
  attempts: number;
  tried: [string, string][];
  history: Record<string, unknown>[];
  task_id: string | null;
  result: string | null;
  error: string | null;
  workspace: Record<string, unknown> | null;
  session_id?: string | null;
  started_at: string | null;
  finished_at: string | null;
  waiting_since?: string;
}

export interface SnapshotDevice {
  device_id: string;
  name: string;
  platform: string;
  workspace: boolean;
  running: number;
  quota_at: string | null;
  agents: Record<string, Record<string, unknown>>;
}

export interface CapabilitySnapshot {
  devices: SnapshotDevice[];
  stats: Record<string, { runs: number; ok: number; avg_seconds: number }>;
}

function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00");
}

function parseMs(v: unknown): number | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function tail(text: string | null | undefined, limit: number): string {
  const s = (text || "").trim();
  return s.length <= limit ? s : `…${s.slice(-limit)}`;
}

export function modelFamily(agent: string, model: string): string {
  const m = (model || "").trim().toLowerCase();
  if (agent === "claude") {
    for (const f of ["fable", "opus", "sonnet", "haiku"]) if (m.includes(f)) return f;
    return m;
  }
  if (agent === "antigravity") {
    const parts = m.split("-");
    if (parts.length > 1 && EFFORTS.has(parts[parts.length - 1]!)) return parts.slice(0, -1).join("-");
    return m;
  }
  return m;
}

function untilText(untilMs: number | null): string {
  if (!untilMs) return "额度用完";
  const mins = Math.max(1, Math.floor((untilMs - Date.now()) / 60_000));
  const span = mins < 60 ? `${mins} 分钟` : mins < 48 * 60 ? `${Math.round(mins / 60)} 小时` : `${Math.round(mins / 1440)} 天`;
  return `额度用完，约 ${span}后恢复`;
}

export function modelRoster(
  agent: string,
  rawModels: string[],
  quota: Record<string, unknown>,
  opts: { defaultModel?: string; asOfMs?: number | null } = {},
) {
  const now = Date.now();
  const def = opts.defaultModel ?? "";
  const asOfMs = opts.asOfMs ?? null;
  const models = [...new Set(rawModels)].filter((m) => m && !m.endsWith("-disabled"));
  const perModel = new Map<string, Record<string, unknown>>();
  for (const m of Array.isArray(quota.models) ? quota.models : []) {
    if (m && typeof m === "object" && (m as { model_id?: string }).model_id) {
      perModel.set(String((m as { model_id: string }).model_id), m as Record<string, unknown>);
    }
  }
  const someNumeric = [...perModel.values()].some((m) => typeof m.remaining_percent === "number");

  const readOk = (fam: string, sinceMs: number | null): boolean => {
    if (agent === "claude" || (sinceMs && (!asOfMs || asOfMs <= sinceMs))) return false;
    const pcts: unknown[] = [];
    for (const [mid, m] of perModel) {
      if (modelFamily(agent, mid) === fam) pcts.push(m.remaining_percent);
    }
    return pcts.length > 0 && pcts.every((p) => typeof p === "number" && p >= MIN_QUOTA);
  };

  const limits: Record<string, string> = {};
  for (const lim of Array.isArray(quota.limited_models) ? quota.limited_models : []) {
    if (!lim || typeof lim !== "object") continue;
    const l = lim as Record<string, unknown>;
    const until = parseMs(l.until);
    if (until && until <= now) continue;
    const fam = String(l.family || modelFamily(agent, String(l.model || "")));
    if (/model is not supported/i.test(String(l.message || ""))) {
      limits[fam] = "账号不支持";
    } else if (!readOk(fam, parseMs(l.since))) {
      limits[fam] = untilText(until);
    }
  }

  const out: Record<string, string> = {};
  const rem = typeof quota.remaining_percent === "number" ? quota.remaining_percent : null;
  const checkModels = def && !models.includes(def) ? [...models, def] : models;
  for (const m of checkModels) {
    const fam = modelFamily(agent, m);
    const pm = perModel.get(m);
    const pct = pm && typeof pm.remaining_percent === "number" ? pm.remaining_percent : null;
    if (fam in limits) {
      out[m] = limits[fam]!;
    } else if (pct !== null && pct < MIN_QUOTA) {
      out[m] = pct <= 0 ? untilText(parseMs(pm?.reset_time)) : `额度只剩 ${pct}%`;
    } else if (agent === "antigravity" && pm && pct === null && someNumeric) {
      out[m] = "额度用完";
    } else if ((agent === "claude" || agent === "codex") && rem !== null && rem < MIN_QUOTA) {
      out[m] = rem <= 0 ? "额度用完" : `账号额度只剩 ${rem}%`;
    }
  }

  const usable = models.filter((m) => !(m in out));
  let pick = "";
  if (def && !(def in out)) {
    pick = def;
  } else if (def || Object.keys(out).length) {
    const lastPart = def.includes("-") ? def.slice(def.lastIndexOf("-") + 1) : "";
    const effort = EFFORTS.has(lastPart) ? lastPart : "";
    const same = effort ? usable.filter((m) => m.endsWith(`-${effort}`)) : [];
    pick = same[0] ?? usable[0] ?? "";
  }
  const noModel = models.length > 0 && usable.length === 0;
  const accountOut = rem !== null && rem <= 0 && models.length === 0;
  return {
    models: usable.slice(0, 12),
    default_model: def,
    model: pick,
    out,
    limited: Object.keys(out),
    usable: !(noModel || accountOut || (Object.keys(out).length > 0 && def in out && !pick)),
    remaining_percent: quota.remaining_percent ?? null,
    reset_time: quota.reset_time ?? null,
  };
}

export function agentUsable(info: Record<string, unknown> | null | undefined): boolean {
  return Boolean(info) && info?.usable !== false;
}

export function stepModel(info: Record<string, unknown> | null | undefined, wanted?: string | null): string {
  const inf = info ?? {};
  const out = (inf.out && typeof inf.out === "object" ? inf.out : {}) as Record<string, unknown>;
  const models = Array.isArray(inf.models) ? (inf.models as string[]) : [];
  if (wanted && !(wanted in out) && (models.includes(wanted) || !models.length)) return wanted;
  return String(inf.model ?? "");
}

function findDevice(snapshot: CapabilitySnapshot, deviceId: string | null | undefined): SnapshotDevice | null {
  if (!deviceId) return null;
  for (const d of snapshot.devices) if (d.device_id === deviceId || d.name === deviceId) return d;
  const low = deviceId.toLowerCase();
  for (const d of snapshot.devices) if (d.name.toLowerCase().startsWith(low) || low.startsWith(d.name.toLowerCase())) return d;
  return null;
}

export function canRun(
  snapshot: CapabilitySnapshot,
  device: SnapshotDevice,
  agent: string,
  opts: { sourceDeviceId?: string | null; code?: boolean },
): boolean {
  if (!agentUsable(device.agents[agent])) return false;
  if (opts.code && opts.sourceDeviceId && device.device_id !== opts.sourceDeviceId) {
    const src = findDevice(snapshot, opts.sourceDeviceId);
    return Boolean(device.workspace && src?.workspace);
  }
  return true;
}

export function chooseAssignment(
  snapshot: CapabilitySnapshot,
  opts: {
    preferAgent?: string | null;
    preferDevice?: string | null;
    exclude?: [string, string][] | null;
    sourceDeviceId?: string | null;
    code?: boolean;
    load?: Record<string, number>;
    penalty?: Record<string, number>;
  } = {},
): [string, string] | null {
  const tried = new Set((opts.exclude ?? []).map((e) => `${e[0]}|${e[1]}`));
  const load = opts.load ?? {};
  const penalty = opts.penalty ?? {};
  let best: [number, string, string] | null = null;
  const preferDevObj = opts.preferDevice ? findDevice(snapshot, opts.preferDevice) : null;

  for (const dev of snapshot.devices) {
    for (const agent of Object.keys(dev.agents)) {
      if (tried.has(`${dev.device_id}|${agent}`)) continue;
      if (!canRun(snapshot, dev, agent, { sourceDeviceId: opts.sourceDeviceId, code: opts.code })) continue;
      let score = 0;
      if (opts.preferAgent && agent === opts.preferAgent && !penalty[agent]) score += 40;
      if (preferDevObj && preferDevObj === dev) score += 25;
      score += agent === "codex" ? 6 : agent === "antigravity" ? 4 : agent === "claude" ? 3 : 0;
      if (opts.code && opts.sourceDeviceId && dev.device_id === opts.sourceDeviceId) score += 3;
      const busy = dev.running + (load[dev.device_id] ?? 0);
      score -= 8 * busy;
      const rem = dev.agents[agent]?.remaining_percent;
      if (typeof rem === "number") score += Math.min(rem, 100) / 20;
      const st = snapshot.stats[`${dev.device_id}/${agent}`];
      if (st && st.runs >= 3) {
        score += 15 * (st.ok / st.runs - 0.5);
        if (st.avg_seconds > STEP_TIMEOUT) score -= 5;
      }
      score -= 12 * (penalty[agent] ?? 0);
      if (!best || score > best[0]) best = [score, dev.device_id, agent];
    }
  }
  return best ? [best[1], best[2]] : null;
}

export async function refreshQuotas(deps: Deps, deviceIds: string[], user: UserRow): Promise<void> {
  const nowSec = Date.now() / 1000;
  let asked: [string, unknown][] = [];
  for (const dev of deviceIds) {
    const rep = getCachedDeviceQuotas(dev, user, deps.settings) ?? {};
    const at = parseMs(rep.updated_at);
    if (at && nowSec - at / 1000 < QUOTA_MAX_AGE_SEC) continue;
    if (nowSec - (quotaAsked.get(dev) ?? 0) < QUOTA_MAX_AGE_SEC) continue;
    quotaAsked.set(dev, nowSec);
    try {
      if (await wsManager.sendJson(dev, { type: "get_agent_quotas" })) asked.push([dev, rep.updated_at]);
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + QUOTA_WAIT_MS;
  while (asked.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    asked = asked.filter(([d, u]) => (getCachedDeviceQuotas(d, user, deps.settings) ?? {}).updated_at === u);
  }
}

export async function capabilitySnapshot(deps: Deps, user: UserRow, fresh = false): Promise<CapabilitySnapshot> {
  const listing = await listUserDevices(deps, user);
  if (fresh) {
    const onlineIds = listing.filter((d) => d.device_id && d.online).map((d) => String(d.device_id));
    await refreshQuotas(deps, onlineIds, user);
  }

  const dayAgo = new Date(Date.now() - 86400_000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

  const runningRows = await deps.db
    .select({ dev: deviceTasks.deviceId, n: count() })
    .from(deviceTasks)
    .where(and(eq(deviceTasks.userId, user.id), inArray(deviceTasks.status, ["queued", "running"]), gt(deviceTasks.createdAt, dayAgo)))
    .groupBy(deviceTasks.deviceId);
  const runningMap = new Map(runningRows.map((r) => [String(r.dev), Number(r.n ?? 0)]));

  const statRows = (await deps.db.execute(sql`
    SELECT device_id,
           payload->>'binary' AS bin,
           count(*)::int AS runs,
           count(*) FILTER (WHERE status = 'succeeded')::int AS ok,
           coalesce(avg(extract(epoch FROM (finished_at - dispatched_at))), 0)::int AS avg_sec
    FROM device_tasks
    WHERE user_id = ${user.id}::uuid
      AND action = 'agent'
      AND created_at > ${monthAgo}::timestamptz
      AND status IN ('succeeded', 'failed', 'timeout')
    GROUP BY device_id, payload->>'binary'
  `)) as unknown as { device_id: string; bin: string | null; runs: number; ok: number; avg_sec: number }[];

  const stats: Record<string, { runs: number; ok: number; avg_seconds: number }> = {};
  for (const r of statRows) {
    const agent = BY_BINARY[String(r.bin || "claude")];
    if (agent) stats[`${r.device_id}/${agent}`] = { runs: Number(r.runs ?? 0), ok: Number(r.ok ?? 0), avg_seconds: Number(r.avg_sec ?? 0) };
  }

  const devices: SnapshotDevice[] = [];
  for (const d of listing) {
    const devId = typeof d.device_id === "string" ? d.device_id : "";
    if (!devId || !d.online) continue;
    const caps = getCachedDeviceCapabilities(devId, null, user, deps.settings) ?? {};
    const report = getCachedDeviceQuotas(devId, user, deps.settings) ?? {};
    const quotas = (report.tools && typeof report.tools === "object" ? report.tools : {}) as Record<string, unknown>;
    const asOfMs = parseMs(report.timestamp ?? report.updated_at);
    const env = (caps.environment && typeof caps.environment === "object" ? caps.environment : {}) as Record<string, unknown>;
    const agents: Record<string, Record<string, unknown>> = {};
    for (const agent of AGENTS) {
      const c = caps[CAPS_KEY[agent]!];
      if (!c || typeof c !== "object" || (c as Record<string, unknown>).available === false) continue;
      const qRaw = quotas[QUOTA_KEY[agent]!];
      const q = qRaw && typeof qRaw === "object" ? (qRaw as Record<string, unknown>) : {};
      if (q.logged_in === false) continue;
      const cObj = c as Record<string, unknown>;
      const rawModels = Array.isArray(cObj.models)
        ? cObj.models.filter((m): m is { id: string } => Boolean(m && typeof m === "object" && (m as { id?: string }).id)).map((m) => String(m.id))
        : [];
      agents[agent] = modelRoster(agent, rawModels, q, {
        defaultModel: String(q.default_model || cObj.default_model || ""),
        asOfMs,
      });
    }
    const feats = Array.isArray(env.features) ? env.features : [];
    const nameStr = String(d.name || "");
    devices.push({
      device_id: devId,
      name: displayDeviceName(nameStr) || nameStr || devId,
      platform: String(env.platform || ""),
      workspace: feats.includes("workspace_sync"),
      running: runningMap.get(devId) ?? 0,
      quota_at: asOfMs ? new Date(asOfMs).toISOString().replace("Z", "+00:00") : null,
      agents,
    });
  }
  return { devices, stats };
}

export function agentPenalty(steps: PlanStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) {
    for (const h of s.history ?? []) {
      if (h.error_type === "usage_limit" || !h.agent) continue;
      const a = String(h.agent);
      out[a] = (out[a] ?? 0) + (h.status === "timeout" ? 2 : 1);
    }
  }
  return out;
}

export function parsePlanJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fence = /```(?:json)?\s*(\{[\s\S]*\})\s*```/.exec(cleaned);
  if (fence) cleaned = fence[1]!;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    return data && typeof data === "object" && Array.isArray(data.steps) ? data : null;
  } catch {
    return null;
  }
}

function hasCycle(steps: PlanStep[]): boolean {
  const depsMap = new Map(steps.map((s) => [s.id, s.depends_on ?? []]));
  const state = new Map<string, number>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const d of depsMap.get(n) ?? []) if (visit(d)) return true;
    state.set(n, 2);
    return false;
  };
  for (const id of depsMap.keys()) if (visit(id)) return true;
  return false;
}

function newStep(
  sid: string,
  title: string,
  prompt: string,
  opts: { acceptance?: string; dependsOn?: string[]; agent?: string; deviceId?: string; model?: string; kind?: string } = {},
): PlanStep {
  return {
    id: sid,
    kind: opts.kind ?? "work",
    title: title.slice(0, 120) || sid,
    prompt,
    acceptance: opts.acceptance ?? "",
    depends_on: opts.dependsOn ?? [],
    agent: opts.agent ?? "",
    device_id: opts.deviceId ?? "",
    device_name: "",
    model: opts.model ?? "",
    status: "pending",
    attempts: 0,
    tried: [],
    history: [],
    task_id: null,
    result: null,
    error: null,
    workspace: null,
    started_at: null,
    finished_at: null,
  };
}

export function assignSteps(steps: PlanStep[], snapshot: CapabilitySnapshot, opts: { sourceDeviceId?: string | null; code?: boolean }): void {
  const load: Record<string, number> = {};
  for (const s of steps) {
    if (s.status !== "pending") continue;
    let dev = findDevice(snapshot, s.device_id);
    if (!(dev && s.agent && canRun(snapshot, dev, s.agent, opts))) {
      const pick = chooseAssignment(snapshot, {
        preferAgent: s.agent || (s.kind === "review" ? "claude" : null),
        preferDevice: s.device_id || null,
        exclude: s.tried,
        sourceDeviceId: opts.sourceDeviceId,
        code: opts.code,
        load,
      });
      if (!pick) {
        s.device_id = "";
        s.device_name = "";
        s.model = "";
        continue;
      }
      if (pick[1] !== s.agent) s.model = "";
      dev = findDevice(snapshot, pick[0]);
      s.device_id = pick[0];
      s.agent = pick[1];
    }
    if (dev) {
      s.device_name = dev.name;
      s.model = stepModel(dev.agents[s.agent], s.model);
      if (s.kind !== "review") load[dev.device_id] = (load[dev.device_id] ?? 0) + 1;
    }
  }
}

export function normalizeSteps(
  raw: unknown[],
  snapshot: CapabilitySnapshot,
  opts: { sourceDeviceId?: string | null; code?: boolean; review?: boolean },
): PlanStep[] {
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  const aliases: Record<string, string> = { claude_code: "claude", agy: "antigravity", gemini: "antigravity" };

  for (let i = 0; i < Math.min(raw.length, MAX_STEPS); i++) {
    const r = raw[i];
    if (!r || typeof r !== "object" || (r as Record<string, unknown>).kind === "review") continue;
    const rec = r as Record<string, unknown>;
    const prompt = String(rec.prompt ?? "").trim();
    if (!prompt) continue;
    let sid = String(rec.id ?? "").replace(/[^A-Za-z0-9_-]/g, "") || `s${i + 1}`;
    while (seen.has(sid)) sid = `${sid}x`;
    seen.add(sid);
    let agent = String(rec.agent ?? "").trim().toLowerCase();
    agent = aliases[agent] ?? agent;
    if (!(AGENTS as readonly string[]).includes(agent)) agent = "";
    const dev = findDevice(snapshot, String(rec.device ?? rec.device_id ?? "").trim());
    let deviceId = dev ? dev.device_id : "";
    if (dev && agent && !canRun(snapshot, dev, agent, opts)) deviceId = "";
    const step = newStep(sid, String(rec.title ?? "").trim(), prompt, {
      acceptance: String(rec.acceptance ?? "").trim(),
      dependsOn: Array.isArray(rec.depends_on) ? rec.depends_on.map(String) : [],
      agent,
      deviceId,
      model: String(rec.model ?? "").trim(),
    });
    const status = String(rec.status ?? "");
    if (STEP_DONE.has(status) || status === "running") {
      step.status = status;
      if (typeof rec.attempts === "number") step.attempts = rec.attempts;
      if (Array.isArray(rec.tried)) step.tried = rec.tried as [string, string][];
      if (Array.isArray(rec.history)) step.history = rec.history as Record<string, unknown>[];
      if (rec.task_id !== undefined) step.task_id = rec.task_id ? String(rec.task_id) : null;
      if (rec.result !== undefined) step.result = rec.result ? String(rec.result) : null;
      if (rec.error !== undefined) step.error = rec.error ? String(rec.error) : null;
      if (rec.workspace !== undefined) step.workspace = rec.workspace as Record<string, unknown> | null;
      if (rec.started_at !== undefined) step.started_at = rec.started_at ? String(rec.started_at) : null;
      if (rec.finished_at !== undefined) step.finished_at = rec.finished_at ? String(rec.finished_at) : null;
    }
    steps.push(step);
  }

  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    s.depends_on = [...new Set(s.depends_on)].filter((d) => ids.has(d) && d !== s.id);
  }
  if (hasCycle(steps)) {
    const order = new Map(steps.map((s, idx) => [s.id, idx]));
    for (const s of steps) s.depends_on = s.depends_on.filter((d) => (order.get(d) ?? 999) < (order.get(s.id) ?? 0));
  }
  if (opts.review !== false && steps.length >= 2) {
    steps.push(
      newStep("review", "合并检查与交叉复查", "（运行时根据各子任务结果生成）", {
        acceptance: "各子任务的改动完整、相互一致，项目的类型检查和测试通过",
        dependsOn: steps.map((s) => s.id),
        kind: "review",
      }),
    );
  }
  assignSteps(steps, snapshot, opts);
  return steps;
}

export function excludedModels(snapshot: CapabilitySnapshot) {
  const rows = new Map<string, { agent: string; model: string; reason: string; devices: string[] }>();
  for (const d of snapshot.devices) {
    for (const [a, info] of Object.entries(d.agents)) {
      const out = (info.out && typeof info.out === "object" ? info.out : {}) as Record<string, string>;
      for (const [m, why] of Object.entries(out)) {
        const fam = modelFamily(a, m);
        const key = `${a}|${fam}`;
        let row = rows.get(key);
        if (!row) {
          row = { agent: a, model: fam, reason: why, devices: [] };
          rows.set(key, row);
        }
        if (!row.devices.includes(d.name)) row.devices.push(d.name);
      }
    }
  }
  return [...rows.values()];
}

export function planRoster(steps: PlanStep[]) {
  const rows = new Map<string, { device_id: string; device_name: string; agent: string; model: string; steps: string[] }>();
  for (const s of steps) {
    if (!s.agent || !s.device_id) continue;
    const key = `${s.device_id}|${s.agent}|${s.model || ""}`;
    let row = rows.get(key);
    if (!row) {
      row = { device_id: s.device_id, device_name: s.device_name || "", agent: s.agent, model: s.model || "", steps: [] };
      rows.set(key, row);
    }
    row.steps.push(s.id);
  }
  return [...rows.values()];
}

export function planProgress(steps: PlanStep[]) {
  const statusMap = new Map(steps.map((s) => [s.id, s.status]));
  const blocked = steps
    .filter((s) => s.status === "pending" && (s.depends_on ?? []).some((d) => ["failed", "cancelled", "skipped"].includes(statusMap.get(d) ?? "")))
    .map((s) => s.id);
  const blockedSet = new Set(blocked);
  const ready = steps
    .filter((s) => s.status === "pending" && !blockedSet.has(s.id) && (s.depends_on ?? []).every((d) => statusMap.get(d) === "succeeded"))
    .map((s) => s.id);
  const over = steps.length > 0 && steps.every((s) => blockedSet.has(s.id) || STEP_DONE.has(s.status));
  return { ready, blocked, over };
}

function workspaceNote(ws: Record<string, unknown> | null | undefined): string {
  if (!ws) return "";
  const st = String(ws.status ?? "");
  let extra = "";
  if (ws.commits) {
    extra += `，${ws.commits} 个提交${ws.committed === "branch" ? "已接到源目录的分支上" : `放在分支 ${ws.commit_branch || "?"}`}`;
  }
  const push = (ws.push && typeof ws.push === "object" ? ws.push : {}) as Record<string, unknown>;
  if (push.status === "pushed") extra += `，已推送到 ${push.remote || "远端"}/${push.branch || ""}`;
  else if (push.status) extra += `，没有推送：${push.detail || push.status}`;
  if (st === "applied") return `已合回源目录（${ws.files || 0} 个文件）${extra}`;
  if (st === "conflict") return `和源目录有冲突，改动放在分支 ${ws.branch || "?"}${extra}`;
  if (st === "saved") return `改动另存在 ${ws.branch || ws.patch_path || "源设备"}`;
  if (st === "pending") return "源设备离线，改动等它上线后自动送回";
  if (st === "unchanged") return "没有改动文件";
  return `改动没能送回：${ws.error || st}`;
}

function workspaceOutcome(events: unknown): Record<string, unknown> | null {
  if (!Array.isArray(events)) return null;
  let out: Record<string, unknown> | null = null;
  for (const e of events) {
    if (!e || typeof e !== "object") continue;
    const rec = e as Record<string, unknown>;
    if (rec.kind === "workspace" && rec.status !== "syncing" && rec.status !== "synced") {
      out = {
        status: rec.status,
        branch: rec.branch,
        patch_path: rec.patch_path,
        files: Array.isArray(rec.files) ? rec.files.length : 0,
        error: rec.error,
      };
      if (Array.isArray(rec.commits) && rec.commits.length) {
        out.commits = rec.commits.length;
        out.committed = rec.committed;
        out.commit_branch = rec.commit_branch;
      }
      if (rec.push && typeof rec.push === "object") out.push = rec.push;
    }
  }
  return out;
}

export function buildStepPrompt(plan: Pick<AgentPlanRow, "goal">, step: PlanStep, steps: PlanStep[]): string {
  const deps = steps.filter((s) => (step.depends_on ?? []).includes(s.id));
  const others = steps.filter((s) => s.id !== step.id && s.kind !== "review");
  if (step.kind === "review") {
    const done = deps
      .map(
        (s) =>
          `### ${s.title}（${AGENT_NAMES[s.agent] ?? s.agent}，${s.device_name || ""}）\n` +
          `验收标准：${s.acceptance || "无"}\n结果：${tail(s.result || s.error || "无输出", 2500)}` +
          (s.workspace ? `\n改动合并情况：${workspaceNote(s.workspace)}` : ""),
      )
      .join("\n\n");
    return `你是这个协作任务最后的复查人。总目标：\n${plan.goal}\n\n几个智能体已经分头做完了各自的部分（结果在下面），改动都已在当前目录里（合不进来的在提示的分支上）。请：\n1) 通读这些改动，检查是否完整做到总目标、彼此是否一致（接口、命名、调用关系）。\n2) 运行项目里已有的类型检查、lint 和测试，发现问题直接修好。\n3) 不要 git commit / push。\n4) 最后用中文简洁汇报：整体是否完成、你修了什么、测试结果、还剩什么问题。\n\n各子任务结果：\n${done}`;
  }
  const parts = [`这是一个协作任务中的一个子任务。总目标（供理解背景）：\n${plan.goal}\n`, `你负责的子任务：${step.title}\n${step.prompt}`];
  if (step.acceptance) parts.push(`验收标准：${step.acceptance}`);
  if (others.length) parts.push(`其他智能体同时在做这些部分，不要动它们负责的内容：\n${others.map((s) => `- ${s.title}`).join("\n")}`);
  if (deps.length) {
    parts.push(`你依赖的前置子任务已完成，结果如下：\n${deps.map((s) => `### ${s.title}\n${tail(s.result || "", 2000)}`).join("\n\n")}`);
  }
  if (step.history?.length) {
    const last = step.history[step.history.length - 1]!;
    const a = String(last.agent ?? "");
    parts.push(`上一次尝试（${AGENT_NAMES[a] ?? a}）没有成功：${tail(String(last.error ?? ""), 800)}\n这次请换个思路完成。`);
  }
  parts.push("要求：只做你负责的部分；不要 git commit / push；做完按验收标准自检。最后用中文简洁说明做了什么、改了哪些文件、验收结果。");
  return parts.join("\n\n");
}

async function mutatePlan(
  db: Db,
  planId: string,
  fn: (plan: AgentPlanRow, steps: PlanStep[]) => Partial<typeof agentPlans.$inferInsert> | false | null | undefined,
): Promise<AgentPlanRow | null> {
  return db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`SELECT id FROM agent_plans WHERE id = ${planId}::uuid FOR UPDATE`)) as unknown as { id: string }[];
    if (!rows.length) return null;
    const tdb = tx as unknown as Db;
    const [plan] = await tdb.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
    if (!plan) return null;
    const steps: PlanStep[] = structuredClone(Array.isArray(plan.steps) ? (plan.steps as PlanStep[]) : []);
    const patch = fn(plan, steps);
    if (patch === false) return plan;
    const [updated] = await tdb
      .update(agentPlans)
      .set(withoutNul({ ...(patch ?? {}), steps, updatedAt: nowIso() }))
      .where(eq(agentPlans.id, planId))
      .returning();
    return updated ?? plan;
  });
}

function snapshotText(snapshot: CapabilitySnapshot): string {
  const lines = snapshot.devices.map((d) => {
    const agents = Object.entries(d.agents).map(([a, info]) => {
      const bits = [AGENT_NAMES[a] ?? a];
      if (!agentUsable(info)) {
        bits.push("暂不可用（没有额度够用的模型）");
      } else {
        if (info.model) bits.push(`默认用 ${info.model}`);
        if (Array.isArray(info.models) && info.models.length) bits.push(`可用模型 ${(info.models as string[]).slice(0, 8).join("、")}`);
      }
      const out = (info.out && typeof info.out === "object" ? info.out : {}) as Record<string, string>;
      const outEntries = Object.entries(out).slice(0, 6);
      if (outEntries.length) bits.push(`不能用的模型 ${outEntries.map(([m, w]) => `${m}（${w}）`).join("、")}`);
      if (typeof info.remaining_percent === "number") bits.push(`额度剩 ${info.remaining_percent}%`);
      const st = snapshot.stats[`${d.device_id}/${a}`];
      if (st?.runs) bits.push(`近 30 天 ${st.runs} 次成功 ${st.ok} 次、平均 ${Math.floor(st.avg_seconds / 60)} 分钟`);
      return `${a}（${bits.join("；")}）`;
    });
    return `- 设备「${d.name}」 平台 ${d.platform || "未知"}，正在跑 ${d.running} 个任务；智能体：${agents.join("，") || "无"}`;
  });
  return lines.join("\n") || "（没有在线设备）";
}

export async function makePlan(deps: Deps, planId: string): Promise<void> {
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  if (!plan || plan.status !== "planning") return;
  const [user] = await deps.db.select().from(users).where(eq(users.id, plan.userId)).limit(1);
  if (!user) return;

  const snapshot = await capabilitySnapshot(deps, user, true);
  let sourceName: string | null = null;
  if (plan.sourceDeviceId) {
    const src = await findMachineByIdOrHash(deps.db, deps.settings, plan.sourceDeviceId, user);
    sourceName = src ? displayDeviceName(src.name) : null;
  }
  const opts = (plan.options && typeof plan.options === "object" ? plan.options : {}) as Record<string, unknown>;
  const review = opts.review !== false;

  const strengths = Object.entries(AGENT_STRENGTHS).map(([a, s]) => `- ${a}（${AGENT_NAMES[a]}）：${s}`).join("\n");
  const where = plan.cwd ? `代码目录：${plan.cwd}（在设备「${sourceName || "未知"}」上；派到别的设备的子任务会在它的副本上改，改完自动合回）` : "没有指定代码目录";
  const system = `你是任务规划器。把用户的大任务拆成可以交给不同 AI 编码智能体并行完成的子任务，输出严格的 JSON，不要输出别的文字。
规则：
1) 子任务之间尽量互不依赖、改的文件不重叠，能并行的就并行；确实有先后的用 depends_on 写明。
2) 每个子任务写清楚 prompt 和 acceptance。
3) 按智能体特点分配 agent，按设备情况分配 device（填设备名）：\n${strengths}
4) 任务本身不大时只输出 1 个子任务；最多 ${MAX_STEPS} 个；不要单独安排汇总/复查。
输出格式：{"title":"短标题","note":"原因","steps":[{"id":"s1","title":"短标题","prompt":"...","acceptance":"...","depends_on":[],"agent":"codex","device":"设备名","model":""}]}`;

  let title = "";
  let note = "";
  let steps: PlanStep[] = [];
  try {
    const text = await callPlainChat(
      deps.settings,
      deps.redis(),
      [
        { role: "system", content: system },
        { role: "user", content: `大任务：\n${plan.goal}\n\n${where}\n\n现在在线的设备和智能体：\n${snapshotText(snapshot)}` },
      ],
      { temperature: 0.2, maxTokens: 4000, timeoutSec: 240, user, background: false },
    );
    const data = parsePlanJson(text);
    if (data && Array.isArray(data.steps)) {
      title = String(data.title ?? "").trim();
      note = String(data.note ?? "").trim();
      steps = normalizeSteps(data.steps, snapshot, { sourceDeviceId: plan.sourceDeviceId, code: Boolean(plan.cwd), review });
    }
  } catch {
    /* fallback */
  }
  if (!steps.length) {
    note = note || "没能拆分，整个任务交给一个智能体完成";
    steps = normalizeSteps([{ id: "s1", title: plan.goal.slice(0, 60), prompt: plan.goal, acceptance: "任务要求全部做到" }], snapshot, {
      sourceDeviceId: plan.sourceDeviceId,
      code: Boolean(plan.cwd),
      review: false,
    });
  }

  await mutatePlan(deps.db, planId, (p, st) => {
    if (p.status !== "planning") return false;
    st.splice(0, st.length, ...steps);
    const nextOpts = { ...((p.options && typeof p.options === "object" ? p.options : {}) as Record<string, unknown>), excluded_models: excludedModels(snapshot), planned_at: nowIso() };
    return {
      title: p.title || title || p.goal.slice(0, 60),
      planNote: note,
      options: nextOpts,
      status: p.autoStart ? "running" : "ready",
      ...(p.autoStart ? { startedAt: nowIso() } : {}),
    };
  });
}

async function finishStep(db: Db, planId: string, sid: string, attempt: number, res: Record<string, unknown> | null): Promise<void> {
  const r = res ?? {};
  const status = String(r.status || (r.error ? "failed" : ""));
  const ok = (status === "succeeded" || status === "still_running") && (r.exit_code === null || r.exit_code === undefined || r.exit_code === 0);
  const kept = {
    status: status || "failed",
    result: tail(String(r.stdout ?? ""), 6000) || null,
    error: ok ? null : tail(String(r.error || r.stderr || r.note || "没有结果"), status === "timeout" ? 300 : 2000),
    error_type: r.error_type ?? null,
    workspace: workspaceOutcome(r.events),
    session_id: typeof r.session_id === "string" ? r.session_id : null,
  };

  await mutatePlan(db, planId, (_p, steps) => {
    const s = steps.find((x) => x.id === sid);
    if (!s || s.status !== "running" || s.attempts !== attempt) return false;
    s.finished_at = nowIso();
    s.result = kept.result;
    s.workspace = kept.workspace;
    s.session_id = kept.session_id;
    if (ok) {
      s.status = "succeeded";
      s.error = null;
      return {};
    }
    if (kept.status === "cancelled") {
      s.status = "cancelled";
      s.error = "已停止";
      return {};
    }
    s.error = kept.error;
    s.history = [
      ...(s.history ?? []),
      {
        attempt,
        device_id: s.device_id,
        device_name: s.device_name,
        agent: s.agent,
        model: s.model || "",
        task_id: s.task_id,
        error: kept.error,
        error_type: kept.error_type,
        status: kept.status,
        at: s.finished_at,
      },
    ];
    s.tried = [...(s.tried ?? []), [s.device_id, s.agent]];
    if (attempt < MAX_ATTEMPTS) {
      s.status = "pending";
      s.task_id = null;
      s.device_id = "";
      s.agent = "";
      s.model = "";
    } else {
      s.status = "failed";
    }
    return {};
  });
}

async function runStep(deps: Deps, planId: string, sid: string, attempt: number, signal: AbortSignal): Promise<void> {
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  const [user] = plan ? await deps.db.select().from(users).where(eq(users.id, plan.userId)).limit(1) : [];
  const steps = Array.isArray(plan?.steps) ? (plan.steps as PlanStep[]) : [];
  const step = steps.find((x) => x.id === sid);
  if (!plan || !user || !step || step.status !== "running" || step.attempts !== attempt) return;

  const opts = (plan.options && typeof plan.options === "object" ? plan.options : {}) as Record<string, unknown>;
  let result: Record<string, unknown> | null = null;
  try {
    result = await runOnDevice(deps, user, {
      device: step.device_id,
      action: "agent",
      binary: BINARY_MAP[step.agent || "claude"] ?? "claude",
      prompt: buildStepPrompt(plan, step, steps),
      cwd: plan.cwd,
      model: step.model || null,
      timeoutSeconds: Number(opts.step_timeout || STEP_TIMEOUT),
      signal,
      onEvent: (ev) => {
        if (ev.type === "task_started" && typeof ev.task_id === "string") {
          const tid = ev.task_id;
          const name = typeof ev.device === "string" ? ev.device : "";
          void mutatePlan(deps.db, planId, (_p, st) => {
            const x = st.find((i) => i.id === sid);
            if (!x || x.status !== "running" || x.attempts !== attempt) return false;
            x.task_id = tid;
            if (name) x.device_name = displayDeviceName(name) || name;
            return {};
          });
        }
      },
    });
  } catch (e) {
    if (signal.aborted) return;
    result = { status: "failed", error: `派发出错：${(e as Error).message}` };
  }
  await finishStep(deps.db, planId, sid, attempt, result);
}

async function watchTask(deps: Deps, planId: string, sid: string, attempt: number, taskId: string, signal: AbortSignal): Promise<void> {
  const tid = normalizeUuid(taskId);
  if (!tid) {
    await finishStep(deps.db, planId, sid, attempt, { status: "failed", error: "任务号无效" });
    return;
  }
  while (!signal.aborted) {
    const [t] = await deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
    if (!t) {
      await finishStep(deps.db, planId, sid, attempt, { status: "failed", error: "设备任务不见了" });
      return;
    }
    if (["succeeded", "failed", "timeout", "cancelled", "still_running"].includes(t.status)) {
      await finishStep(
        deps.db,
        planId,
        sid,
        attempt,
        markUsageLimit({ action: "agent", status: t.status, exit_code: t.exitCode, stdout: t.stdout, stderr: t.stderr, error: t.error, events: t.events ?? [], session_id: t.sessionId }),
      );
      return;
    }
    const createdMs = parseMs(t.createdAt) ?? Date.now();
    if (t.status === "queued" && !t.dispatchedAt && Date.now() - createdMs > LOST_DISPATCH_MS) {
      await finishStep(deps.db, planId, sid, attempt, { status: "failed", error: "任务没有送到设备" });
      return;
    }
    const limitMs = ((t.timeoutSeconds || 0) + 900) * 1000;
    if (t.timeoutSeconds && Date.now() - createdMs > limitMs) {
      await finishStep(deps.db, planId, sid, attempt, { status: "timeout", error: "设备超过时限没有回报结果" });
      return;
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

function spawnLocal(key: string, fn: (signal: AbortSignal) => Promise<void>): void {
  if (activeLocal.has(key)) return;
  const ac = new AbortController();
  activeLocal.set(key, ac);
  void fn(ac.signal).finally(() => {
    if (activeLocal.get(key) === ac) activeLocal.delete(key);
  });
}

async function finalizePlan(deps: Deps, planId: string): Promise<void> {
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  if (!plan || plan.status !== "integrating") return;
  const [user] = await deps.db.select().from(users).where(eq(users.id, plan.userId)).limit(1);
  const steps = Array.isArray(plan.steps) ? (plan.steps as PlanStep[]) : [];
  const allOk = steps.every((s) => s.status === "succeeded");
  const body = steps
    .map(
      (s) =>
        `### ${s.title}（${s.status}，${AGENT_NAMES[s.agent] ?? s.agent}，${s.device_name || ""}）\n${tail(s.result || s.error || "", 2500)}` +
        (s.workspace ? `\n改动：${workspaceNote(s.workspace)}` : ""),
    )
    .join("\n\n");
  let summary: string | null = null;
  try {
    summary = await callPlainChat(
      deps.settings,
      deps.redis(),
      [
        { role: "system", content: "你在给用户汇报一个多智能体协作任务的最终结果。用中文，直接给结论：整体完成了没有、每部分做了什么、改动合到了哪里、测试结果、还剩什么没做或要用户处理的。简洁，不要客套，不用加粗符号，编号用 1) 2)。" },
        { role: "user", content: `总目标：\n${plan.goal}\n\n各子任务结果：\n${body}` },
      ],
      { temperature: 0.2, maxTokens: 1500, timeoutSec: 180, user: user ?? null },
    );
  } catch {
    /* fallback */
  }
  if (!summary) {
    summary = steps.map((s, i) => `${i + 1}) ${s.title}：${s.status === "succeeded" ? "完成" : s.error || s.status}`).join("\n");
  }
  const done = await mutatePlan(deps.db, planId, (p, st) => {
    if (p.status !== "integrating") return false;
    const bad = st.filter((s) => s.status !== "succeeded").map((s) => s.title);
    return {
      status: allOk ? "succeeded" : "failed",
      summary,
      finishedAt: nowIso(),
      ...(allOk ? {} : { error: `没完成的子任务：${bad.join("、")}` }),
    };
  });
  if (done) {
    await notifyUser(
      deps,
      plan.userId,
      "task_done",
      `协作任务${allOk ? "完成" : "结束（有子任务没完成）"}：${plan.title || plan.goal.slice(0, 40)}`,
      tail(summary, 300),
      { url: `/plans/${planId}` },
    ).catch(() => {});
  }
}

async function advancePlan(deps: Deps, planId: string): Promise<void> {
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  if (!plan || plan.status !== "running") return;
  const [user] = await deps.db.select().from(users).where(eq(users.id, plan.userId)).limit(1);
  if (!user) return;
  const steps = structuredClone(Array.isArray(plan.steps) ? (plan.steps as PlanStep[]) : []);
  const nowMs = Date.now();

  for (const s of steps) {
    const key = `${planId}/${s.id}`;
    if (s.status !== "running" || activeLocal.has(key)) continue;
    if (s.task_id) {
      spawnLocal(key, (sig) => watchTask(deps, planId, s.id, s.attempts, s.task_id!, sig));
    } else {
      const startedMs = parseMs(s.started_at);
      if (startedMs && nowMs - startedMs > LOST_DISPATCH_MS) {
        await mutatePlan(deps.db, planId, (_p, st) => {
          const x = st.find((i) => i.id === s.id);
          if (!x || x.status !== "running" || x.attempts !== s.attempts || x.task_id) return false;
          x.status = "pending";
          x.attempts = Math.max(0, s.attempts - 1);
          return {};
        });
      }
    }
  }

  const prog = planProgress(steps);
  if (prog.blocked.length) {
    await mutatePlan(deps.db, planId, (_p, st) => {
      for (const x of st) {
        if (prog.blocked.includes(x.id) && x.status === "pending") {
          x.status = "skipped";
          x.error = "前置子任务没有完成";
        }
      }
      return {};
    });
    return;
  }
  if (prog.over) {
    const closing = await mutatePlan(deps.db, planId, (p) => (p.status === "running" ? { status: "integrating" } : false));
    if (closing?.status === "integrating") spawnLocal(planId, () => finalizePlan(deps, planId));
    return;
  }
  if (!prog.ready.length) return;

  const opts = (plan.options && typeof plan.options === "object" ? plan.options : {}) as Record<string, unknown>;
  const parallel = Number(opts.max_parallel || DEFAULT_PARALLEL);
  const curRunning = steps.filter((s) => s.status === "running").length;
  if (curRunning >= parallel) return;

  const snapshot = await capabilitySnapshot(deps, user, true);
  let directBusy = steps.some((s) => s.status === "running" && plan.cwd && s.device_id === plan.sourceDeviceId);
  const load: Record<string, number> = {};
  const penalty = agentPenalty(steps);
  const starts: [string, string, string, string, string][] = [];
  const waiting: string[] = [];

  for (const sid of prog.ready) {
    if (curRunning + starts.length >= parallel) break;
    const s = steps.find((x) => x.id === sid)!;
    let pick: [string, string] | null = null;
    const dev = findDevice(snapshot, s.device_id);
    const triedHas = (s.tried ?? []).some((e) => e[0] === dev?.device_id && e[1] === s.agent);
    if (dev && s.agent && !triedHas && !penalty[s.agent] && canRun(snapshot, dev, s.agent, { sourceDeviceId: plan.sourceDeviceId, code: Boolean(plan.cwd) })) {
      pick = [dev.device_id, s.agent];
    }
    if (!pick) {
      pick = chooseAssignment(snapshot, {
        preferAgent: s.agent || (s.kind === "review" ? "claude" : null),
        exclude: s.tried,
        sourceDeviceId: plan.sourceDeviceId,
        code: Boolean(plan.cwd),
        load,
        penalty,
      });
    }
    if (!pick) {
      waiting.push(sid);
      continue;
    }
    if (plan.cwd && pick[0] === plan.sourceDeviceId) {
      if (directBusy) continue;
      directBusy = true;
    }
    load[pick[0]] = (load[pick[0]] ?? 0) + 1;
    const picked = findDevice(snapshot, pick[0]);
    const same = pick[0] === s.device_id && pick[1] === s.agent;
    const model = stepModel(picked?.agents[pick[1]], same ? s.model : null);
    starts.push([sid, pick[0], pick[1], picked?.name ?? "", model]);
  }

  if (waiting.length) {
    await mutatePlan(deps.db, planId, (_p, st) => {
      let changed = false;
      for (const x of st) {
        if (!waiting.includes(x.id) || x.status !== "pending") continue;
        const since = parseMs(x.waiting_since);
        if (!since) {
          x.waiting_since = nowIso();
          x.error = "暂时没有可用的设备和智能体，等它们上线或额度恢复";
          changed = true;
        } else if (Date.now() - since > WAIT_FOR_DEVICE_MS) {
          x.status = "failed";
          x.error = "等了 30 分钟仍没有可用的设备和智能体（离线或额度用完）";
          changed = true;
        }
      }
      return changed ? {} : false;
    });
  }

  for (const [sid, deviceId, agent, name, model] of starts) {
    const p = await mutatePlan(deps.db, planId, (pl, st) => {
      const x = st.find((i) => i.id === sid);
      if (pl.status !== "running" || !x || x.status !== "pending") return false;
      x.status = "running";
      x.device_id = deviceId;
      x.agent = agent;
      x.device_name = name;
      x.model = model;
      x.task_id = null;
      x.attempts = (x.attempts ?? 0) + 1;
      x.started_at = nowIso();
      x.finished_at = null;
      x.error = null;
      delete x.waiting_since;
      return {};
    });
    const x = p && Array.isArray(p.steps) ? (p.steps as PlanStep[]).find((i) => i.id === sid) : null;
    if (x && x.status === "running" && x.device_id === deviceId && !x.task_id) {
      spawnLocal(`${planId}/${sid}`, (sig) => runStep(deps, planId, sid, x.attempts, sig));
    }
  }
}

export async function tickPlans(deps: Deps): Promise<void> {
  const rows = await deps.db
    .select({ id: agentPlans.id, status: agentPlans.status })
    .from(agentPlans)
    .where(inArray(agentPlans.status, [...OPEN]));
  for (const r of rows) {
    try {
      if (r.status === "planning") {
        spawnLocal(r.id, () => makePlan(deps, r.id));
      } else if (r.status === "integrating") {
        spawnLocal(r.id, () => finalizePlan(deps, r.id));
      } else {
        await advancePlan(deps, r.id);
      }
    } catch {
      /* isolate plan error */
    }
  }
}

export function startPlanRunner(deps: Deps): void {
  if (runnerActive || !deps.settings.enableScheduler) return;
  runnerActive = true;
  const loop = () => {
    if (!runnerActive) return;
    runnerTimer = setTimeout(async () => {
      try {
        if (await cluster.holdLease("plans", 60)) {
          await tickPlans(deps);
        }
      } catch {
        /* ignore */
      } finally {
        loop();
      }
    }, TICK_MS);
    runnerTimer.unref?.();
  };
  loop();
}

export async function stopPlanRunner(): Promise<void> {
  runnerActive = false;
  if (runnerTimer) {
    clearTimeout(runnerTimer);
    runnerTimer = null;
  }
  for (const ac of activeLocal.values()) ac.abort();
  activeLocal.clear();
}

// ---- User actions ----
export async function createPlan(
  deps: Deps,
  user: UserRow,
  goal: string,
  opts: { cwd?: string | null; sourceDeviceId?: string | null; projectId?: string | null; autoStart?: boolean; title?: string; options?: Record<string, unknown> } = {},
): Promise<AgentPlanRow> {
  let source: string | null = null;
  if (opts.sourceDeviceId) {
    const m = await findMachineByIdOrHash(deps.db, deps.settings, opts.sourceDeviceId, user);
    source = m ? m.collectorTokenHash : null;
  }
  const now = nowIso();
  const [plan] = await deps.db
    .insert(agentPlans)
    .values(
      withoutNul({
        id: randomUUID(),
        userId: user.id,
        goal: goal.trim(),
        title: (opts.title || "").trim().slice(0, 255),
        cwd: (opts.cwd || "").trim() || null,
        sourceDeviceId: source,
        projectId: opts.projectId ?? null,
        autoStart: opts.autoStart ?? true,
        options: opts.options ?? {},
        status: "planning",
        steps: [],
        createdAt: now,
        updatedAt: now,
      }),
    )
    .returning();
  return plan!;
}

async function cancelDeviceTask(db: Db, taskId: string | null | undefined): Promise<void> {
  const tid = normalizeUuid(taskId);
  if (!tid) return;
  const [t] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!t || ["succeeded", "failed", "timeout", "cancelled"].includes(t.status)) return;
  await wsManager.sendCancel(t.deviceId, tid);
  await db
    .update(deviceTasks)
    .set({ status: "cancelled", finishedAt: nowIso() })
    .where(and(eq(deviceTasks.id, tid), inArray(deviceTasks.status, ["queued", "running", "still_running"])));
}

export async function cancelPlan(db: Db, planId: string): Promise<AgentPlanRow | null> {
  const stop: (string | null)[] = [];
  const plan = await mutatePlan(db, planId, (p, st) => {
    if (DONE.has(p.status)) return false;
    for (const x of st) {
      if (x.status === "running") stop.push(x.task_id);
      if (x.status === "pending" || x.status === "running") {
        x.status = "cancelled";
        x.error = "已停止";
        x.finished_at = nowIso();
      }
    }
    return { status: "cancelled", finishedAt: nowIso() };
  });
  for (const tid of stop) await cancelDeviceTask(db, tid);
  return plan;
}

export async function cancelStep(db: Db, planId: string, sid: string): Promise<AgentPlanRow | null> {
  const stop: (string | null)[] = [];
  const plan = await mutatePlan(db, planId, (_p, st) => {
    const x = st.find((i) => i.id === sid);
    if (!x || (x.status !== "pending" && x.status !== "running")) return false;
    if (x.status === "running") stop.push(x.task_id);
    x.status = "cancelled";
    x.error = "已停止";
    x.finished_at = nowIso();
    return {};
  });
  for (const tid of stop) await cancelDeviceTask(db, tid);
  return plan;
}

export async function retryStep(db: Db, planId: string, sid: string): Promise<AgentPlanRow | null> {
  return mutatePlan(db, planId, (p, st) => {
    const x = st.find((i) => i.id === sid);
    if (!x || !["failed", "cancelled", "skipped"].includes(x.status)) return false;
    const again = new Set<string>([sid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const y of st) {
        if (!again.has(y.id) && y.status === "skipped" && (y.depends_on ?? []).some((d) => again.has(d))) {
          again.add(y.id);
          changed = true;
        }
      }
    }
    if (x.kind !== "review") {
      const rev = st.find((i) => i.id === "review");
      if (rev && ["succeeded", "skipped", "failed", "cancelled"].includes(rev.status)) again.add("review");
    }
    for (const y of st) {
      if (again.has(y.id)) {
        y.status = "pending";
        y.attempts = 0;
        y.tried = [];
        y.task_id = null;
        y.error = null;
        y.finished_at = null;
        delete y.waiting_since;
      }
    }
    if (DONE.has(p.status) || p.status === "integrating") {
      return { status: "running", finishedAt: null, error: null };
    }
    return {};
  });
}

export async function startPlan(db: Db, planId: string): Promise<AgentPlanRow | null> {
  return mutatePlan(db, planId, (p) => (p.status === "ready" ? { status: "running", startedAt: nowIso() } : false));
}

export async function replan(db: Db, planId: string): Promise<AgentPlanRow | null> {
  return mutatePlan(db, planId, (p, st) => {
    if (!["ready", "failed", "cancelled"].includes(p.status)) return false;
    st.splice(0, st.length);
    return { status: "planning", planNote: null, summary: null, error: null, finishedAt: null };
  });
}

export async function editSteps(deps: Deps, user: UserRow, planId: string, raw: unknown[]): Promise<AgentPlanRow | null> {
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, planId)).limit(1);
  if (!plan) return null;
  const snapshot = await capabilitySnapshot(deps, user);
  const opts = (plan.options && typeof plan.options === "object" ? plan.options : {}) as Record<string, unknown>;
  const steps = normalizeSteps(raw, snapshot, {
    sourceDeviceId: plan.sourceDeviceId,
    code: Boolean(plan.cwd),
    review: opts.review !== false,
  });
  return mutatePlan(deps.db, planId, (p, st) => {
    if (p.status !== "ready") return false;
    st.splice(0, st.length, ...steps);
    return {};
  });
}

export function planOut(plan: AgentPlanRow, full = true) {
  const steps = Array.isArray(plan.steps) ? (plan.steps as PlanStep[]) : [];
  const counts: Record<string, number> = {};
  for (const s of steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  const out: Record<string, unknown> = {
    id: plan.id,
    title: plan.title || plan.goal.slice(0, 60),
    goal: plan.goal,
    status: plan.status,
    auto_start: plan.autoStart,
    cwd: plan.cwd,
    source_device_id: plan.sourceDeviceId,
    project_id: plan.projectId,
    options: plan.options ?? {},
    plan_note: plan.planNote,
    summary: plan.summary,
    error: plan.error,
    step_counts: counts,
    step_total: steps.length,
    created_at: pgToIso(plan.createdAt),
    updated_at: pgToIso(plan.updatedAt),
    started_at: pgToIso(plan.startedAt),
    finished_at: pgToIso(plan.finishedAt),
    roster: planRoster(steps),
  };
  if (full) out.steps = steps;
  return out;
}
