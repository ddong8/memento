// /api/missions: Autonomous Background Missions API & Mobile Quick Approval (server/server/api/missions.py).
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { agentMissions } from "../db/pulled/schema";
import { HttpError, parseJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import * as missionService from "../services/mission-service";

export const missionRoutes = new Hono<AppEnv>();

const APPROVED_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>审批通过 - Memento 智能执事</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
    .card { background: #1E293B; border: 1px solid #334155; border-radius: 20px; padding: 32px 24px; max-width: 400px; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.4); }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 20px; margin: 0 0 12px; font-weight: 600; color: #10B981; }
    p { font-size: 14px; color: #94A3B8; line-height: 1.6; margin: 0 0 24px; }
    .badge { display: inline-block; background: rgba(16,185,129,0.15); color: #34D399; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>高危操作已授权放行</h1>
    <p>任务已恢复执行，AI 正在远程设备上继续推进工作。执行完毕后将自动向您汇报。</p>
    <div class="badge">Memento 24/7 Always-On</div>
  </div>
</body>
</html>`;

const INVALID_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>授权无效 - Memento</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0F172A; color: #F8FAFC; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1E293B; border: 1px solid #334155; border-radius: 20px; padding: 32px 24px; max-width: 400px; text-align: center; }
    h1 { font-size: 20px; margin: 0 0 12px; color: #EF4444; }
    p { font-size: 14px; color: #94A3B8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>授权无效或已过期</h1>
    <p>该操作可能已被处理、撤销或令牌已失效。</p>
  </div>
</body>
</html>`;

missionRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const status = c.req.query("status");
  const limit = queryInt(c, "limit", 20);
  const conds = [eq(agentMissions.userId, user.id)];
  if (status) conds.push(eq(agentMissions.status, status));
  const rows = await c.var.deps.db
    .select({
      id: agentMissions.id,
      title: agentMissions.title,
      goal: agentMissions.goal,
      status: agentMissions.status,
      riskLevel: agentMissions.riskLevel,
      currentStep: agentMissions.currentStep,
      steps: agentMissions.steps,
      pendingAction: agentMissions.pendingAction,
      summary: agentMissions.summary,
      error: agentMissions.error,
      lastHeartbeat: agentMissions.lastHeartbeat,
      createdAt: agentMissions.createdAt,
    })
    .from(agentMissions)
    .where(and(...conds))
    .orderBy(desc(agentMissions.createdAt))
    .limit(limit);

  return c.json(
    rows.map((m) => ({
      id: m.id,
      title: m.title,
      goal: m.goal,
      status: m.status,
      risk_level: m.riskLevel,
      current_step: m.currentStep,
      steps_count: Array.isArray(m.steps) ? m.steps.length : 0,
      pending_action: m.pendingAction,
      summary: m.summary,
      error: m.error,
      last_heartbeat: pgToIso(m.lastHeartbeat),
      created_at: pgToIso(m.createdAt),
    })),
  );
});

missionRoutes.post("", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const title = typeof body.title === "string" ? body.title : "";
  const goal = typeof body.goal === "string" ? body.goal : "";
  if (!title || !goal) {
    throw new HttpError(422, [{ type: "missing", loc: ["body", !title ? "title" : "goal"], msg: "Field required", input: body }]);
  }
  const mission = await missionService.createMission(
    c.var.deps.db,
    user,
    title,
    goal,
    body.context && typeof body.context === "object" && !Array.isArray(body.context) ? (body.context as Record<string, unknown>) : {},
    typeof body.risk_level === "string" ? body.risk_level : "low",
  );
  return c.json({ id: mission.id, status: mission.status, title: mission.title });
});

missionRoutes.get("/:mission_id", async (c) => {
  const user = await currentUser(c);
  const mid = pathUuid(c, "mission_id");
  const [m] = await c.var.deps.db
    .select()
    .from(agentMissions)
    .where(and(eq(agentMissions.id, mid), eq(agentMissions.userId, user.id)))
    .limit(1);
  if (!m) throw new HttpError(404, "Mission not found");
  return c.json({
    id: m.id,
    title: m.title,
    goal: m.goal,
    status: m.status,
    risk_level: m.riskLevel,
    current_step: m.currentStep,
    steps: m.steps ?? [],
    pending_action: m.pendingAction,
    summary: m.summary,
    error: m.error,
    last_heartbeat: pgToIso(m.lastHeartbeat),
    created_at: pgToIso(m.createdAt),
  });
});

missionRoutes.get("/:mission_id/approve", async (c) => {
  const mid = pathUuid(c, "mission_id");
  const token = c.req.query("token");
  if (!token) throw new HttpError(422, [{ type: "missing", loc: ["query", "token"], msg: "Field required", input: null }]);
  const ok = await missionService.approveMission(c.var.deps, mid, token, null);
  return c.html(ok ? APPROVED_HTML : INVALID_HTML, ok ? 200 : 400);
});

missionRoutes.post("/:mission_id/approve", async (c) => {
  const user = await currentUser(c);
  const mid = pathUuid(c, "mission_id");
  const body = await parseJsonObject(c);
  const token = typeof body.token === "string" ? body.token : null;
  const ok = await missionService.approveMission(c.var.deps, mid, token, user.id);
  if (!ok) throw new HttpError(400, "Cannot approve mission (invalid state or credentials)");
  return c.json({ status: "ok", message: "Mission resumed successfully" });
});

missionRoutes.post("/:mission_id/reject", async (c) => {
  const user = await currentUser(c);
  const mid = pathUuid(c, "mission_id");
  const body = await parseJsonObject(c);
  const token = typeof body.token === "string" ? body.token : null;
  const reason = typeof body.reason === "string" ? body.reason : "用户驳回";
  const ok = await missionService.rejectMission(c.var.deps, mid, token, user.id, reason);
  if (!ok) throw new HttpError(400, "Cannot reject mission");
  return c.json({ status: "ok", message: "Mission rejected and cancelled" });
});
