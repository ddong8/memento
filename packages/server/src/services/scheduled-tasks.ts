// Scheduled agent tasks: schedule parsing, dispatch, completion hook & leased tick loop (server/server/services/scheduled_tasks.py).
import { randomUUID } from "node:crypto";

import { and, desc, eq, lte, or, sql } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { deviceTasks, machines, scheduledTasks, userMemories } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { cluster } from "./cluster";
import { deliverTask, type DeviceTaskRow } from "./device-dispatch";
import { notifyUser } from "./notify";

export type ScheduledTaskRow = typeof scheduledTasks.$inferSelect;

export const PERMISSION_MODES = ["full", "auto_edits", "supervised", "auto"] as const;
export const ACP_MODES = ["opencode", "gemini", "cursor", "kiro", "copilot"] as const;
export const AGENT_MODES = ["claude", "codex", "antigravity", "workbuddy", ...ACP_MODES] as const;

export function normalizePermissionMode(mode: string | null | undefined): string {
  const m = (mode ?? "").trim().toLowerCase();
  return (PERMISSION_MODES as readonly string[]).includes(m) ? m : "full";
}

const SCHEDULE_RE = /^(?:hourly:(\d{1,2})|daily:(\d{1,2}):(\d{1,2})|weekly:([0-6]):(\d{1,2}):(\d{1,2}))$/;
const AGENT_BINARIES: Record<string, string> = { antigravity: "agy" };

export function validSchedule(schedule: string): boolean {
  const s = schedule.trim();
  const m = SCHEDULE_RE.exec(s);
  if (!m) return false;
  if (s.startsWith("hourly")) return Number(m[1]) < 60;
  if (s.startsWith("daily")) return Number(m[2]) < 24 && Number(m[3]) < 60;
  return Number(m[5]) < 24 && Number(m[6]) < 60;
}

/** Compute the first run strictly after `after` (UTC Date) in the user's fixed tz_offset_min. */
export function nextRun(schedule: string, tzOffsetMin: number, after: Date): Date {
  const m = SCHEDULE_RE.exec(schedule.trim());
  if (!m) throw new Error(`bad schedule: ${schedule}`);
  const offsetMs = tzOffsetMin * 60_000;
  const afterMs = after.getTime();
  // Shifted wall-clock representation using UTC fields
  const shifted = new Date(afterMs + offsetMs);
  shifted.setUTCSeconds(0, 0);

  let candMs: number;
  if (m[1] !== undefined) {
    shifted.setUTCMinutes(Number(m[1]));
    candMs = shifted.getTime() - offsetMs;
    while (candMs <= afterMs) candMs += 3600_000;
  } else if (m[2] !== undefined && m[3] !== undefined) {
    shifted.setUTCHours(Number(m[2]), Number(m[3]), 0, 0);
    candMs = shifted.getTime() - offsetMs;
    while (candMs <= afterMs) candMs += 86400_000;
  } else {
    const dow = Number(m[4]); // 0=Mon..6=Sun (Python weekday())
    const hh = Number(m[5]);
    const mm = Number(m[6]);
    const pyWeekday = (shifted.getUTCDay() + 6) % 7;
    const deltaDays = ((dow - pyWeekday) % 7 + 7) % 7;
    shifted.setUTCHours(hh, mm, 0, 0);
    candMs = shifted.getTime() + deltaDays * 86400_000 - offsetMs;
    while (candMs <= afterMs) candMs += 7 * 86400_000;
  }
  return new Date(candMs);
}

export function taskPayloadForScheduled(st: ScheduledTaskRow): [string, Record<string, unknown>] {
  if (st.agent === "shell") {
    return ["shell", { command: st.prompt, ...(st.cwd ? { cwd: st.cwd } : {}), scheduled_task_id: String(st.id) }];
  }
  return [
    "agent",
    {
      binary: AGENT_BINARIES[st.agent] ?? st.agent,
      prompt: st.prompt,
      user_question: st.prompt,
      title: `定时任务：${st.title}`,
      ...(st.cwd ? { cwd: st.cwd } : {}),
      ...(st.permissionMode && st.permissionMode !== "full" ? { permission_mode: st.permissionMode } : {}),
      scheduled_task_id: String(st.id),
    },
  ];
}

