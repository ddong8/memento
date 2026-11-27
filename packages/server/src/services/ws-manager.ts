// Device WebSocket connections across api replicas, wire-compatible with server/server/services/ws_manager.py.
import { randomUUID } from "node:crypto";

import { WebSocket } from "ws";

import { Cluster, cluster, OWN_TTL, PREFIX } from "./cluster";

export const DEVICE = "device:";
export const TASK_WAITER = "taskwait:";
export const CANCEL_LATER = `${PREFIX}cancel-later:`;
export const CANCEL_LATER_TTL = 86400;
export const PRESENCE = `${PREFIX}presence`;
export const BROADCAST = `${PREFIX}broadcast`;
export const TASK_CHANNEL = `${PREFIX}task:`;
export const REFRESH_SECONDS = 15;
export const REQ_SEP = "~";

export interface WsLike {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  close?(code?: number, reason?: string): void;
}

/** Bounded async queue matching Python asyncio.Queue(maxsize=1000). */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((v: T | null) => void)[] = [];
  private closed = false;

  constructor(private readonly maxSize = 1000) {}

  putNowait(item: T): boolean {
    if (this.closed) return false;
    const w = this.waiters.shift();
    if (w) {
      w(item);
      return true;
    }
    if (this.items.length >= this.maxSize) return false;
    this.items.push(item);
    return true;
  }

  get(timeoutMs?: number): Promise<T | null> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = (v: T | null) => {
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push(waiter);
      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!(null);
  }
}

