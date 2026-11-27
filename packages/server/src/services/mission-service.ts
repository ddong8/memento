// Autonomous Background Missions (server/server/services/mission_service.py).
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import { withoutNul, type Db } from "../db/client";
import { agentMissions, deviceTasks, machines, users } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { callPlainChat } from "./ai-provider";
import { claudeEntrypoint } from "./claude-session";
import { cluster } from "./cluster";
import { deliverTask, wsAlias } from "./device-dispatch";
import type { MachineRow } from "./device-merge";
import { notifyUser } from "./notify";
import { classifyShellCommand } from "./risk-policy";
import { normalizeDeviceName } from "./user-filter";

export type AgentMissionRow = typeof agentMissions.$inferSelect;

const MAX_WAIT_SECONDS = 3600;
const OFFLINE_RETRY_SECONDS = 300;
const MAX_DECISION_FAILURES = 5;
const MAX_STEPS = 60;
const SHELL_TIMEOUT_SECONDS = 600;
const AGENT_TIMEOUT_SECONDS = 7200;
const AGENT_OUTPUT_PREVIEW = 3000;
const SHELL_OUTPUT_PREVIEW = 500;
const ACTIONS = new Set(["finish", "wait", "exec_shell", "run_agent"]);
const OPEN_TASK_STATUSES = new Set(["queued", "running", "still_running"]);

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function missionsUrl(deps: Deps): string {
  const path = "/profile?tab=proactive";
  const pub = deps.settings.publicUrl.replace(/\/+$/, "");
  return pub ? `${pub}${path}` : path;
}

function parseDecision(reply: string): Record<string, unknown> {
  const text = reply.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the reply");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
  return parsed as Record<string, unknown>;
}

