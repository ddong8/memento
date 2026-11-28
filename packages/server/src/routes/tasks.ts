// Remote task dispatch API & device WebSocket channel (server/server/api/tasks.py).
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { and, desc, eq, isNull, like, lt, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";

import { record as recordAudit } from "../audit";
import { currentUser, type UserRow } from "../auth/current-user";
import type { Settings } from "../config";
import { auditRequest, type AppEnv, type Deps } from "../context";
import { withoutNul, type Db } from "../db/client";
import { deviceTasks, machines, users } from "../db/pulled/schema";
import { HttpError, normalizeUuid, parseJsonObject, pathUuid, queryInt } from "../http";
import { pgToIso } from "../pytime";
import { cleanSessionId, reportedSessionId } from "../services/agent-ids";
import { markUsageLimit } from "../services/agent-limits";
import { addFollowup, noteSteer } from "../services/ask-followups";
import { cluster } from "../services/cluster";
import { deliverTask, type DeviceTaskRow } from "../services/device-dispatch";
import type { MachineRow } from "../services/device-merge";
import { recordOwner, setCachedDeviceQuotas, setDeviceCapabilities } from "../services/device-reports";
import { HEARTBEAT_WRITE_EVERY_MS } from "../services/device-service";
import { handleAgentToolUse, handleTaskFinished, handleWaitingQuestion } from "../services/task-alerts";
import { normalizeDeviceName } from "../services/user-filter";
import { seesAll } from "../services/visibility";
import { handleWorkspaceRelay } from "../services/workspace-relay";
import { wsManager } from "../services/ws-manager";

export const EXEC_ACTIONS = new Set(["shell", "agent"]);
export const MAX_OUTPUT_CHARS = 200_000;
export const MAX_TASK_EVENTS = 800;
export const LOST_TASK_MARGIN_SECONDS = 10;
export const LOST_TASK_ERROR =
  "设备上的 Memento 在任务运行中重启了（升级或退出），这个任务的进程和它断开了，结果回不来。会话本身还在：重新发送，或说“继续”接着做。";

const LIST_PAYLOAD_DROP = new Set(["system_prompt_append"]);
const LIST_PAYLOAD_CHARS = 500;
const FINISH_ATTEMPTS = ["full", "no_events", "reason_only"] as const;

const lastWsHeartbeat = new Map<string, number>();

type TaskFinishedHook = (deps: Deps, taskId: string, watched: boolean) => Promise<void>;
const taskFinishedHooks: TaskFinishedHook[] = [];
export function registerTaskFinishedHook(fn: TaskFinishedHook): void {
  taskFinishedHooks.push(fn);
}

type MindResonanceInjector = (db: Db, user: UserRow, query: string, project: string | null) => Promise<string>;
let mindResonanceInjector: MindResonanceInjector | null = null;
export function registerMindResonanceInjector(fn: MindResonanceInjector): void {
  mindResonanceInjector = fn;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function requireExecEnabled(settings: Settings, action: string): void {
  if (!EXEC_ACTIONS.has(action)) return;
  if (!settings.remoteExec) {
    throw new HttpError(403, "remote execution disabled (set MEMENTO_REMOTE_EXEC=1 to enable)");
  }
}

async function authorizeDevice(db: Db, settings: Settings, deviceId: string, user: UserRow): Promise<MachineRow | null> {
  const [machine] = await db
    .select()
    .from(machines)
    .where(or(eq(machines.collectorTokenHash, deviceId), eq(machines.name, deviceId)))
    .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`))
    .limit(1);

  if (!seesAll(user, settings)) {
    if (!machine || machine.userId !== user.id) throw new HttpError(404, "Device not found");
  }
  if (machine && machine.isArchived) throw new HttpError(400, "Device is unlinked/archived");
  return machine ?? null;
}

function listPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (LIST_PAYLOAD_DROP.has(k)) continue;
    out[k] = typeof v === "string" && v.length > LIST_PAYLOAD_CHARS ? `${v.slice(0, LIST_PAYLOAD_CHARS)}…` : v;
  }
  return out;
}

export function serializeTask(t: DeviceTaskRow, opts: { truncateOutput?: boolean; includeEvents?: boolean } = {}) {
  let stdout = t.stdout;
  let stderr = t.stderr;
  let payload: unknown = t.payload;
  if (opts.truncateOutput) {
    if (stdout && stdout.length > 2000) stdout = `${stdout.slice(0, 1000)}\n...[truncated]...\n${stdout.slice(-1000)}`;
    if (stderr && stderr.length > 2000) stderr = `${stderr.slice(0, 1000)}\n...[truncated]...\n${stderr.slice(-1000)}`;
    payload = listPayload(payload);
  }
  return {
    id: String(t.id),
    device_id: t.deviceId,
    action: t.action,
    payload,
    status: t.status,
    exit_code: t.exitCode,
    stdout,
    stderr,
    error: t.error,
    timeout_seconds: t.timeoutSeconds,
    created_at: pgToIso(t.createdAt),
    dispatched_at: pgToIso(t.dispatchedAt),
    finished_at: pgToIso(t.finishedAt),
    alerts: Array.isArray(t.alerts) ? t.alerts : [],
    events: opts.includeEvents === false ? [] : Array.isArray(t.events) ? t.events : [],
    session_id: t.sessionId,
  };
}

async function noteTaskSession(db: Db, taskId: string, sessionId: string): Promise<void> {
  if (!cleanSessionId(sessionId)) return;
  const tid = normalizeUuid(taskId);
  if (!tid) return;
  try {
    await db
      .update(deviceTasks)
      .set({ sessionId: sessionId.slice(0, 128) })
      .where(and(eq(deviceTasks.id, tid), isNull(deviceTasks.finishedAt)));
  } catch {
    /* ignore */
  }
}

export async function saveFinishedTask(db: Db, tidStr: string, data: Record<string, unknown>): Promise<boolean> {
  const tid = normalizeUuid(tidStr);
  if (!tid) return false;
  let lastErr: unknown = null;
  for (const attempt of FINISH_ATTEMPTS) {
    try {
      const [t] = await db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
      if (!t || t.status === "cancelled") return false;
      const patch: Partial<typeof deviceTasks.$inferInsert> = {
        exitCode: typeof data.exit_code === "number" ? data.exit_code : null,
        finishedAt: new Date().toISOString(),
      };
      if (attempt === "reason_only") {
        patch.status = "failed";
        const errName = lastErr instanceof Error ? lastErr.name : "Error";
        const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "");
        patch.error = `设备已执行完，但结果没能存进数据库（${errName}: ${errMsg.slice(0, 300)}）`;
      } else {
        const done: Record<string, unknown> = markUsageLimit({ ...data, action: t.action });
        patch.status = String(done.status || "succeeded");
        const rawOut = typeof data.stdout === "string" ? data.stdout.slice(0, MAX_OUTPUT_CHARS) : "";
        const rawErr = typeof data.stderr === "string" ? data.stderr.slice(0, MAX_OUTPUT_CHARS) : "";
        patch.stdout = rawOut || null;
        patch.stderr = rawErr || null;
        patch.error = done.error ? String(done.error) : null;
        const pl = t.payload && typeof t.payload === "object" ? (t.payload as Record<string, unknown>) : null;
        const runBinary = typeof pl?.binary === "string" ? pl.binary : null;
        patch.sessionId = cleanSessionId(data.session_id, runBinary) ?? reportedSessionId(typeof data.stderr === "string" ? data.stderr : null, runBinary);
        if (attempt === "full" && Array.isArray(data.events)) {
          patch.events = withoutNul(data.events.slice(-MAX_TASK_EVENTS));
        }
      }
      await db.update(deviceTasks).set(withoutNul(patch)).where(eq(deviceTasks.id, tid));
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  return false;
}

export async function settleLostTasks(deps: Deps, deviceId: string, data: Record<string, unknown>): Promise<string[]> {
  const uptimeMs = Number(data.uptime_ms);
  if (!Number.isFinite(uptimeMs)) return [];
  const uptime = uptimeMs / 1000;
  if (uptime < 0 || uptime >= 365 * 86400) return [];
  const sinceIso = new Date(Date.now() - (uptime + LOST_TASK_MARGIN_SECONDS) * 1000).toISOString();
  const keep = new Set(Array.isArray(data.task_ids) ? data.task_ids.filter(Boolean).map(String) : []);

  let rows: { id: string }[];
  try {
    rows = await deps.db
      .select({ id: deviceTasks.id })
      .from(deviceTasks)
      .where(
        and(
          eq(deviceTasks.deviceId, deviceId),
          eq(deviceTasks.status, "running"),
          sql`coalesce(${deviceTasks.dispatchedAt}, ${deviceTasks.createdAt}) < ${sinceIso}::timestamptz`,
        ),
      );
  } catch {
    return [];
  }

  const ended: string[] = [];
  for (const r of rows) {
    const tidStr = String(r.id);
    if (keep.has(tidStr)) continue;
    const result: Record<string, unknown> = {
      type: "task_finished",
      task_id: tidStr,
      status: "failed",
      exit_code: null,
      stdout: "",
      stderr: LOST_TASK_ERROR,
      error: LOST_TASK_ERROR,
    };
    const watched = await wsManager.isWatched(tidStr);
    wsManager.pushFinished(tidStr, result);
    if (await saveFinishedTask(deps.db, tidStr, result)) {
      for (const hook of taskFinishedHooks) void hook(deps, tidStr, watched).catch(() => {});
    }
    ended.push(tidStr);
  }
  return ended;
}

export async function authenticateDeviceWs(
  db: Db,
  settings: Settings,
  deviceId: string,
  collectorToken: string | null,
  remoteExecKey: string | null,
): Promise<MachineRow | null> {
  if (!collectorToken || !remoteExecKey) return null;
  const [user] = await db.select().from(users).where(eq(users.collectorToken, collectorToken)).limit(1);
  if (user && user.status !== "active") return null;
  if (!user) {
    if (!settings.collectorToken || !safeEqual(collectorToken, settings.collectorToken)) return null;
  }
  const baseDevId = normalizeDeviceName(deviceId);
  const list = await db
    .select()
    .from(machines)
    .where(
      or(
        eq(machines.collectorTokenHash, deviceId),
        eq(machines.name, deviceId),
        eq(machines.name, baseDevId),
        like(machines.name, `${baseDevId}%`),
      ),
    )
    .orderBy(desc(sql`coalesce(${machines.lastHeartbeat}, '1970-01-01'::timestamptz)`));
  for (const m of list) {
    if (m.remoteExecKey && safeEqual(m.remoteExecKey, remoteExecKey)) return m;
  }
  return null;
}

const FILE_RESP_TYPES = new Set([
  "file_stat_resp",
  "file_chunk_resp",
  "p2p_answer",
  "workspace_resp",
  "agent_login_resp",
  "git_resp",
  "term_open_resp",
  "preview_resp",
]);

export async function handleDeviceWsConnection(
  ws: WebSocket,
  deviceId: string,
  reqUrl: string,
  headers: IncomingMessage["headers"],
  deps: Deps,
): Promise<void> {
  const parsed = new URL(reqUrl, "http://localhost");
  const collectorToken = parsed.searchParams.get("token") || (typeof headers["x-collector-token"] === "string" ? headers["x-collector-token"] : null);
  const execKey = parsed.searchParams.get("key") || (typeof headers["x-remote-exec-key"] === "string" ? headers["x-remote-exec-key"] : null);

  const machine = await authenticateDeviceWs(deps.db, deps.settings, deviceId, collectorToken, execKey).catch(() => null);
  if (!machine) {
    ws.close(4003, "unauthorized");
    return;
  }

  const realDeviceId = machine.collectorTokenHash;
  const aliases = [realDeviceId, deviceId, machine.name, machine.name ? normalizeDeviceName(machine.name) : null, String(machine.id)];
  await wsManager.register(realDeviceId, ws, ...aliases);
  recordOwner(aliases, machine.userId ? String(machine.userId) : null);
  await wsManager.sendKeptCancels(...aliases);

  try {
    await deps.db.update(machines).set({ lastHeartbeat: new Date().toISOString() }).where(eq(machines.id, machine.id));
    lastWsHeartbeat.set(machine.id, performance.now());
  } catch {
    /* ignore */
  }

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "connected", device_id: realDeviceId, device_name: machine.name }));
  }

  ws.on("message", (raw) => {
    void (async () => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      const msgType = String(data.type ?? "");
      if (msgType === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" }));
        const nowMono = performance.now();
        if (nowMono - (lastWsHeartbeat.get(machine.id) ?? 0) >= HEARTBEAT_WRITE_EVERY_MS) {
          lastWsHeartbeat.set(machine.id, nowMono);
          const nowIso = new Date().toISOString();
          const cutoffIso = new Date(Date.now() - HEARTBEAT_WRITE_EVERY_MS).toISOString();
          await deps.db
            .update(machines)
            .set({ lastHeartbeat: nowIso })
            .where(and(eq(machines.id, machine.id), or(isNull(machines.lastHeartbeat), lt(machines.lastHeartbeat, cutoffIso))))
            .catch(() => {});
        }
      } else if (msgType === "agent_capabilities") {
        const caps = data.capabilities && typeof data.capabilities === "object" ? (data.capabilities as Record<string, unknown>) : {};
        setDeviceCapabilities([realDeviceId, machine.name, String(machine.id)], caps);
      } else if (msgType === "agent_quotas") {
        const quotas = data.quotas && typeof data.quotas === "object" ? (data.quotas as Record<string, unknown>) : {};
        setCachedDeviceQuotas(realDeviceId, quotas, machine.name, String(machine.id));
      } else if (msgType === "task_progress") {
        const tid = data.task_id ? String(data.task_id) : "";
        if (tid) wsManager.pushProgress(tid, String(data.status || "running"));
      } else if (msgType === "task_chunk") {
        const tid = data.task_id ? String(data.task_id) : "";
        if (tid) {
          wsManager.pushChunk(
            tid,
            String(data.stream || "stdout"),
            String(data.text ?? ""),
            typeof data.seq === "number" ? data.seq : null,
          );
        }
      } else if (msgType === "agent_event") {
        const tid = data.task_id ? String(data.task_id) : "";
        if (tid && data.event && typeof data.event === "object") {
          const ev = data.event as Record<string, unknown>;
          wsManager.pushEvent(tid, ev);
          if (ev.kind === "question" && (ev.status === undefined || ev.status === null || ev.status === "waiting")) {
            cluster.spawn(() => handleWaitingQuestion(deps, machine.userId, tid, ev));
          }
          if (ev.kind === "steer") cluster.spawn(() => noteSteer(deps.db, tid, ev));
          if (ev.kind === "session" && ev.session_id) cluster.spawn(() => noteTaskSession(deps.db, tid, String(ev.session_id)));
        }
      } else if (msgType === "agent_tool_use") {
        cluster.spawn(() => handleAgentToolUse(deps, machine.id, machine.name, data));
      } else if (msgType === "ws_relay") {
        cluster.spawn(() => handleWorkspaceRelay(deps, data, realDeviceId, machine.userId));
      } else if (msgType === "term_exit") {
        const tid = String(data.term_id ?? "");
        if (tid.startsWith("term-")) wsManager.pushEvent(tid, { kind: "term_exit", exit_code: data.exit_code ?? null });
      } else if (FILE_RESP_TYPES.has(msgType)) {
        wsManager.handleFileResponse(data);
      } else if (msgType === "running_tasks") {
        cluster.spawn(async () => {
          await settleLostTasks(deps, realDeviceId, data);
        });
      } else if (msgType === "task_finished") {
        const tidStr = data.task_id ? String(data.task_id) : "";
        if (tidStr) {
          if (tidStr.startsWith("gitrpc-")) {
            wsManager.pushFinished(tidStr, data);
          } else {
            const watched = await wsManager.isWatched(tidStr);
            wsManager.pushFinished(tidStr, data);
            const saved = await saveFinishedTask(deps.db, tidStr, data);
            if (saved) {
              for (const hook of taskFinishedHooks) cluster.spawn(() => hook(deps, tidStr, watched));
            }
            cluster.spawn(() => handleTaskFinished(deps, tidStr, typeof data.status === "string" ? data.status : null, machine.name, watched));
          }
        }
      }
    })();
  });

  const cleanup = () => {
    lastWsHeartbeat.delete(machine.id);
    if (lastWsHeartbeat.size > 2000) {
      const cutoff = performance.now() - 600_000;
      for (const [k, ts] of [...lastWsHeartbeat.entries()]) if (ts < cutoff) lastWsHeartbeat.delete(k);
    }
    void wsManager.unregister(realDeviceId, ws);
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/** Attach the /api/tasks/ws/:device_id WebSocket upgrade handler onto a Node HTTP server. */
export function attachDeviceWebSocket(server: HttpServer, deps: Deps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url || "/";
    const pathname = new URL(rawUrl, "http://localhost").pathname;
    if (pathname === "/api/relay/connect") {
      // Handled by attachRelayWebSocket
      return;
    }
    const m = /^\/api\/tasks\/ws\/(.+)$/.exec(pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    let deviceId: string;
    try {
      deviceId = decodeURIComponent(m[1]!);
    } catch {
      deviceId = m[1]!;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void handleDeviceWsConnection(ws, deviceId, rawUrl, req.headers, deps);
    });
  });
  return wss;
}

// ---------------------------------------------------------------------------
// HTTP routes (/api/tasks)
// ---------------------------------------------------------------------------
export const taskRoutes = new Hono<AppEnv>();

taskRoutes.post("/dispatch/:device_id", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const deviceId = c.req.param("device_id");
  const body = await parseJsonObject(c);
  const action = typeof body.action === "string" ? body.action : "";
  if (!action) throw new HttpError(422, [{ type: "missing", loc: ["body", "action"], msg: "Field required", input: body }]);
  if (!EXEC_ACTIONS.has(action)) throw new HttpError(400, `unknown action: ${action}`);

  const timeoutRaw = body.timeout_seconds === undefined ? 7200 : Number(body.timeout_seconds);
  if (!Number.isInteger(timeoutRaw) || timeoutRaw < 0 || timeoutRaw > 86400) {
    throw new HttpError(422, [{ type: "int_parsing", loc: ["body", "timeout_seconds"], msg: "timeout_seconds must be 0..86400", input: body.timeout_seconds }]);
  }

  requireExecEnabled(settings, action);
  const machine = await authorizeDevice(db, settings, deviceId, user);
  const targetDeviceId = machine ? machine.collectorTokenHash : deviceId;

  const taskPayload: Record<string, unknown> =
    body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? { ...(body.payload as Record<string, unknown>) } : {};

  if (action === "agent" && mindResonanceInjector) {
    try {
      const subProj = String(taskPayload.project_id ?? taskPayload.cwd ?? "");
      const subQuery = String(taskPayload.user_question ?? taskPayload.prompt ?? "");
      const mindMd = (await mindResonanceInjector(db, user, subQuery, subProj || null)).trim();
      if (mindMd) {
        const curAppend = String(taskPayload.system_prompt_append ?? "").trim();
        taskPayload.system_prompt_append = curAppend ? `${curAppend}\n\n${mindMd}` : mindMd;
      }
    } catch {
      /* optional enrichment */
    }
  }

  const [inserted] = await db
    .insert(deviceTasks)
    .values({
      id: randomUUID(),
      deviceId: targetDeviceId,
      machineId: machine ? machine.id : null,
      userId: user.id,
      action,
      payload: withoutNul(taskPayload),
      timeoutSeconds: timeoutRaw,
      status: "queued",
    })
    .returning();

  const { task } = await deliverTask(db, inserted!, machine);
  const preview = String(taskPayload.command ?? taskPayload.prompt ?? taskPayload.user_question ?? "");
  await recordAudit(db, user, "device_task.dispatch", auditRequest(c), {
    targetUserId: machine?.userId ?? undefined,
    detail: {
      task_id: String(task.id),
      task_action: action,
      device: machine ? machine.name : deviceId,
      other_users_device: Boolean(machine && machine.userId !== user.id),
      preview: preview.slice(0, 300),
    },
  });
  return c.json(serializeTask(task));
});

taskRoutes.get("", async (c) => {
  const user = await currentUser(c);
  const { db, settings } = c.var.deps;
  const deviceId = c.req.query("device_id");
  const status = c.req.query("status");
  const limit = Math.min(queryInt(c, "limit", 50), 200);

  const conds = [];
  if (!seesAll(user, settings)) conds.push(eq(deviceTasks.userId, user.id));
  if (deviceId) conds.push(eq(deviceTasks.deviceId, deviceId));
  if (status) conds.push(eq(deviceTasks.status, status));

  const rows = await db
    .select({
      id: deviceTasks.id,
      deviceId: deviceTasks.deviceId,
      machineId: deviceTasks.machineId,
      userId: deviceTasks.userId,
      action: deviceTasks.action,
      payload: deviceTasks.payload,
      status: deviceTasks.status,
      exitCode: deviceTasks.exitCode,
      stdout: deviceTasks.stdout,
      stderr: deviceTasks.stderr,
      error: deviceTasks.error,
      alerts: deviceTasks.alerts,
      sessionId: deviceTasks.sessionId,
      timeoutSeconds: deviceTasks.timeoutSeconds,
      createdAt: deviceTasks.createdAt,
      dispatchedAt: deviceTasks.dispatchedAt,
      finishedAt: deviceTasks.finishedAt,
    })
    .from(deviceTasks)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(deviceTasks.createdAt))
    .limit(limit);

  return c.json(rows.map((r) => serializeTask({ ...r, events: [] }, { truncateOutput: true, includeEvents: false })));
});

taskRoutes.get("/:task_id", async (c) => {
  const user = await currentUser(c);
  const tid = pathUuid(c, "task_id");
  const [task] = await c.var.deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!task || (!seesAll(user, c.var.deps.settings) && task.userId !== user.id)) {
    throw new HttpError(404, "Not Found");
  }
  return c.json(serializeTask(task));
});

taskRoutes.post("/:task_id/cancel", async (c) => {
  const user = await currentUser(c);
  const rawId = c.req.param("task_id");
  const tid = normalizeUuid(rawId);
  if (!tid) throw new HttpError(400, `invalid task id format: ${rawId}`);

  const [task] = await c.var.deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!task || (!seesAll(user, c.var.deps.settings) && task.userId !== user.id)) {
    throw new HttpError(404, "Not Found");
  }
  if (["succeeded", "failed", "timeout", "cancelled"].includes(task.status)) {
    return c.json(serializeTask(task));
  }
  await wsManager.sendCancel(task.deviceId, String(task.id));
  const [updated] = await c.var.deps.db
    .update(deviceTasks)
    .set({ status: "cancelled", finishedAt: new Date().toISOString() })
    .where(eq(deviceTasks.id, tid))
    .returning();
  return c.json(serializeTask(updated ?? task));
});

taskRoutes.post("/:task_id/input", async (c) => {
  const user = await currentUser(c);
  const rawId = c.req.param("task_id");
  const body = await parseJsonObject(c);
  if (typeof body.input !== "string") {
    throw new HttpError(422, [{ type: "string_type", loc: ["body", "input"], msg: "Input should be a valid string", input: body.input }]);
  }
  const inputText = body.input;
  const questionId = typeof body.question_id === "string" && body.question_id ? body.question_id : null;

  const tid = normalizeUuid(rawId);
  if (!tid) return c.json({ ok: false, reason: `invalid task id format: ${rawId}` });

  const [task] = await c.var.deps.db.select().from(deviceTasks).where(eq(deviceTasks.id, tid)).limit(1);
  if (!task || (!seesAll(user, c.var.deps.settings) && task.userId !== user.id)) {
    throw new HttpError(404, "Not Found");
  }
  const pl = (task.payload && typeof task.payload === "object" ? task.payload : {}) as Record<string, unknown>;
  const convId = String(pl.conversation_id ?? "").trim();
  if (task.status !== "queued" && task.status !== "running") {
    const queued = Boolean(convId && !questionId && (await addFollowup(task.userId ?? user.id, convId, inputText)));
    return c.json({ ok: false, queued, reason: `task status is ${task.status}, not running` });
  }
  const sent = await wsManager.sendInput(task.deviceId, String(task.id), inputText, questionId);
  if (!sent && convId && !questionId) {
    return c.json({ ok: false, queued: await addFollowup(task.userId ?? user.id, convId, inputText) });
  }
  return c.json({ ok: sent });
});