function wsSendJson(ws: WsLike, payload: Record<string, unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket is not open"));
      return;
    }
    try {
      ws.send(JSON.stringify(payload), (err) => {
        if (err) reject(err);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

interface PendingReq {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  done: boolean;
}

export class DeviceConnectionManager {
  private readonly connections = new Map<string, WsLike>();
  private readonly taskQueues = new Map<string, AsyncQueue<Record<string, unknown>>>();
  private readonly taskConnections = new Map<string, WsLike>();
  private readonly pendingFileRequests = new Map<string, PendingReq>();
  private remote = new Map<string, string>();
  private readonly remoteTasks = new Map<string, string>();
  private readonly cancelLater = new Map<string, Set<string>>();
  private touched: Set<string> | null = null;
  private refresher: NodeJS.Timeout | null = null;

  constructor(private readonly cl: Cluster = cluster) {
    cl.on(PRESENCE, (_ch, msg) => this.onPresence(msg));
    cl.on(BROADCAST, (_ch, msg) => this.onBroadcast(msg));
    cl.onPattern(`${TASK_CHANNEL}*`, (ch, msg) => this.onTaskMessage(ch, msg));
    cl.op("ws.send_json", (p) => this.sendJsonLocal(String(p.device_id ?? ""), (p.payload as Record<string, unknown>) ?? {}));
    cl.op("ws.send_task", (p) => this.sendTaskLocal(String(p.device_id ?? ""), (p.task as Record<string, unknown>) ?? {}));
    cl.op("ws.send_cancel", (p) => this.sendCancelLocal(String(p.device_id ?? ""), String(p.task_id ?? "")));
    cl.op("ws.send_input", (p) =>
      this.sendInputLocal(
        String(p.device_id ?? ""),
        String(p.task_id ?? ""),
        String(p.input ?? ""),
        p.question_id ? String(p.question_id) : null,
      ),
    );
    cl.op("ws.file_stat", (p) => this.fileStatLocal(String(p.device_id ?? ""), String(p.path ?? ""), Number(p.timeout ?? 8)));
    cl.op("ws.file_chunk", (p) =>
      this.fileChunkLocal(String(p.device_id ?? ""), String(p.path ?? ""), Number(p.offset ?? 0), Number(p.length ?? 0), Number(p.timeout ?? 15)),
    );
    cl.op("ws.p2p_offer", (p) =>
      this.p2pOfferLocal(
        String(p.device_id ?? ""),
        String(p.sdp ?? ""),
        Array.isArray(p.ice_servers) ? (p.ice_servers as string[]) : [],
        Number(p.timeout ?? 12),
      ),
    );
    cl.op("ws.request", (p) =>
      this.requestLocal(String(p.device_id ?? ""), (p.payload as Record<string, unknown>) ?? {}, Number(p.timeout ?? 30)),
    );
    cl.op("ws.reply", (p) => this.opReply(p));
    cl.onStart(() => this.start());
    cl.onStop(() => this.stop());
  }

  private async start(): Promise<void> {
    await this.refreshRemote();
    this.refresher = setInterval(() => void this.refreshRemote().catch(() => {}), REFRESH_SECONDS * 1000);
    this.refresher.unref?.();
  }

  private async stop(): Promise<void> {
    if (this.refresher) {
      clearInterval(this.refresher);
      this.refresher = null;
    }
  }

  private async refreshRemote(): Promise<void> {
    const me = this.cl.podId;
    this.touched = new Set();
    try {
      const owners = await this.cl.owners(DEVICE);
      const fresh = new Map<string, string>();
      for (const [key, pod] of Object.entries(owners)) {
        if (pod !== me) fresh.set(key.slice(DEVICE.length), pod);
      }
      for (const alias of this.touched) {
        const cur = this.remote.get(alias);
        if (cur) fresh.set(alias, cur);
        else fresh.delete(alias);
      }
      this.remote = fresh;
    } finally {
      this.touched = null;
    }
  }

  private onPresence(msg: Record<string, unknown>): void {
    const pod = String(msg.origin ?? "");
    if (!pod || pod === this.cl.podId) return;
    const aliases = Array.isArray(msg.aliases) ? (msg.aliases as string[]) : [];
    for (const alias of aliases) {
      if (this.touched) this.touched.add(alias);
      if (msg.up) {
        this.remote.set(alias, pod);
        if (this.connections.delete(alias)) {
          this.cl.forget(DEVICE + alias);
        }
      } else if (this.remote.get(alias) === pod) {
        this.remote.delete(alias);
      }
    }
  }

  async register(deviceId: string, ws: WsLike, ...aliases: (string | null | undefined)[]): Promise<void> {
    const names = [...new Set([deviceId, ...aliases].filter((n): n is string => Boolean(n)))];
    for (const name of names) {
      this.connections.set(name, ws);
      this.remote.delete(name);
      this.touched?.add(name);
    }
    for (const name of names) await this.cl.own(DEVICE + name);
    this.cl.publish(PRESENCE, { up: true, aliases: names });
  }

  async unregister(deviceId: string, ws?: WsLike | null): Promise<void> {
    const targetWs = ws ?? this.connections.get(deviceId) ?? null;
    const removed: string[] = [];
    if (targetWs) {
      for (const [k, v] of [...this.connections.entries()]) {
        if (v === targetWs) {
          this.connections.delete(k);
          removed.push(k);
        }
      }
      for (const [k, v] of [...this.taskConnections.entries()]) {
        if (v === targetWs) this.taskConnections.delete(k);
      }
    } else if (this.connections.delete(deviceId)) {
      removed.push(deviceId);
    }
    for (const alias of removed) await this.cl.disown(DEVICE + alias);
    if (removed.length) this.cl.publish(PRESENCE, { up: false, aliases: removed });
  }

  hasDevice(deviceId: string): boolean {
    return this.connections.has(deviceId) || this.remote.has(deviceId);
  }

  isOnline(deviceId: string): boolean {
    return this.hasDevice(deviceId);
  }

  hasOnlineDevices(): boolean {
    return this.connections.size > 0 || this.remote.size > 0;
  }

  connectedIds(): string[] {
    return [...new Set([...this.connections.keys(), ...this.remote.keys()])];
  }

  private async ownerOf(deviceId: string): Promise<string | null> {
    const pod = this.remote.get(deviceId) ?? (await this.cl.owner(DEVICE + deviceId));
    return pod && pod !== this.cl.podId ? pod : null;
  }

  private async remoteCall<T>(pod: string | null, op: string, payload: Record<string, unknown>, timeoutSec: number, fallback: T): Promise<T> {
    if (!pod) return fallback;
    try {
      return (await this.cl.call(pod, op, payload, Math.round(timeoutSec * 1000))) as T;
    } catch {
      if (!(await this.cl.alive(pod))) {
        for (const [a, p] of [...this.remote.entries()]) {
          if (p === pod) this.remote.delete(a);
        }
      }
      return fallback;
    }
  }

  async sendJson(deviceId: string, payload: Record<string, unknown>): Promise<boolean> {
    if (this.connections.has(deviceId)) return this.sendJsonLocal(deviceId, payload);
    return this.remoteCall(await this.ownerOf(deviceId), "ws.send_json", { device_id: deviceId, payload }, 5, false);
  }

  async broadcast(payload: Record<string, unknown>): Promise<void> {
    this.cl.publish(BROADCAST, { payload });
    await this.broadcastLocal(payload);
  }

  private async broadcastLocal(payload: Record<string, unknown>): Promise<void> {
    const seen = new Set<WsLike>();
    for (const [name, ws] of [...this.connections.entries()]) {
      if (seen.has(ws)) continue;
      seen.add(ws);
      await this.sendJsonLocal(name, payload);
    }
  }

  private onBroadcast(msg: Record<string, unknown>): void {
    if (msg.origin !== this.cl.podId && msg.payload && typeof msg.payload === "object") {
      void this.broadcastLocal(msg.payload as Record<string, unknown>);
    }
  }

  private async sendJsonLocal(deviceId: string, payload: Record<string, unknown>): Promise<boolean> {
    const ws = this.connections.get(deviceId);
    if (!ws) return false;
    try {
      await wsSendJson(ws, payload);
      return true;
    } catch {
      await this.unregister(deviceId, ws);
      return false;
    }
  }

  async sendTask(deviceId: string, task: Record<string, unknown>): Promise<boolean> {
    if (this.connections.has(deviceId)) return this.sendTaskLocal(deviceId, task);
    const pod = await this.ownerOf(deviceId);
    const ok = await this.remoteCall(pod, "ws.send_task", { device_id: deviceId, task }, 5, false);
    const tid = String(task.id ?? "");
    if (ok && tid && pod) this.remoteTasks.set(tid, pod);
    return ok;
  }

  private async sendTaskLocal(deviceId: string, task: Record<string, unknown>): Promise<boolean> {
    const ws = this.connections.get(deviceId);
    if (!ws) return false;
    try {
      await wsSendJson(ws, { type: "task_dispatch", task });
      const tid = String(task.id ?? "");
      if (tid) this.taskConnections.set(tid, ws);
      return true;
    } catch {
      await this.unregister(deviceId, ws);
      return false;
    }
  }

  async sendCancel(deviceId: string, taskId: string): Promise<boolean> {
    const tid = String(taskId);
    if (this.taskConnections.has(tid) || this.connections.has(deviceId)) return this.sendCancelLocal(deviceId, tid);
    const pod = this.remoteTasks.get(tid) ?? (await this.ownerOf(deviceId));
    return this.remoteCall(pod, "ws.send_cancel", { device_id: deviceId, task_id: tid }, 5, false);
  }

  async cancelWhenBack(deviceId: string, taskId: string): Promise<boolean> {
    if (await this.sendCancel(deviceId, taskId)) return true;
    const r = this.cl.redis;
    if (!r) {
      let set = this.cancelLater.get(deviceId);
      if (!set) {
        set = new Set();
        this.cancelLater.set(deviceId, set);
      }
      set.add(String(taskId));
      return false;
    }
    try {
      await r.sadd(CANCEL_LATER + deviceId, String(taskId));
      await r.expire(CANCEL_LATER + deviceId, CANCEL_LATER_TTL);
    } catch {
      /* ignore */
    }
    return false;
  }

  async sendKeptCancels(...aliases: (string | null | undefined)[]): Promise<void> {
    const r = this.cl.redis;
    const clean = [...new Set(aliases.filter((a): a is string => Boolean(a)))];
    for (const alias of clean) {
      let tids: string[] = [];
      if (!r) {
        const s = this.cancelLater.get(alias);
        this.cancelLater.delete(alias);
        tids = s ? [...s] : [];
      } else {
        try {
          const popped = await r.spop(CANCEL_LATER + alias, 1000);
          tids = Array.isArray(popped) ? popped : popped ? [popped] : [];
        } catch {
          continue;
        }
      }
      for (const tid of tids) await this.sendCancelLocal(alias, tid);
    }
  }

  private async sendCancelLocal(deviceId: string, tid: string): Promise<boolean> {
    const ws = this.taskConnections.get(tid) ?? this.connections.get(deviceId);
    if (!ws) return false;
    try {
      await wsSendJson(ws, { type: "task_cancel", task_id: tid });
      return true;
    } catch {
      return false;
    }
  }

  async sendInput(deviceId: string, taskId: string, inputText: string, questionId?: string | null): Promise<boolean> {
    const tid = String(taskId);
    if (this.taskConnections.has(tid) || this.connections.has(deviceId)) {
      return this.sendInputLocal(deviceId, tid, inputText, questionId ?? null);
    }
    const pod = this.remoteTasks.get(tid) ?? (await this.ownerOf(deviceId));
    return this.remoteCall(
      pod,
      "ws.send_input",
      { device_id: deviceId, task_id: tid, input: String(inputText), question_id: questionId ?? null },
      5,
      false,
    );
  }

  private async sendInputLocal(deviceId: string, tid: string, inputText: string, questionId: string | null): Promise<boolean> {
    const ws = this.taskConnections.get(tid) ?? this.connections.get(deviceId);
    if (!ws) return false;
    try {
      await wsSendJson(ws, {
        type: "task_input",
        task_id: tid,
        input: String(inputText),
        ...(questionId ? { question_id: questionId } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async subscribeTask(taskId: string): Promise<AsyncQueue<Record<string, unknown>>> {
    const q = new AsyncQueue<Record<string, unknown>>(1000);
    this.taskQueues.set(taskId, q);
    await this.cl.own(TASK_WAITER + taskId, OWN_TTL);
    return q;
  }

  async unsubscribeTask(taskId: string): Promise<void> {
    const q = this.taskQueues.get(taskId);
    this.taskQueues.delete(taskId);
    q?.close();
    this.taskConnections.delete(taskId);
    this.remoteTasks.delete(taskId);
    await this.cl.disown(TASK_WAITER + taskId);
  }

  async isWatched(taskId: string): Promise<boolean> {
    return this.taskQueues.has(taskId) || (await this.cl.owner(TASK_WAITER + taskId)) !== null;
  }

  private push(taskId: string, event: Record<string, unknown>): void {
    const q = this.taskQueues.get(taskId);
    if (!q) {
      this.cl.publish(TASK_CHANNEL + taskId, { event });
      return;
    }
    q.putNowait(event);
  }

  private onTaskMessage(channel: string, msg: Record<string, unknown>): void {
    if (msg.origin === this.cl.podId || !msg.event || typeof msg.event !== "object") return;
    const q = this.taskQueues.get(channel.slice(TASK_CHANNEL.length));
    q?.putNowait(msg.event as Record<string, unknown>);
  }

  pushChunk(taskId: string, stream: string, text: string, seq?: number | null): void {
    const evt: Record<string, unknown> = { type: "task_chunk", task_id: taskId, stream, text };
    if (seq !== undefined && seq !== null) evt.seq = seq;
    this.push(taskId, evt);
  }

  pushAlert(taskId: string, alert: Record<string, unknown>): void {
    this.push(taskId, { type: "task_alert", task_id: taskId, alert });
  }

  pushEvent(taskId: string, event: Record<string, unknown>): void {
    this.push(taskId, { type: "task_event", task_id: taskId, event });
  }

  pushProgress(taskId: string, status: string): void {
    this.push(taskId, { type: "task_progress", task_id: taskId, status });
  }

  pushFinished(taskId: string, result: Record<string, unknown>): void {
    this.taskConnections.delete(taskId);
    this.push(taskId, { type: "task_finished", task_id: taskId, result });
  }

  private reqId(): string {
    return `${this.cl.podId}${REQ_SEP}${randomUUID().replaceAll("-", "")}`;
  }

  private awaitReq(reqId: string, timeoutSec: number, timeoutMessage: string): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const entry: PendingReq = {
        done: false,
        resolve: (data) => {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(entry.timer);
          this.pendingFileRequests.delete(reqId);
          resolve(data);
        },
        reject: (err) => {
          if (entry.done) return;
          entry.done = true;
          clearTimeout(entry.timer);
          this.pendingFileRequests.delete(reqId);
          reject(err);
        },
        timer: setTimeout(() => {
          if (entry.done) return;
          entry.done = true;
          this.pendingFileRequests.delete(reqId);
          reject(new Error(timeoutMessage));
        }, Math.max(100, Math.round(timeoutSec * 1000))),
      };
      entry.timer.unref?.();
      this.pendingFileRequests.set(reqId, entry);
    });
  }

  async requestFileStat(deviceId: string, path: string, timeoutSec = 8): Promise<Record<string, unknown>> {
    if (this.connections.has(deviceId)) return this.fileStatLocal(deviceId, path, timeoutSec);
    const res = await this.remoteCall<Record<string, unknown> | null>(
      await this.ownerOf(deviceId),
      "ws.file_stat",
      { device_id: deviceId, path, timeout: timeoutSec },
      timeoutSec + 3,
      null,
    );
    return res && typeof res === "object" ? res : { exists: false, error: `device ${deviceId} not connected` };
  }

  private async fileStatLocal(deviceId: string, path: string, timeoutSec: number): Promise<Record<string, unknown>> {
    const ws = this.connections.get(deviceId);
    if (!ws) return { exists: false, error: `device ${deviceId} not connected` };
    const reqId = this.reqId();
    const wait = this.awaitReq(reqId, timeoutSec, "device stat request timed out");
    try {
      await wsSendJson(ws, { type: "file_stat_req", req_id: reqId, path });
      return await wait;
    } catch (e) {
      this.pendingFileRequests.delete(reqId);
      return { exists: false, error: (e as Error).message || String(e) };
    }
  }

  async requestFileChunk(deviceId: string, path: string, offset: number, length: number, timeoutSec = 15): Promise<Buffer | null> {
    let res: Record<string, unknown> | null;
    if (this.connections.has(deviceId)) {
      res = await this.fileChunkLocal(deviceId, path, offset, length, timeoutSec);
    } else {
      res = await this.remoteCall<Record<string, unknown> | null>(
        await this.ownerOf(deviceId),
        "ws.file_chunk",
        { device_id: deviceId, path, offset, length, timeout: timeoutSec },
        timeoutSec + 3,
        null,
      );
    }
    if (!res || typeof res !== "object" || res.error) return null;
    const b64 = typeof res.data_b64 === "string" ? res.data_b64 : "";
    return b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
  }

  private async fileChunkLocal(deviceId: string, path: string, offset: number, length: number, timeoutSec: number): Promise<Record<string, unknown> | null> {
    const ws = this.connections.get(deviceId);
    if (!ws) return null;
    const reqId = this.reqId();
    const wait = this.awaitReq(reqId, timeoutSec, "chunk request timed out");
    try {
      await wsSendJson(ws, { type: "file_chunk_req", req_id: reqId, path, offset, length });
      return await wait;
    } catch {
      this.pendingFileRequests.delete(reqId);
      return null;
    }
  }

  async requestP2pAnswer(deviceId: string, sdp: string, iceServers: string[], timeoutSec = 12): Promise<Record<string, unknown>> {
    if (this.connections.has(deviceId)) return this.p2pOfferLocal(deviceId, sdp, iceServers, timeoutSec);
    const res = await this.remoteCall<Record<string, unknown> | null>(
      await this.ownerOf(deviceId),
      "ws.p2p_offer",
      { device_id: deviceId, sdp, ice_servers: iceServers, timeout: timeoutSec },
      timeoutSec + 3,
      null,
    );
    return res && typeof res === "object" ? res : { error: `device ${deviceId} not connected` };
  }

  private async p2pOfferLocal(deviceId: string, sdp: string, iceServers: string[], timeoutSec: number): Promise<Record<string, unknown>> {
    const ws = this.connections.get(deviceId);
    if (!ws) return { error: `device ${deviceId} not connected` };
    const reqId = this.reqId();
    const wait = this.awaitReq(reqId, timeoutSec, "device did not answer the offer in time");
    try {
      await wsSendJson(ws, { type: "p2p_offer", req_id: reqId, sdp, ice_servers: iceServers });
      return await wait;
    } catch (e) {
      this.pendingFileRequests.delete(reqId);
      return { error: (e as Error).message || String(e) };
    }
  }

  async requestDevice(deviceId: string, payload: Record<string, unknown>, timeoutSec = 30): Promise<Record<string, unknown>> {
    if (this.connections.has(deviceId)) return this.requestLocal(deviceId, payload, timeoutSec);
    const res = await this.remoteCall<Record<string, unknown> | null>(
      await this.ownerOf(deviceId),
      "ws.request",
      { device_id: deviceId, payload, timeout: timeoutSec },
      timeoutSec + 3,
      null,
    );
    return res && typeof res === "object" ? res : { error: "设备不在线", code: "offline" };
  }

  private async requestLocal(deviceId: string, payload: Record<string, unknown>, timeoutSec: number): Promise<Record<string, unknown>> {
    if (!this.connections.has(deviceId)) return { error: "设备不在线", code: "offline" };
    const reqId = this.reqId();
    const wait = this.awaitReq(reqId, timeoutSec, "__timeout__");
    try {
      if (!(await this.sendJsonLocal(deviceId, { ...payload, req_id: reqId }))) {
        this.pendingFileRequests.delete(reqId);
        return { error: "设备不在线", code: "offline" };
      }
      const res = await wait;
      return res && typeof res === "object" ? res : { error: "设备的回应无法识别" };
    } catch (e) {
      this.pendingFileRequests.delete(reqId);
      if ((e as Error).message === "__timeout__") return { error: `设备 ${Math.trunc(timeoutSec)} 秒没有回应`, code: "timeout" };
      return { error: (e as Error).message || String(e) };
    }
  }

  handleFileResponse(data: Record<string, unknown>): void {
    const reqId = String(data.req_id ?? "");
    if (!reqId) return;
    const pending = this.pendingFileRequests.get(reqId);
    if (pending) {
      pending.resolve(data);
      return;
    }
    const sepIdx = reqId.indexOf(REQ_SEP);
    const pod = sepIdx > 0 ? reqId.slice(0, sepIdx) : "";
    if (pod && pod !== this.cl.podId) {
      this.cl.spawn(async () => {
        await this.cl.call(pod, "ws.reply", data, 30_000).catch(() => {});
      });
    }
  }

  private opReply(p: Record<string, unknown>): boolean {
    const reqId = String(p.req_id ?? "");
    const pending = this.pendingFileRequests.get(reqId);
    if (!pending || pending.done) return false;
    pending.resolve(p);
    return true;
  }
}

export const wsManager = new DeviceConnectionManager();
