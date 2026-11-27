// Background Ask runs, SSE replay, cross-replica Redis Stream mirror & rolling handover
// (server/server/services/ask_runs.py).
// Uses the exact same Redis keys/channels ("memento:cl:askrun-*") as Python so mixed replicas interoperate.
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { UserRow } from "../auth/current-user";
import type { Deps } from "../context";
import { deviceTasks, users } from "../db/pulled/schema";
import { normalizeUuid } from "../http";
import { peekFollowups, popFollowups } from "./ask-followups";
import { recordStoppedOrphans } from "./ask-store";
import { cluster, PREFIX } from "./cluster";
import { notifyUser, pushLiveActivityEvent } from "./notify";
import { publishEvent } from "./sse";
import { wsManager } from "./ws-manager";

export class RunConflict extends Error {
  constructor(msg = "run already active") {
    super(msg);
    this.name = "RunConflict";
  }
}

const MAX_FRAMES = 4000;
const RETENTION_MS = 10 * 60 * 1000;
const MIRROR_TTL_S = 1800;
const HANDOVER_TTL_S = 300;
const IDLE_HEARTBEAT_MS = 15_000;

const K_CUR = `${PREFIX}askrun-cur:`;
const K_META = `${PREFIX}askrun-meta:`;
const K_FRAMES = `${PREFIX}askrun-frames:`;
const K_USER = `${PREFIX}askrun-user:`;
const K_REQ = `${PREFIX}askrun-req:`;
const K_HANDOVER = `${PREFIX}askrun-handover:`;
const K_HANDOVERS = `${PREFIX}askrun-handovers`;
const CH_HANDOVER = `${PREFIX}askrun-handover`;

const ACTIVE_TASK_STATUSES = ["queued", "running", "still_running", "pending", "dispatched"];

export type RunStreamFactory = (deps: Deps, user: UserRow, signal: AbortSignal) => AsyncGenerator<string, void, void>;
export type RunResumer = (kwargs: Record<string, unknown>, checkpoint: Record<string, unknown>) => RunStreamFactory;

export interface RunSummary {
  run_id: string;
  conversation_id: string;
  user_id: string;
  request_id: string | null;
  status: string;
  question: string;
  title: string | null;
  execution_mode: string | null;
  model: string | null;
  device_name: string | null;
  images: string[];
  started_at: number;
  finished_at: number | null;
  frame_count: number;
  error: string | null;
  pod_id?: string;
}