export async function startScheduledTask(db: Db, st: ScheduledTaskRow, now: Date): Promise<DeviceTaskRow> {
  const [machine] = await db
    .select()
    .from(machines)
    .where(and(or(eq(machines.collectorTokenHash, st.device), eq(machines.name, st.device)), eq(machines.userId, st.userId)))
    .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`))
    .limit(1);

  const [action, payload] = taskPayloadForScheduled(st);
  const taskId = randomUUID();
  const [inserted] = await db
    .insert(deviceTasks)
    .values({
      id: taskId,
      deviceId: machine ? machine.collectorTokenHash : st.device,
      machineId: machine ? machine.id : null,
      userId: st.userId,
      action,
      payload: withoutNul(payload),
      timeoutSeconds: action === "agent" ? 7200 : 600,
      status: "queued",
    })
    .returning();

  await db
    .update(scheduledTasks)
    .set({ lastRunAt: now.toISOString(), lastTaskId: taskId, lastStatus: "running" })
    .where(eq(scheduledTasks.id, st.id));

  const { task } = await deliverTask(db, inserted!, machine ?? null);
  return task;
}

export async function runDueScheduledTasks(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), lte(scheduledTasks.nextRunAt, now.toISOString())));
  let started = 0;
  for (const st of due) {
    const next = nextRun(st.schedule, st.tzOffsetMin, now);
    await db.update(scheduledTasks).set({ nextRunAt: next.toISOString() }).where(eq(scheduledTasks.id, st.id));
    try {
      await startScheduledTask(db, st, now);
      started++;
    } catch {
      await db.update(scheduledTasks).set({ lastStatus: "failed" }).where(eq(scheduledTasks.id, st.id));
    }
  }
  return started;
}

function formatLocalMinute(d: Date, tzOffsetMin: number): string {
  const shifted = new Date(d.getTime() + tzOffsetMin * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export async function onScheduledTaskFinished(
  deps: { db: Db; settings: Settings; redis: () => Redis | null },
  task: DeviceTaskRow,
): Promise<boolean> {
  const pl = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  const sid = normalizeUuid(String(pl.scheduled_task_id ?? ""));
  if (!sid) return false;
  const [st] = await deps.db.select().from(scheduledTasks).where(eq(scheduledTasks.id, sid)).limit(1);
  if (!st) return true;
  await deps.db.update(scheduledTasks).set({ lastStatus: task.status }).where(eq(scheduledTasks.id, sid));

  const out = String(task.stdout || task.error || "").trim();
  const summary = out.length <= 1500 ? out : `…${out.slice(-1500)}`;
  const when = formatLocalMinute(new Date(), st.tzOffsetMin);
  if (summary) {
    await deps.db.insert(userMemories).values({
      id: randomUUID(),
      userId: st.userId,
      category: "project",
      key: `定时任务：${st.title}`.slice(0, 120),
      content: `${when} 在 ${st.device} 运行（${task.status}）：\n${summary}`,
      source: "scheduled",
      confidence: 0.8,
      isFolder: false,
    });
  }
  const ok = task.status === "succeeded";
  await notifyUser(deps, st.userId, "task_done", `定时任务${ok ? "完成" : "失败"}：${st.title}`, (summary || task.status).slice(0, 200));
  return true;
}

export async function ownedScheduledTask(db: Db, user: UserRow, sid: string): Promise<ScheduledTaskRow | null> {
  const uid = normalizeUuid(sid);
  if (!uid) return null;
  const [row] = await db
    .select()
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.id, uid), eq(scheduledTasks.userId, user.id)))
    .limit(1);
  return row ?? null;
}

let schedulerTimer: NodeJS.Timeout | null = null;

export function startScheduledTaskRunner(db: Db): void {
  if (schedulerTimer) return;
  const tick = async () => {
    try {
      const mine = await cluster.holdLease("scheduled-tasks", 90);
      if (mine) await runDueScheduledTasks(db);
    } catch {
      /* ignore tick error */
    }
  };
  schedulerTimer = setInterval(() => void tick(), 60_000);
  schedulerTimer.unref?.();
}

export async function stopScheduledTaskRunner(): Promise<void> {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  await cluster.releaseLease("scheduled-tasks");
}