function waitUntilMs(ctx: Record<string, unknown>): number | null {
  const raw = ctx.wait_until;
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isNaN(ms) ? null : ms;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

function asSteps(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? ([...v] as Record<string, unknown>[]) : [];
}

export async function createMission(
  db: Db,
  user: UserRow,
  title: string,
  goal: string,
  context: Record<string, unknown> = {},
  riskLevel = "low",
): Promise<AgentMissionRow> {
  const nowIso = new Date().toISOString();
  const [mission] = await db
    .insert(agentMissions)
    .values(
      withoutNul({
        id: randomUUID(),
        userId: user.id,
        title: title.trim().slice(0, 250),
        goal: goal.trim(),
        status: "running",
        riskLevel,
        currentStep: 0,
        steps: [{ step: 0, type: "init", message: `任务已创建并启动: ${title}`, created_at: nowIso }],
        context,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastHeartbeat: nowIso,
      }),
    )
    .returning();
  return mission!;
}

async function userMachines(db: Db, userId: string): Promise<MachineRow[]> {
  try {
    return await db
      .select()
      .from(machines)
      .where(and(eq(machines.userId, userId), isNull(machines.mergedInto), ne(machines.isArchived, true)))
      .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`));
  } catch {
    return [];
  }
}

async function pickMachine(
  db: Db,
  userId: string,
  deviceHint: string | null | undefined,
  existing?: MachineRow[],
): Promise<[MachineRow[], MachineRow | null]> {
  const list = existing?.length ? existing : await userMachines(db, userId);
  const online = list.filter((m) => Boolean(wsAlias(m.collectorTokenHash, m)));
  if (deviceHint) {
    const hint = deviceHint.toLowerCase();
    const named = online.find((m) =>
      [m.name.toLowerCase(), normalizeDeviceName(m.name).toLowerCase(), m.collectorTokenHash.toLowerCase(), m.id].includes(hint),
    );
    if (named) return [list, named];
  }
  return [list, online[0] ?? null];
}

async function saveMission(db: Db, mission: AgentMissionRow, patch: Partial<typeof agentMissions.$inferInsert>): Promise<AgentMissionRow> {
  const [updated] = await db
    .update(agentMissions)
    .set(withoutNul(patch))
    .where(eq(agentMissions.id, mission.id))
    .returning();
  return updated ?? mission;
}

async function failMission(deps: Deps, mission: AgentMissionRow, error: string): Promise<void> {
  const nextStep = (mission.currentStep ?? 0) + 1;
  const steps = [...asSteps(mission.steps), { step: nextStep, type: "error", message: error, timestamp: new Date().toISOString() }];
  await saveMission(deps.db, mission, {
    status: "failed",
    error,
    currentStep: nextStep,
    steps,
    updatedAt: new Date().toISOString(),
  });
  await notifyUser(deps, mission.userId, "task_done", `任务未完成: ${mission.title}`, error.slice(0, 200), {
    url: missionsUrl(deps),
  }).catch(() => {});
}

async function askApproval(
  deps: Deps,
  mission: AgentMissionRow,
  pending: Record<string, unknown>,
  what: string,
): Promise<boolean> {
  const token = randomBytes(32).toString("base64url");
  const nowIso = new Date().toISOString();
  const nextStep = (mission.currentStep ?? 0) + 1;
  const steps = [
    ...asSteps(mission.steps),
    {
      step: nextStep,
      type: "waiting_approval",
      ...(pending.command ? { command: pending.command } : { prompt: pending.prompt }),
      risk_level: pending.risk_level,
      risk_reasons: pending.risk_reasons,
      requested_at: nowIso,
    },
  ];
  await saveMission(deps.db, mission, {
    status: "waiting_approval",
    approvalToken: token,
    pendingAction: pending,
    currentStep: nextStep,
    steps,
    updatedAt: nowIso,
  });
  const path = `/api/missions/${mission.id}/approve?token=${token}`;
  const pub = deps.settings.publicUrl.replace(/\/+$/, "");
  await notifyUser(
    deps,
    mission.userId,
    "risky",
    `🚨 任务需要授权: ${mission.title}`,
    `${what}\n原因: ${String(pending.reason || "继续执行任务")}`,
    { url: pub ? `${pub}${path}` : path },
  ).catch(() => {});
  return true;
}

async function dispatchMissionTask(
  deps: Deps,
  mission: AgentMissionRow,
  user: UserRow,
  machineList: MachineRow[],
  target: MachineRow | null,
  action: "shell" | "agent",
  payload: Record<string, unknown>,
  timeoutSec: number,
  step: Record<string, unknown>,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const what = action === "shell" ? "执行命令" : "交给智能体";
  const ctx = asObj(mission.context);
  const nextStep = (mission.currentStep ?? 0) + 1;
  const steps = asSteps(mission.steps);

  if (!target) {
    steps.push({
      step: nextStep,
      type: "error",
      message: !machineList.length ? `无法${what}：用户未绑定任何终端设备` : `无法${what}：没有在线的设备，稍后再试`,
      ...(step.command ? { command: step.command } : {}),
      ...(step.prompt ? { prompt: step.prompt } : {}),
      timestamp: nowIso,
    });
    ctx.wait_until = new Date(now.getTime() + OFFLINE_RETRY_SECONDS * 1000).toISOString();
    await saveMission(deps.db, mission, { currentStep: nextStep, steps, context: ctx, updatedAt: nowIso });
    return false;
  }

  const taskId = randomUUID();
  const [devTask] = await deps.db
    .insert(deviceTasks)
    .values(
      withoutNul({
        id: taskId,
        deviceId: target.collectorTokenHash,
        machineId: target.id,
        userId: user.id,
        action,
        payload: { ...payload, mission_id: mission.id },
        timeoutSeconds: timeoutSec,
        status: "queued",
        createdAt: nowIso,
      }),
    )
    .returning();

  ctx.active_device_task_id = taskId;
  steps.push({
    step: nextStep,
    ...step,
    device_name: target.name,
    device_task_id: taskId,
    dispatched_at: nowIso,
  });
  await saveMission(deps.db, mission, { currentStep: nextStep, steps, context: ctx, updatedAt: nowIso });
  await deliverTask(deps.db, devTask!, target);
  return true;
}

async function dispatchRemoteShell(
  deps: Deps,
  mission: AgentMissionRow,
  user: UserRow,
  command: string,
  reason: string,
  deviceHint?: string | null,
  machineList?: MachineRow[],
): Promise<boolean> {
  const [list, target] = await pickMachine(deps.db, user.id, deviceHint, machineList);
  return dispatchMissionTask(deps, mission, user, list, target, "shell", { command }, SHELL_TIMEOUT_SECONDS, {
    type: "exec_shell",
    command,
    reason,
  });
}

async function dispatchAgent(
  deps: Deps,
  mission: AgentMissionRow,
  user: UserRow,
  prompt: string,
  cwd: string | null,
  reason: string,
  deviceHint?: string | null,
  machineList?: MachineRow[],
): Promise<boolean> {
  const ctx = asObj(mission.context);
  const sessionId = String(ctx.agent_session_id || "") || null;
  const sessionMachine = String(ctx.agent_machine_id || "") || null;
  const [list, target] = await pickMachine(deps.db, user.id, deviceHint || sessionMachine, machineList);
  const payload: Record<string, unknown> = {
    prompt,
    binary: "claude",
    title: mission.title,
    user_question: prompt.slice(0, 500),
    claude_entrypoint: claudeEntrypoint(user.llmSettings as Record<string, unknown> | null),
  };
  if (cwd) payload.cwd = cwd;
  if (sessionId) {
    payload.session_id = sessionId;
    if (target && sessionMachine && sessionMachine !== target.id) payload.session_home = sessionMachine;
  }
  return dispatchMissionTask(deps, mission, user, list, target, "agent", payload, AGENT_TIMEOUT_SECONDS, {
    type: "run_agent",
    prompt,
    cwd,
    reason,
    ...(sessionId ? { session_id: sessionId } : {}),
  });
}

export async function stepMission(deps: Deps, initial: AgentMissionRow): Promise<boolean> {
  if (initial.status !== "running") return false;
  const { db, settings } = deps;
  const redis = deps.redis();
  const now = new Date();
  const nowIso = now.toISOString();

  const [user] = await db.select().from(users).where(eq(users.id, initial.userId)).limit(1);
  if (!user) {
    await saveMission(db, initial, { status: "failed", error: "User not found", updatedAt: nowIso });
    return false;
  }

  let mission = await saveMission(db, initial, { lastHeartbeat: nowIso });
  let ctx = asObj(mission.context);
  let steps = asSteps(mission.steps);
  let curStep = mission.currentStep ?? 0;

  let recorded = false;
  const activeTaskId = typeof ctx.active_device_task_id === "string" ? normalizeUuid(ctx.active_device_task_id) : null;
  if (activeTaskId) {
    const [devTask] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, activeTaskId)).limit(1);
    if (devTask && OPEN_TASK_STATUSES.has(devTask.status)) return false;
    if (devTask) {
      const output = devTask.stdout || devTask.stderr || devTask.error || "";
      const isAgent = devTask.action === "agent";
      curStep++;
      steps.push({
        step: curStep,
        type: "device_task_result",
        device_task_id: devTask.id,
        exit_code: devTask.exitCode,
        status: devTask.status,
        output_preview: isAgent ? output.slice(-AGENT_OUTPUT_PREVIEW) : output.slice(0, SHELL_OUTPUT_PREVIEW),
        completed_at: nowIso,
      });
      if (isAgent && devTask.sessionId) {
        ctx.agent_session_id = devTask.sessionId;
        ctx.agent_machine_id = devTask.machineId ?? null;
      }
    }
    delete ctx.active_device_task_id;
    mission = await saveMission(db, mission, { currentStep: curStep, steps, context: ctx, updatedAt: nowIso });
    recorded = true;
  }

  const untilMs = waitUntilMs(ctx);
  if (untilMs && now.getTime() < untilMs) return recorded;
  if (untilMs) {
    delete ctx.wait_until;
    mission = await saveMission(db, mission, { context: ctx, updatedAt: nowIso });
  }

  if (curStep >= MAX_STEPS) {
    await failMission(deps, mission, `已执行 ${MAX_STEPS} 步仍未完成，任务已停止`);
    return true;
  }

  const machineList = await userMachines(db, user.id);
  const onlineNames = machineList.filter((m) => Boolean(wsAlias(m.collectorTokenHash, m))).map((m) => m.name);

  const prompt = `你是一个运行在服务器后台的全天候自主 AI 助手。
你正在全天候为用户执行一项后台长任务：
任务标题: ${mission.title}
最终目标: ${mission.goal}
当前执行步骤进度: ${curStep}
用户当前在线的设备: ${onlineNames.join(", ") || "（暂无）"}

已执行的历史步骤:
${JSON.stringify(steps.slice(-5), null, 2)}

请决策下一步动作，严格返回 JSON 对象，格式如下：
如果目标已达成：
{"action": "finish", "summary": "详细说明达成结果"}
如果需要执行远程终端命令（或查询系统）：
{"action": "exec_shell", "command": "具体命令", "reason": "为何执行", "device_id": "可选设备名或留空"}
如果需要让编码智能体（Claude Code）在某台设备上完成一段工作：
{"action": "run_agent", "prompt": "完整指令", "cwd": "可选绝对路径", "reason": "为何交给智能体", "device_id": "可选设备名"}
如果需要休眠等待：
{"action": "wait", "seconds": 60, "reason": "等待原因"}

请直接输出合法 JSON，不要加多余修饰：`;

  let decision: Record<string, unknown> | null = null;
  try {
    const reply = await callPlainChat(settings, redis, [{ role: "user", content: prompt }], { user, background: true });
    if (reply) decision = parseDecision(reply);
  } catch {
    /* handled below */
  }

  const action = String(decision?.action ?? "");
  if (
    !ACTIONS.has(action) ||
    (action === "exec_shell" && !String(decision?.command ?? "").trim()) ||
    (action === "run_agent" && !String(decision?.prompt ?? "").trim())
  ) {
    const failures = Number(ctx.decision_failures ?? 0) + 1;
    if (failures >= MAX_DECISION_FAILURES) {
      await failMission(deps, mission, `连续 ${failures} 次没能从模型拿到可执行的下一步，任务已停止`);
      return true;
    }
    ctx.decision_failures = failures;
    ctx.wait_until = new Date(now.getTime() + 60 * 2 ** (failures - 1) * 1000).toISOString();
    await saveMission(db, mission, { context: ctx, updatedAt: nowIso });
    return recorded;
  }

  delete ctx.decision_failures;
  mission = await saveMission(db, mission, { context: ctx, updatedAt: nowIso });

  if (action === "finish") {
    const summary = String(decision?.summary || "任务已顺利完成");
    curStep++;
    steps.push({ step: curStep, type: "finish", summary, finished_at: nowIso });
    await saveMission(db, mission, { status: "succeeded", summary, currentStep: curStep, steps, updatedAt: nowIso });
    await notifyUser(deps, mission.userId, "task_done", `✅ 任务完成: ${mission.title}`, summary.slice(0, 200), {
      url: missionsUrl(deps),
    }).catch(() => {});
    return true;
  }

  if (action === "wait") {
    const parsedSec = Number.parseInt(String(decision?.seconds ?? 60), 10);
    const waitSec = Math.max(0, Math.min(Number.isFinite(parsedSec) ? parsedSec : 60, MAX_WAIT_SECONDS));
    curStep++;
    steps.push({ step: curStep, type: "wait", seconds: waitSec, reason: String(decision?.reason || "等待中"), timestamp: nowIso });
    ctx.wait_until = new Date(now.getTime() + waitSec * 1000).toISOString();
    await saveMission(db, mission, { currentStep: curStep, steps, context: ctx, updatedAt: nowIso });
    return true;
  }

  const reason = String(decision?.reason || "");
  const deviceHint = String(decision?.device_id || "").trim() || null;
  const proactive = asObj(user.proactiveSettings);
  const autoApproveWarn = proactive.auto_approve_safe !== false;

  if (action === "run_agent") {
    const agentPrompt = String(decision?.prompt ?? "").trim();
    const cwd = String(decision?.cwd || "").trim() || null;
    if (!autoApproveWarn) {
      return askApproval(
        deps,
        mission,
        { action: "run_agent", prompt: agentPrompt, cwd, reason, device_id: deviceHint, risk_level: "warn", risk_reasons: ["交给智能体自主读写代码"] },
        `AI 拟让智能体执行: ${agentPrompt.slice(0, 120)}`,
      );
    }
    return dispatchAgent(deps, mission, user, agentPrompt, cwd, reason, deviceHint, machineList);
  }

  const cmd = String(decision?.command ?? "").trim();
  const risk = classifyShellCommand(cmd);
  const riskLevel = risk?.level ?? "low";
  const riskReasons = risk?.reasons ?? [];
  const requiresApproval = riskLevel === "danger" || riskLevel === "critical" || (riskLevel === "warn" && !autoApproveWarn);
  if (!requiresApproval) {
    return dispatchRemoteShell(deps, mission, user, cmd, reason, deviceHint, machineList);
  }
  return askApproval(
    deps,
    mission,
    { action: "exec_shell", command: cmd, reason, device_id: deviceHint, risk_level: riskLevel, risk_reasons: riskReasons },
    `AI 拟执行高危命令: ${cmd}`,
  );
}

export async function stepMissionLocked(deps: Deps, mission: AgentMissionRow): Promise<boolean> {
  const lock = await cluster.mutex(`mission:${mission.id}`, 300);
  if (!lock) return false;
  try {
    const [fresh] = await deps.db.select().from(agentMissions).where(eq(agentMissions.id, mission.id)).limit(1);
    if (!fresh) return false;
    return await stepMission(deps, fresh);
  } finally {
    await lock.release();
  }
}

export async function wakeForTask(deps: Deps, taskId: string): Promise<void> {
  const tid = normalizeUuid(taskId);
  if (!tid) return;
  try {
    const [task] = await deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
    const pl = asObj(task?.payload);
    const missionId = typeof pl.mission_id === "string" ? normalizeUuid(pl.mission_id) : null;
    if (!missionId) return;
    const [mission] = await deps.db.select().from(agentMissions).where(eq(agentMissions.id, missionId)).limit(1);
    if (mission && mission.status === "running" && asObj(mission.context).active_device_task_id === taskId) {
      await stepMissionLocked(deps, mission);
    }
  } catch {
    /* non-blocking */
  }
}

export async function approveMission(
  deps: Deps,
  missionId: string,
  token: string | null | undefined,
  userId: string | null | undefined,
): Promise<boolean> {
  const [mission] = await deps.db.select().from(agentMissions).where(eq(agentMissions.id, missionId)).limit(1);
  if (!mission || mission.status !== "waiting_approval") return false;
  const tokenValid = Boolean(token && mission.approvalToken && safeEqual(token, mission.approvalToken));
  const userValid = Boolean(userId && mission.userId === userId);
  if (!tokenValid && !userValid) return false;

  const pending = asObj(mission.pendingAction);
  const nowIso = new Date().toISOString();
  const nextStep = (mission.currentStep ?? 0) + 1;
  const steps = [...asSteps(mission.steps), { step: nextStep, type: "approved", action: pending, approved_at: nowIso }];
  const updated = await saveMission(deps.db, mission, {
    status: "running",
    approvalToken: null,
    pendingAction: null,
    currentStep: nextStep,
    steps,
    updatedAt: nowIso,
  });

  const [user] = await deps.db.select().from(users).where(eq(users.id, mission.userId)).limit(1);
  if (user && pending.action === "exec_shell" && typeof pending.command === "string" && pending.command) {
    await dispatchRemoteShell(
      deps,
      updated,
      user,
      pending.command,
      String(pending.reason || "用户已审批放行"),
      typeof pending.device_id === "string" ? pending.device_id : null,
    );
  } else if (user && pending.action === "run_agent" && typeof pending.prompt === "string" && pending.prompt) {
    await dispatchAgent(
      deps,
      updated,
      user,
      pending.prompt,
      typeof pending.cwd === "string" ? pending.cwd : null,
      String(pending.reason || "用户已审批放行"),
      typeof pending.device_id === "string" ? pending.device_id : null,
    );
  }
  return true;
}

export async function rejectMission(
  deps: Deps,
  missionId: string,
  token: string | null | undefined,
  userId: string | null | undefined,
  reason = "用户驳回",
): Promise<boolean> {
  const [mission] = await deps.db.select().from(agentMissions).where(eq(agentMissions.id, missionId)).limit(1);
  if (!mission || mission.status !== "waiting_approval") return false;
  const tokenValid = Boolean(token && mission.approvalToken && safeEqual(token, mission.approvalToken));
  const userValid = Boolean(userId && mission.userId === userId);
  if (!tokenValid && !userValid) return false;

  const nowIso = new Date().toISOString();
  const nextStep = (mission.currentStep ?? 0) + 1;
  const steps = [...asSteps(mission.steps), { step: nextStep, type: "rejected", reason, rejected_at: nowIso }];
  await saveMission(deps.db, mission, {
    status: "cancelled",
    approvalToken: null,
    pendingAction: null,
    summary: `任务已由用户驳回取消: ${reason}`,
    currentStep: nextStep,
    steps,
    updatedAt: nowIso,
  });
  return true;
}

export async function advanceUserMissions(deps: Deps, userId: string): Promise<void> {
  const rows = await deps.db
    .select()
    .from(agentMissions)
    .where(and(eq(agentMissions.userId, userId), eq(agentMissions.status, "running")))
    .orderBy(asc(agentMissions.lastHeartbeat))
    .limit(3);
  for (const m of rows) {
    try {
      await stepMissionLocked(deps, m);
    } catch {
      /* per-mission isolation */
    }
  }
}