interface Waiter {
  resolve: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

function nowSec(): number {
  return Date.now() / 1000;
}

function parseSseData(frame: string): Record<string, unknown> | null {
  const m = /^data:\s*(.+)$/m.exec(frame);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]!.trim());
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class AskRun {
  readonly runId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string | null;
  readonly question: string;
  readonly title: string | null;
  readonly executionMode: string | null;
  readonly model: string | null;
  readonly deviceName: string | null;
  readonly images: string[];
  readonly startedAt: number;
  finishedAt: number | null = null;
  status: "running" | "done" | "error" | "cancelled" | "handed_over" = "running";
  error: string | null = null;
  readonly frames: string[] = [];
  readonly abortController = new AbortController();
  checkpoint: Record<string, unknown> = {};
  resumeSpec: { kind: string; kwargs: Record<string, unknown>; checkpoint?: Record<string, unknown> } | null = null;
  private waiters = new Set<Waiter>();
  private donePromise: Promise<void> = Promise.resolve();
  private lastIslandPushMs = 0;
  private stepCount = 1;
  private lastToolName: string | null = null;
  private doneResolve!: () => void;

  constructor(
    private readonly deps: Deps,
    private readonly registry: AskRunRegistry,
    opts: {
      runId?: string;
      conversationId: string;
      userId: string;
      requestId?: string | null;
      question: string;
      title?: string | null;
      executionMode?: string | null;
      model?: string | null;
      deviceName?: string | null;
      images?: string[];
      resume?: { kind: string; kwargs: Record<string, unknown>; checkpoint?: Record<string, unknown> } | null;
    },
  ) {
    this.runId = opts.runId || randomUUID().replaceAll("-", "");
    this.conversationId = opts.conversationId;
    this.userId = opts.userId;
    this.requestId = opts.requestId ?? null;
    this.question = opts.question;
    this.title = opts.title ?? null;
    this.executionMode = opts.executionMode ?? null;
    this.model = opts.model ?? null;
    this.deviceName = opts.deviceName ?? null;
    this.images = opts.images ?? [];
    this.startedAt = nowSec();
    this.resumeSpec = opts.resume ?? null;
    if (opts.resume?.checkpoint) this.checkpoint = { ...opts.resume.checkpoint };
    this.donePromise = new Promise((res) => {
      this.doneResolve = res;
    });
  }

  get done(): boolean {
    return this.status !== "running";
  }

  summary(): RunSummary {
    return {
      run_id: this.runId,
      conversation_id: this.conversationId,
      user_id: this.userId,
      request_id: this.requestId,
      status: this.status,
      question: this.question.slice(0, 300),
      title: this.title,
      execution_mode: this.executionMode,
      model: this.model,
      device_name: this.deviceName,
      images: this.images,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      frame_count: this.frames.length,
      error: this.error,
      pod_id: cluster.podId,
    };
  }

  private notifyWaiters(): void {
    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer);
      w.resolve();
    }
    this.waiters.clear();
  }

  private waitForUpdate(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const w: Waiter = {
        resolve: () => {
          this.waiters.delete(w);
          resolve();
        },
      };
      w.timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve();
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  private pushFrame(frame: string): void {
    const idx = this.frames.length;
    if (this.frames.length < MAX_FRAMES) {
      this.frames.push(frame);
    } else {
      this.frames[this.frames.length - 1] = frame;
    }
    this.mirrorFrame(idx, frame);
    this.inspectFrame(frame);
    this.notifyWaiters();
  }

  private inspectFrame(frame: string): void {
    const ev = parseSseData(frame);
    if (!ev) return;
    const t = String(ev.type ?? "");
    if (t === "checkpoint" && ev.data && typeof ev.data === "object") {
      this.checkpoint = { ...this.checkpoint, ...(ev.data as Record<string, unknown>) };
      return;
    }
    if (t === "task_started" || t === "device_task") {
      if (typeof ev.task_id === "string") this.checkpoint.task_id = ev.task_id;
      if (typeof ev.session_id === "string") this.checkpoint.session_id = ev.session_id;
    }
    if (t === "tool_start" || t === "tool_call" || t === "step") {
      this.stepCount++;
      this.lastToolName = String(ev.tool || ev.name || this.lastToolName || "");
      const nowMs = Date.now();
      if (nowMs - this.lastIslandPushMs >= 5000) {
        this.lastIslandPushMs = nowMs;
        void pushLiveActivityEvent(this.deps, this.userId, this.conversationId, "update", {
          status: "running",
          currentStep: String(ev.summary || ev.tool || ev.name || "正在执行步骤"),
          stepCount: this.stepCount,
          toolName: this.lastToolName || null,
          elapsedSeconds: Math.max(0, Math.round(nowSec() - this.startedAt)),
          title: this.title || this.question.slice(0, 40),
          engine: this.executionMode || "AI",
          deviceName: this.deviceName || "云端",
          startedAtEpoch: this.startedAt,
        });
      }
    }
  }

  private mirrorMeta(): void {
    const metaJson = JSON.stringify(this.summary());
    cluster.write(async (r) => {
      const pipe = r.pipeline();
      pipe.set(K_META + this.runId, metaJson, "EX", MIRROR_TTL_S);
      if (this.status === "running") {
        pipe.set(K_CUR + this.conversationId, this.runId, "EX", MIRROR_TTL_S);
        pipe.sadd(K_USER + this.userId, this.runId);
        pipe.expire(K_USER + this.userId, MIRROR_TTL_S);
        if (this.requestId) pipe.set(K_REQ + this.requestId, this.runId, "EX", MIRROR_TTL_S);
      } else {
        pipe.srem(K_USER + this.userId, this.runId);
      }
      await pipe.exec();
    });
  }

  private mirrorFrame(idx: number, frame: string): void {
    cluster.write(async (r) => {
      const pipe = r.pipeline();
      pipe.xadd(K_FRAMES + this.runId, "MAXLEN", "~", String(MAX_FRAMES), `0-${idx + 1}`, "f", frame);
      pipe.expire(K_FRAMES + this.runId, MIRROR_TTL_S);
      await pipe.exec();
    });
  }

  private mirrorEnd(): void {
    this.mirrorMeta();
    cluster.write(async (r) => {
      const pipe = r.pipeline();
      pipe.xadd(K_FRAMES + this.runId, "*", "end", this.status);
      pipe.expire(K_FRAMES + this.runId, MIRROR_TTL_S);
      await pipe.exec();
    });
  }

  start(factory: RunStreamFactory, user: UserRow): void {
    this.mirrorMeta();
    publishEvent("ask_run_started", this.summary() as unknown as Record<string, unknown>, this.userId);
    void pushLiveActivityEvent(this.deps, this.userId, this.conversationId, "start", {
      status: "running",
      currentStep: this.question.slice(0, 60) || "开始执行任务",
      stepCount: 1,
      elapsedSeconds: 0,
      title: this.title || this.question.slice(0, 40),
      engine: this.executionMode || "AI",
      deviceName: this.deviceName || "云端",
      startedAtEpoch: this.startedAt,
    });

    void (async () => {
      try {
        for await (const frame of factory(this.deps, user, this.abortController.signal)) {
          if (this.abortController.signal.aborted && this.status === "handed_over") break;
          this.pushFrame(frame);
        }
        if (this.status === "running") {
          this.status = this.abortController.signal.aborted ? "cancelled" : "done";
        }
      } catch (e) {
        if (this.status === "running") {
          if (this.abortController.signal.aborted) {
            this.status = "cancelled";
          } else {
            this.status = "error";
            this.error = e instanceof Error ? e.message : String(e);
            this.pushFrame(`data: ${JSON.stringify({ type: "error", message: this.error })}\n\n`);
          }
        }
      } finally {
        this.finishedAt = nowSec();
        if (this.status !== "handed_over") {
          this.mirrorEnd();
          publishEvent("ask_run_finished", this.summary() as unknown as Record<string, unknown>, this.userId);
          // R-ISLAND-CLEANUP: always end Live Activity when run finishes/errors/cancels
          const laStatus = this.status === "done" ? "done" : this.status === "cancelled" ? "cancelled" : "error";
          const laStep = this.status === "done" ? "已完成" : this.status === "cancelled" ? "已停止" : "执行异常";
          void pushLiveActivityEvent(this.deps, this.userId, this.conversationId, "end", {
            status: laStatus,
            currentStep: laStep,
            stepCount: this.stepCount,
            toolName: this.lastToolName,
            elapsedSeconds: Math.max(0, Math.round(this.finishedAt - this.startedAt)),
            title: this.title || this.question.slice(0, 40),
            engine: this.executionMode || "AI",
            deviceName: this.deviceName || "云端",
            startedAtEpoch: this.startedAt,
          });
          if (this.status === "done" && this.finishedAt - this.startedAt >= 20) {
            void notifyUser(
              this.deps,
              this.userId,
              "task_done",
              `${this.executionMode || "AI"} 回复完成`,
              `${this.title || this.question.slice(0, 40)}`,
              { url: `/ask?conversation=${this.conversationId}` },
            );
          }
          // Process any queued followups automatically when done
          if (this.status === "done") {
            void this.registry.drainFollowupsIfAny(this.conversationId, this.userId);
          } else if (this.status === "cancelled") {
            void popFollowups(this.userId, this.conversationId);
          }
        }
        this.notifyWaiters();
        this.doneResolve();
        this.registry.schedulePrune(this.runId);
      }
    })();
  }

  async cancel(reason = "任务已被用户停止"): Promise<boolean> {
    if (this.done) return false;
    this.status = "cancelled";
    this.error = reason;
    this.abortController.abort();
    await this.registry.cancelConversationDeviceTasks(this.conversationId, this.userId);
    this.pushFrame(`data: ${JSON.stringify({ type: "cancelled", message: reason })}\n\n`);
    this.notifyWaiters();
    return true;
  }

  async waitDone(timeoutMs = 5000): Promise<void> {
    await Promise.race([this.donePromise, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
  }

  async *stream(fromIndex = 0, signal?: AbortSignal): AsyncGenerator<string, void, void> {
    let idx = Math.max(0, fromIndex);
    while (true) {
      if (signal?.aborted) return;
      while (idx < this.frames.length) {
        yield this.frames[idx]!;
        idx++;
      }
      if (this.done) return;
      const before = this.frames.length;
      await this.waitForUpdate(IDLE_HEARTBEAT_MS);
      if (signal?.aborted) return;
      if (this.frames.length === before && !this.done) {
        yield ": heartbeat\n\n";
      }
    }
  }
}

export class RemoteRun {
  constructor(
    private readonly summaryData: RunSummary,
  ) {}

  get runId(): string {
    return this.summaryData.run_id;
  }
  get conversationId(): string {
    return this.summaryData.conversation_id;
  }
  get userId(): string {
    return this.summaryData.user_id;
  }
  get done(): boolean {
    return this.summaryData.status !== "running";
  }

  summary(): RunSummary {
    return { ...this.summaryData };
  }

  async *stream(fromIndex = 0, signal?: AbortSignal): AsyncGenerator<string, void, void> {
    const r = cluster.redis;
    if (!r) return;
    let lastId = fromIndex > 0 ? `0-${fromIndex}` : "0-0";
    let idleLoops = 0;
    while (!signal?.aborted) {
      try {
        const res = (await r.xread("COUNT", 100, "BLOCK", 5000, "STREAMS", K_FRAMES + this.runId, lastId)) as
          | [string, [string, string[]][]][]
          | null;
        if (!res || !res.length) {
          idleLoops++;
          const metaRaw = await r.get(K_META + this.runId);
          if (metaRaw) {
            try {
              const m = JSON.parse(metaRaw) as RunSummary;
              if (m.status !== "running") return;
            } catch {
              /* ignore */
            }
          } else if (idleLoops >= 3) {
            return;
          }
          yield ": heartbeat\n\n";
          continue;
        }
        idleLoops = 0;
        for (const [, entries] of res) {
          for (const [id, kv] of entries) {
            lastId = id;
            for (let i = 0; i < kv.length; i += 2) {
              const field = kv[i];
              const val = kv[i + 1];
              if (field === "f" && val) yield val;
              if (field === "end") return;
            }
          }
        }
      } catch {
        return;
      }
    }
  }
}

export class AskRunRegistry {
  private readonly byId = new Map<string, AskRun>();
  private readonly byConv = new Map<string, AskRun>();
  private readonly byReq = new Map<string, AskRun>();
  readonly resumers: Record<string, RunResumer> = {};
  private depsRef: Deps | null = null;
  private clusterWired = false;
  private followupRunner: ((deps: Deps, convId: string, userId: string, text: string) => Promise<void>) | null = null;

  bindDeps(deps: Deps): void {
    this.depsRef = deps;
    if (this.clusterWired) return;
    this.clusterWired = true;
    cluster.op("askrun.cancel", async (payload) => {
      const runId = String(payload.run_id ?? "");
      const convId = String(payload.conversation_id ?? "");
      const run = (runId && this.byId.get(runId)) || (convId && this.byConv.get(convId)) || null;
      if (run && !run.done) {
        await run.cancel();
        return { cancelled: true, run_id: run.runId };
      }
      return { cancelled: false };
    });
    cluster.on(CH_HANDOVER, async (_ch, msg) => {
      if (msg.origin === cluster.podId) return;
      const runId = String(msg.run_id ?? "");
      if (runId) await this.tryAdopt(runId);
    });
    cluster.onStart(async () => {
      await this.adoptPendingHandovers();
    });
  }

  registerFollowupRunner(fn: (deps: Deps, convId: string, userId: string, text: string) => Promise<void>): void {
    this.followupRunner = fn;
  }

  async drainFollowupsIfAny(convId: string, userId: string): Promise<void> {
    if (!this.depsRef || !this.followupRunner) return;
    const queued = await peekFollowups(userId, convId);
    if (!queued.length) return;
    const popped = await popFollowups(userId, convId);
    const merged = popped.map((q) => String(q.text ?? "").trim()).filter(Boolean).join("\n\n");
    if (!merged) return;
    try {
      await this.followupRunner(this.depsRef, convId, userId, merged);
    } catch {
      /* ignore */
    }
  }

  schedulePrune(runId: string): void {
    const t = setTimeout(() => {
      const run = this.byId.get(runId);
      if (!run || !run.done) return;
      this.byId.delete(runId);
      if (this.byConv.get(run.conversationId) === run) this.byConv.delete(run.conversationId);
      if (run.requestId && this.byReq.get(run.requestId) === run) this.byReq.delete(run.requestId);
    }, RETENTION_MS);
    t.unref?.();
  }

  async start(
    deps: Deps,
    convId: string,
    user: UserRow,
    question: string,
    factory: RunStreamFactory,
    opts: {
      requestId?: string | null;
      executionMode?: string | null;
      model?: string | null;
      deviceName?: string | null;
      title?: string | null;
      images?: string[];
      resume?: { kind: string; kwargs: Record<string, unknown>; checkpoint?: Record<string, unknown> } | null;
    } = {},
  ): Promise<AskRun> {
    this.bindDeps(deps);
    if (opts.requestId) {
      const existingReq = this.byReq.get(opts.requestId);
      if (existingReq && existingReq.userId === user.id) return existingReq;
    }
    const existing = this.byConv.get(convId);
    if (existing && !existing.done) throw new RunConflict();

    // Check cross-replica active run
    if (cluster.available && cluster.redis) {
      try {
        const curId = await cluster.redis.get(K_CUR + convId);
        if (curId && !this.byId.has(curId)) {
          const metaRaw = await cluster.redis.get(K_META + curId);
          if (metaRaw) {
            const meta = JSON.parse(metaRaw) as RunSummary;
            if (meta.status === "running" && meta.pod_id && (await cluster.alive(meta.pod_id, 800))) {
              throw new RunConflict();
            }
          }
        }
      } catch (e) {
        if (e instanceof RunConflict) throw e;
      }
    }

    const run = new AskRun(deps, this, {
      conversationId: convId,
      userId: user.id,
      requestId: opts.requestId,
      question,
      title: opts.title,
      executionMode: opts.executionMode,
      model: opts.model,
      deviceName: opts.deviceName,
      images: opts.images,
      resume: opts.resume,
    });
    this.byId.set(run.runId, run);
    this.byConv.set(convId, run);
    if (run.requestId) this.byReq.set(run.requestId, run);
    run.start(factory, user);
    return run;
  }

  getLocal(runId: string): AskRun | null {
    return this.byId.get(runId) ?? null;
  }

  getLocalForConv(convId: string): AskRun | null {
    return this.byConv.get(convId) ?? null;
  }

  async get(runId: string): Promise<AskRun | RemoteRun | null> {
    const local = this.byId.get(runId);
    if (local) return local;
    const r = cluster.redis;
    if (!r) return null;
    try {
      const raw = await r.get(K_META + runId);
      if (!raw) return null;
      return new RemoteRun(JSON.parse(raw) as RunSummary);
    } catch {
      return null;
    }
  }

  async getForConversation(convId: string): Promise<AskRun | RemoteRun | null> {
    const local = this.byConv.get(convId);
    if (local && !local.done) return local;
    const r = cluster.redis;
    if (r) {
      try {
        const curId = await r.get(K_CUR + convId);
        if (curId && curId !== local?.runId) {
          const remote = await this.get(curId);
          if (remote) return remote;
        }
      } catch {
        /* ignore */
      }
    }
    return local ?? null;
  }

  async listForUser(userId: string, onlyActive = false): Promise<RunSummary[]> {
    const map = new Map<string, RunSummary>();
    for (const run of this.byId.values()) {
      if (run.userId !== userId) continue;
      if (onlyActive && run.done) continue;
      map.set(run.runId, run.summary());
    }
    const r = cluster.redis;
    if (r) {
      try {
        const ids = await r.smembers(K_USER + userId);
        if (ids.length) {
          const metas = await r.mget(...ids.map((id) => K_META + id));
          for (let i = 0; i < ids.length; i++) {
            const raw = metas[i];
            if (!raw) continue;
            try {
              const s = JSON.parse(raw) as RunSummary;
              if (onlyActive && s.status !== "running") continue;
              if (!map.has(s.run_id)) map.set(s.run_id, s);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    }
    return [...map.values()].sort((a, b) => b.started_at - a.started_at);
  }

  /** R-STOP-ALL-AGENTS: cancel both local/remote AskRun and any underlying DeviceTask for this conversation. */
  async cancelConversationDeviceTasks(convId: string, userId: string): Promise<string[]> {
    if (!this.depsRef) return [];
    const { db } = this.depsRef;
    const activeRows = await db
      .select()
      .from(deviceTasks)
      .where(
        and(
          eq(deviceTasks.userId, userId),
          sql`${deviceTasks.payload}->>'conversation_id' = ${convId}`,
          inArray(deviceTasks.status, ACTIVE_TASK_STATUSES),
        ),
      )
      .orderBy(desc(deviceTasks.createdAt))
      .limit(10);

    const cancelledIds: string[] = [];
    const nowIso = new Date().toISOString();
    for (const task of activeRows) {
      await db
        .update(deviceTasks)
        .set({ status: "cancelled", error: "Cancelled by user", finishedAt: nowIso })
        .where(eq(deviceTasks.id, task.id));
      cancelledIds.push(task.id);
      const sent = await wsManager.sendCancel(task.deviceId, task.id);
      if (!sent) wsManager.cancelWhenBack(task.deviceId, task.id);
    }
    if (cancelledIds.length) {
      await recordStoppedOrphans(db, convId, cancelledIds).catch(() => {});
    }
    return cancelledIds;
  }

  async cancel(runIdOrConvId: string, userId: string): Promise<{ cancelled: boolean; run_id?: string; cancelled_tasks: string[] }> {
    const local = this.byId.get(runIdOrConvId) ?? this.byConv.get(runIdOrConvId) ?? null;
    if (local && local.userId === userId && !local.done) {
      await local.cancel();
      return { cancelled: true, run_id: local.runId, cancelled_tasks: [] };
    }

    // Try remote replica cancel
    let remoteCancelled = false;
    let resolvedConvId = normalizeUuid(runIdOrConvId) ? runIdOrConvId : null;
    let resolvedRunId: string | undefined;
    const r = cluster.redis;
    if (r) {
      try {
        let rid = runIdOrConvId;
        if (resolvedConvId) {
          const cur = await r.get(K_CUR + resolvedConvId);
          if (cur) rid = cur;
        }
        const raw = await r.get(K_META + rid);
        if (raw) {
          const meta = JSON.parse(raw) as RunSummary;
          if (meta.user_id === userId) {
            resolvedConvId = meta.conversation_id;
            resolvedRunId = meta.run_id;
            if (meta.status === "running" && meta.pod_id && meta.pod_id !== cluster.podId) {
              try {
                const res = (await cluster.call(meta.pod_id, "askrun.cancel", { run_id: meta.run_id, conversation_id: meta.conversation_id }, 3000)) as { cancelled?: boolean };
                remoteCancelled = Boolean(res?.cancelled);
              } catch {
                // Pod dead: mark cancelled directly in Redis
                meta.status = "cancelled";
                meta.finished_at = nowSec();
                await r.set(K_META + meta.run_id, JSON.stringify(meta), "EX", MIRROR_TTL_S);
                await r.srem(K_USER + userId, meta.run_id);
                await r.xadd(K_FRAMES + meta.run_id, "*", "end", "cancelled");
                remoteCancelled = true;
              }
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    const cancelledTasks = resolvedConvId ? await this.cancelConversationDeviceTasks(resolvedConvId, userId) : [];
    if (resolvedConvId && this.depsRef) {
      void pushLiveActivityEvent(this.depsRef, userId, resolvedConvId, "end", {
        status: "cancelled",
        currentStep: "已停止",
      });
      void popFollowups(userId, resolvedConvId);
    }
    return { cancelled: remoteCancelled || cancelledTasks.length > 0, run_id: resolvedRunId, cancelled_tasks: cancelledTasks };
  }

  /** Rolling deployment graceful drain: hand over resumable runs to surviving replicas. */
  async drain(): Promise<void> {
    const running = [...this.byId.values()].filter((r) => !r.done);
    if (!running.length) return;
    const r = cluster.redis;
    for (const run of running) {
      if (run.resumeSpec && r) {
        run.status = "handed_over";
        run.abortController.abort();
        const payload = {
          run_id: run.runId,
          conversation_id: run.conversationId,
          user_id: run.userId,
          question: run.question,
          title: run.title,
          execution_mode: run.executionMode,
          model: run.model,
          device_name: run.deviceName,
          images: run.images,
          kind: run.resumeSpec.kind,
          kwargs: run.resumeSpec.kwargs,
          checkpoint: run.checkpoint,
        };
        await r.set(K_HANDOVER + run.runId, JSON.stringify(payload), "EX", HANDOVER_TTL_S).catch(() => {});
        await r.sadd(K_HANDOVERS, run.runId).catch(() => {});
        cluster.publish(CH_HANDOVER, { run_id: run.runId });
      } else {
        await run.cancel("服务重启，任务已中断").catch(() => {});
      }
    }
    await Promise.allSettled(running.map((r) => r.waitDone(4000)));
  }

  async adoptPendingHandovers(): Promise<void> {
    const r = cluster.redis;
    if (!r || !this.depsRef) return;
    try {
      const ids = await r.smembers(K_HANDOVERS);
      for (const id of ids) await this.tryAdopt(id);
    } catch {
      /* ignore */
    }
  }

  async tryAdopt(runId: string): Promise<boolean> {
    const r = cluster.redis;
    if (!r || !this.depsRef) return false;
    const lock = await cluster.tryLock(`adopt:${runId}`, 30);
    if (!lock) return false;
    try {
      const raw = await r.get(K_HANDOVER + runId);
      if (!raw) return false;
      const h = JSON.parse(raw) as {
        run_id: string;
        conversation_id: string;
        user_id: string;
        question: string;
        title?: string | null;
        execution_mode?: string | null;
        model?: string | null;
        device_name?: string | null;
        images?: string[];
        kind: string;
        kwargs: Record<string, unknown>;
        checkpoint?: Record<string, unknown>;
      };
      const resumer = this.resumers[h.kind];
      if (!resumer) return false;
      const [user] = await this.depsRef.db.select().from(users).where(eq(users.id, h.user_id)).limit(1);
      if (!user) return false;

      await r.del(K_HANDOVER + runId);
      await r.srem(K_HANDOVERS, runId);

      const factory = resumer(h.kwargs, h.checkpoint ?? {});
      const run = new AskRun(this.depsRef, this, {
        runId: h.run_id,
        conversationId: h.conversation_id,
        userId: h.user_id,
        question: h.question,
        title: h.title,
        executionMode: h.execution_mode,
        model: h.model,
        deviceName: h.device_name,
        images: h.images,
        resume: { kind: h.kind, kwargs: h.kwargs, checkpoint: h.checkpoint },
      });
      this.byId.set(run.runId, run);
      this.byConv.set(run.conversationId, run);
      run.start(factory, user);
      return true;
    } catch {
      return false;
    } finally {
      await cluster.unlock(`adopt:${runId}`, lock);
    }
  }
}

export const askRuns = new AskRunRegistry();
