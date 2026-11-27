// /api/plans: collaborative multi-agent plans (server/server/api/plans.py).
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser, type UserRow } from "../auth/current-user";
import type { AppEnv, Deps } from "../context";
import { agentPlans } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, queryInt } from "../http";
import * as planService from "../services/plan-service";

export const planRoutes = new Hono<AppEnv>();

async function ownPlan(deps: Deps, user: UserRow, planId: string) {
  const pid = normalizeUuid(planId);
  if (!pid) throw new HttpError(404, "Not Found");
  const [plan] = await deps.db.select().from(agentPlans).where(eq(agentPlans.id, pid)).limit(1);
  if (!plan || plan.userId !== user.id) throw new HttpError(404, "Not Found");
  return plan;
}

function mustPlan(plan: planService.AgentPlanRow | null) {
  if (!plan) throw new HttpError(404, "Not Found");
  return planService.planOut(plan);
}

planRoutes.post("", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  if (!goal) throw new HttpError(400, "任务内容不能为空");
  const options: Record<string, unknown> = { review: body.review !== false };
  if (body.max_parallel) options.max_parallel = Math.max(1, Math.min(Number(body.max_parallel), 8));
  if (body.step_timeout) options.step_timeout = Math.max(300, Math.min(Number(body.step_timeout), 14400));
  const plan = await planService.createPlan(c.var.deps, user, goal, {
    cwd: typeof body.cwd === "string" ? body.cwd : null,
    sourceDeviceId: typeof body.source_device_id === "string" ? body.source_device_id : null,
    projectId: typeof body.project_id === "string" ? body.project_id : null,
    autoStart: body.auto_start !== false,
    title: typeof body.title === "string" ? body.title : "",
    options,
  });
  return c.json(planService.planOut(plan));
});

planRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const limit = Math.max(1, Math.min(queryInt(c, "limit", 30), 100));
  const rows = await c.var.deps.db
    .select()
    .from(agentPlans)
    .where(eq(agentPlans.userId, user.id))
    .orderBy(desc(agentPlans.createdAt))
    .limit(limit);
  return c.json(rows.map((p) => planService.planOut(p, false)));
});

planRoutes.get("/capabilities", async (c) => {
  const user = await currentUser(c);
  return c.json(await planService.capabilitySnapshot(c.var.deps, user));
});

planRoutes.get("/:plan_id", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  return c.json(planService.planOut(plan));
});

planRoutes.post("/:plan_id/start", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  if (plan.status !== "ready") throw new HttpError(409, "只有规划好、还没开始的任务能开始");
  return c.json(mustPlan(await planService.startPlan(c.var.deps.db, plan.id)));
});

planRoutes.post("/:plan_id/cancel", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  return c.json(mustPlan(await planService.cancelPlan(c.var.deps.db, plan.id)));
});

planRoutes.post("/:plan_id/replan", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  if (!["ready", "failed", "cancelled"].includes(plan.status)) throw new HttpError(409, "运行中的任务不能重新规划，先停止");
  return c.json(mustPlan(await planService.replan(c.var.deps.db, plan.id)));
});

planRoutes.put("/:plan_id/steps", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  if (plan.status !== "ready") throw new HttpError(409, "只能在开始前修改子任务");
  const body = await parseJsonObject(c);
  const steps = Array.isArray(body.steps) ? body.steps : [];
  return c.json(mustPlan(await planService.editSteps(c.var.deps, user, plan.id, steps)));
});

planRoutes.post("/:plan_id/steps/:step_id/retry", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  return c.json(mustPlan(await planService.retryStep(c.var.deps.db, plan.id, c.req.param("step_id"))));
});

planRoutes.post("/:plan_id/steps/:step_id/cancel", async (c) => {
  const user = await currentUser(c);
  const plan = await ownPlan(c.var.deps, user, c.req.param("plan_id"));
  return c.json(mustPlan(await planService.cancelStep(c.var.deps.db, plan.id, c.req.param("step_id"))));
});
