// Record risky agent operations on their task and push phone notifications (server/server/services/task_alerts.py).
import { desc, eq } from "drizzle-orm";
import type { Redis } from "ioredis";

import type { Settings } from "../config";
import { withoutNul, type Db } from "../db/client";
import { askConversations, deviceTasks } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { usageLimitMessage } from "./agent-limits";
import { allowRiskyPush, forgetTask, notifyUser, taskLink } from "./notify";
import { classifyToolUse, findingAsAlert, type RiskFinding } from "./risk-policy";
import { onScheduledTaskFinished } from "./scheduled-tasks";
import { wsManager } from "./ws-manager";

export const MAX_ALERTS_PER_TASK = 50;

export interface TaskAlertDeps {
  db: Db;
  settings: Settings;
  redis: () => Redis | null;
}

export function displayDeviceName(name: string | null | undefined): string {
  const stripped = (name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return stripped.replace(/\.local$/, "") || "设备";
}

export async function appendAlert(
  db: Db,
  taskId: string,
  alert: Record<string, unknown>,
  opts: { machineId?: string | null } = {},
): Promise<string | null> {
  const tid = normalizeUuid(taskId);
  if (!tid) return null;
  const [task] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!task) return null;
  if (opts.machineId && task.machineId !== opts.machineId) return null;
  const existing = Array.isArray(task.alerts) ? (task.alerts as Record<string, unknown>[]) : [];
  const next = [...existing, alert].slice(-MAX_ALERTS_PER_TASK);
  await db.update(deviceTasks).set({ alerts: withoutNul(next) }).where(eq(deviceTasks.id, tid));
  return task.userId;
}

export async function raiseAlert(
  deps: TaskAlertDeps,
  taskId: string,
  finding: RiskFinding,
  tool: string,
  deviceName: string | null | undefined,
  opts: { machineId?: string | null; userId?: string | null; streamToWatchers?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const alert: Record<string, unknown> = {
    ...findingAsAlert(finding, tool),
    at: new Date().toISOString().replace("Z", "+00:00"),
  };
  const owner = await appendAlert(deps.db, taskId, alert, { machineId: opts.machineId });
  if (!owner) return null;
  if (opts.streamToWatchers !== false) wsManager.pushAlert(taskId, alert);
  if (await allowRiskyPush(deps.redis(), taskId)) {
    let targetUrl = taskLink(deps.settings, taskId);
    try {
      const tid = normalizeUuid(taskId);
      if (tid) {
        const [row] = await deps.db.select({ payload: deviceTasks.payload }).from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
        const pl = row?.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null;
        const cid = String(pl?.conversation_id ?? "").trim();
        if (cid) {
          const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
          targetUrl = base ? `${base}/ask?id=${cid}&scroll=bottom` : `/ask?id=${cid}&scroll=bottom`;
        }
      }
    } catch {
      /* keep default link */
    }
    await notifyUser(deps, opts.userId || owner, "risky", `⚠️ ${finding.label}`, `${displayDeviceName(deviceName)}：${finding.detail}`, {
      url: targetUrl,
    });
  }
  return alert;
}

export async function handleAgentToolUse(
  deps: TaskAlertDeps,
  machineId: string,
  deviceName: string | null | undefined,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const tool = String(data.tool ?? "");
    const input = data.input && typeof data.input === "object" ? (data.input as Record<string, unknown>) : {};
    const finding = classifyToolUse(tool, input, typeof data.cwd === "string" ? data.cwd : null);
    const taskId = String(data.task_id ?? "");
    if (finding && taskId) {
      await raiseAlert(deps, taskId, finding, tool, deviceName, { machineId });
    }
  } catch (e) {
    console.error("[task_alerts] handleAgentToolUse failed", e);
  }
}

