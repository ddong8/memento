// Scheduled agent tasks CRUD and run-now (server/server/api/scheduled_tasks.py).
import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { currentUser } from "../auth/current-user";
import type { AppEnv } from "../context";
import { scheduledTasks } from "../db/pulled/schema";
import { HttpError, parseJsonObject } from "../http";
import { pgToIso } from "../pytime";
import {
  AGENT_MODES,
  nextRun,
  normalizePermissionMode,
  ownedScheduledTask,
  startScheduledTask,
  validSchedule,
  type ScheduledTaskRow,
} from "../services/scheduled-tasks";

function checkAgentSchedule(agent: string | null, schedule: string | null): void {
  if (agent !== null && !(AGENT_MODES as readonly string[]).includes(agent) && agent !== "shell") {
    throw new HttpError(400, `不认识的智能体：${agent}`);
  }
  if (schedule !== null && !validSchedule(schedule)) {
    throw new HttpError(400, "周期格式不对：hourly:MM、daily:HH:MM 或 weekly:D:HH:MM（D 0=周一）");
  }
}

function serializeScheduled(st: ScheduledTaskRow) {
  return {
    id: String(st.id),
    title: st.title,
    device: st.device,
    agent: st.agent,
    prompt: st.prompt,
    cwd: st.cwd,
    permission_mode: st.permissionMode,
    schedule: st.schedule,
    tz_offset_min: st.tzOffsetMin,
    enabled: st.enabled,
    next_run_at: pgToIso(st.nextRunAt),
    last_run_at: pgToIso(st.lastRunAt),
    last_task_id: st.lastTaskId ? String(st.lastTaskId) : null,
    last_status: st.lastStatus,
  };
}

function checkStr(val: unknown, field: string, minLen: number, maxLen: number): string {
  if (typeof val !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", field], msg: "Input should be a valid string", input: val }]);
  }
  if (val.length < minLen || val.length > maxLen) {
    throw new HttpError(422, [{ type: "string_length", loc: ["body", field], msg: `Length must be ${minLen}..${maxLen}`, input: val }]);
  }
  return val;
}

export const scheduledTaskRoutes = new Hono<AppEnv>();

scheduledTaskRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const rows = await c.var.deps.db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.userId, user.id))
    .orderBy(asc(scheduledTasks.createdAt));
  return c.json({ tasks: rows.map(serializeScheduled) });
});

scheduledTaskRoutes.post("", async (c) => {
  const user = await currentUser(c);
  const body = await parseJsonObject(c);
  const title = checkStr(body.title, "title", 1, 200).trim();
  const device = checkStr(body.device, "device", 1, 255).trim();
  const prompt = checkStr(body.prompt, "prompt", 1, 20_000);
  const schedule = checkStr(body.schedule, "schedule", 1, 40).trim();
  const agent = typeof body.agent === "string" ? body.agent : "claude";
  const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
  const permissionMode = normalizePermissionMode(typeof body.permission_mode === "string" ? body.permission_mode : "full");
  const tzOffsetMin = body.tz_offset_min === undefined ? 480 : Number(body.tz_offset_min);
  if (!Number.isInteger(tzOffsetMin) || tzOffsetMin < -720 || tzOffsetMin > 840) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["body", "tz_offset_min"], msg: "tz_offset_min must be in -720..840", input: body.tz_offset_min }]);
  }
  const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;

  checkAgentSchedule(agent, schedule);
  const nextRunAt = enabled ? nextRun(schedule, tzOffsetMin, new Date()).toISOString() : null;
  const [inserted] = await c.var.deps.db
    .insert(scheduledTasks)
    .values({
      id: randomUUID(),
      userId: user.id,
      title,
      device,
      agent,
      prompt,
      cwd,
      permissionMode,
      schedule,
      tzOffsetMin,
      enabled,
      nextRunAt,
    })
    .returning();
  return c.json(serializeScheduled(inserted!));
});

scheduledTaskRoutes.patch("/:sid", async (c) => {
  const user = await currentUser(c);
  const sid = c.req.param("sid");
  const st = await ownedScheduledTask(c.var.deps.db, user, sid);
  if (!st) throw new HttpError(404, "Not Found");
  const body = await parseJsonObject(c);

  const patch: Partial<typeof scheduledTasks.$inferInsert> = {};
  if (body.title !== undefined && body.title !== null) patch.title = checkStr(body.title, "title", 1, 200).trim();
  if (body.prompt !== undefined && body.prompt !== null) patch.prompt = checkStr(body.prompt, "prompt", 1, 20_000);
  if (body.schedule !== undefined && body.schedule !== null) {
    const sc = checkStr(body.schedule, "schedule", 1, 40).trim();
    checkAgentSchedule(null, sc);
    patch.schedule = sc;
  }
  if (body.tz_offset_min !== undefined && body.tz_offset_min !== null) {
    const tz = Number(body.tz_offset_min);
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) {
      throw new HttpError(422, [{ type: "int_parsing", loc: ["body", "tz_offset_min"], msg: "tz_offset_min must be in -720..840", input: body.tz_offset_min }]);
    }
    patch.tzOffsetMin = tz;
  }
  if (body.enabled !== undefined && body.enabled !== null) patch.enabled = Boolean(body.enabled);
  if (body.cwd !== undefined) patch.cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
  if (body.permission_mode !== undefined && body.permission_mode !== null) {
    patch.permissionMode = normalizePermissionMode(String(body.permission_mode));
  }

  const nextSchedule = patch.schedule ?? st.schedule;
  const nextTz = patch.tzOffsetMin ?? st.tzOffsetMin;
  const nextEnabled = patch.enabled ?? st.enabled;
  patch.nextRunAt = nextEnabled ? nextRun(nextSchedule, nextTz, new Date()).toISOString() : null;

  const [updated] = await c.var.deps.db.update(scheduledTasks).set(patch).where(eq(scheduledTasks.id, st.id)).returning();
  return c.json(serializeScheduled(updated!));
});

scheduledTaskRoutes.delete("/:sid", async (c) => {
  const user = await currentUser(c);
  const st = await ownedScheduledTask(c.var.deps.db, user, c.req.param("sid"));
  if (!st) throw new HttpError(404, "Not Found");
  await c.var.deps.db.delete(scheduledTasks).where(eq(scheduledTasks.id, st.id));
  return c.json({ ok: true });
});

scheduledTaskRoutes.post("/:sid/run", async (c) => {
  const user = await currentUser(c);
  const st = await ownedScheduledTask(c.var.deps.db, user, c.req.param("sid"));
  if (!st) throw new HttpError(404, "Not Found");
  const task = await startScheduledTask(c.var.deps.db, st, new Date());
  return c.json({ ok: true, task_id: task ? String(task.id) : null, status: task ? task.status : null });
});