export async function handleWaitingQuestion(
  deps: TaskAlertDeps,
  userId: string | null | undefined,
  taskId: string,
  event: Record<string, unknown>,
): Promise<void> {
  if (!userId || event.kind !== "question" || (event.status !== undefined && event.status !== null && event.status !== "waiting")) {
    return;
  }
  try {
    const question = String(event.question ?? "").trim();
    if (!question) return;
    const title = event.approval ? "需要你批准" : "智能体在等你回答";
    const body = question.length <= 120 ? question : `${question.slice(0, 119)}…`;
    await notifyUser(deps, userId, "task_done", title, body, { url: taskLink(deps.settings, taskId) });
  } catch (e) {
    console.error("[task_alerts] handleWaitingQuestion failed", e);
  }
}

function taskSummary(task: typeof deviceTasks.$inferSelect): string {
  const pl = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  let text = String(pl.user_question ?? pl.prompt ?? pl.command ?? "").trim();
  const marker = "【当前用户指令】\n";
  const mIdx = text.indexOf(marker);
  if (mIdx >= 0) {
    text = text.slice(mIdx + marker.length).trim();
  } else if (text.includes("进行图像分析与代码实现。")) {
    text = text.split("进行图像分析与代码实现。").pop()?.trim() || text;
  }
  const first = text.split(/\r?\n/)[0] || "（无描述）";
  return first.length <= 60 ? first : `${first.slice(0, 59)}…`;
}

export async function handleTaskFinished(
  deps: TaskAlertDeps,
  taskId: string,
  statusIn: string | null | undefined,
  deviceName: string | null | undefined,
  watched: boolean,
): Promise<void> {
  await forgetTask(deps.redis(), taskId);
  let status = statusIn ?? "";
  if (status === "cancelled") return;
  try {
    const tid = normalizeUuid(taskId);
    if (!tid) return;
    const [task] = await deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
    const pl = (task?.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
    if (task && pl.scheduled_task_id) {
      await onScheduledTaskFinished(deps, task);
      return;
    }
    if (!task || task.action !== "agent") return;
    if (pl.mission_id) return;

    const outOfQuota = usageLimitMessage({ action: task.action, status: task.status, error: task.error });
    if (outOfQuota) status = "failed";

    const explicitConvId = String(pl.conversation_id ?? "").trim();
    let convId = explicitConvId;
    if (!convId && task.userId) {
      try {
        const [recent] = await deps.db
          .select({ id: askConversations.id })
          .from(askConversations)
          .where(eq(askConversations.userId, task.userId))
          .orderBy(desc(askConversations.updatedAt))
          .limit(1);
        if (recent?.id) convId = recent.id;
      } catch {
        /* ignore */
      }
    }
    const base = (deps.settings.publicUrl || "").replace(/\/+$/, "");
    const targetUrl = convId
      ? base
        ? `${base}/ask?id=${convId}&scroll=bottom`
        : `/ask?id=${convId}&scroll=bottom`
      : taskLink(deps.settings, taskId);

    if (status === "still_running") {
      if (watched) return;
      await notifyUser(deps, task.userId, "task_running", "⏳ 任务已转入后台运行", `${displayDeviceName(deviceName)}：${taskSummary(task)}（后台任务正在执行中）`, {
        url: targetUrl,
      });
      return;
    }
    if (watched && explicitConvId) return;

    const titleMap: Record<string, string> = { succeeded: "✅ 任务完成", timeout: "⏱️ 任务超时" };
    const title = outOfQuota ? "⛔ 智能体额度已用完" : (titleMap[status] ?? "❌ 任务失败");
    let body = `${displayDeviceName(deviceName)}：${taskSummary(task)}`;
    if (outOfQuota) body += `（${outOfQuota}）`;
    const alerts = Array.isArray(task.alerts) ? task.alerts : [];
    if (alerts.length) body += `（期间 ${alerts.length} 次危险操作）`;
    await notifyUser(deps, task.userId, "task_done", title, body, { url: targetUrl });
  } catch (e) {
    console.error("[task_alerts] handleTaskFinished failed", taskId, e);
  }
}
