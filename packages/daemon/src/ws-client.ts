import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";

import WebSocket from "ws";

import { AgentLogins, LOGIN_AGENTS, type LoginAgent } from "./agent-login.js";
import { probeCapabilities } from "./capabilities.js";
import type { CollectorConfig } from "./config.js";
import { deviceFilePath } from "./file-path.js";
import { P2PHost } from "./p2p.js";
import { probeAllQuotas } from "./quotas.js";
import type { ServerRoute } from "./server-route.js";
import { exportClaudeSession } from "./session-sync.js";
import { execOnSource } from "./source-exec.js";
import { computeBackoffWithJitter, parseTaskDispatch, TaskRunner } from "./task-runner.js";
import { applyWorkspaceRequest, exportWorkspace, WorkspaceError } from "./workspace.js";
import { flushPendingPatches, type Relay } from "./workspace-sync.js";

type Log = (message: string) => void;

const PING_MS = 25_000;
/** Re-probe and report quotas every 12 pings (~5 minutes). */
const QUOTA_EVERY_PINGS = 12;

export function taskSocketUrl(serverUrl: string, deviceId: string): string {
  const base = serverUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\/+$/, "");
  return `${base}/api/tasks/ws/${encodeURIComponent(deviceId)}`;
}


/**
 * The device's live link to the server: receives dispatched tasks, cancels and
 * follow-ups, streams task output back, answers file reads for media the app
 * wants to show, and reconnects with backoff when the link drops.
 */
export class WsTaskClient {
  private disposed = false;
  private ws: WebSocket | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private wakeUp: (() => void) | undefined;
  private readonly pendingOutbox: Record<string, unknown>[] = [];
  readonly runner: TaskRunner;
  /** Direct (WebRTC) file transfer to pages; the server only relays its offer and answer. */
  private readonly p2p: P2PHost;

  private route: ServerRoute | undefined;
  /** Whether the open connection goes over the LAN address. */
  private viaLan = false;
  private commandsPending: (() => void) | undefined;
  /** Requests this device made to the server (ws_relay), waiting for its ws_relay_reply. */
  private readonly relayWaiting = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private pendingPatchTimer: NodeJS.Timeout | undefined;
  /** Agent CLI sign-ins driven from the web page (a server nobody sits at). */
  private readonly logins = new AgentLogins(() => void this.reportCapabilities(true));

  constructor(
    private config: CollectorConfig,
    private readonly log: Log = () => {},
    private readonly onConnection: (online: boolean) => void = () => {},
  ) {
    this.runner = new TaskRunner((m) => this.sendJson(m), log);
    this.runner.relay = this.relay;
    this.p2p = new P2PHost(log);
  }

  /** Asks the server something over this connection; never queued for a later connection. */
  readonly relay: Relay = (op, body, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const ws = this.ws;
      if (ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("没有连上服务器"));
        return;
      }
      const reqId = randomUUID();
      const timer = setTimeout(() => {
        this.relayWaiting.delete(reqId);
        reject(new Error(`服务器 ${Math.round(timeoutMs / 1000)} 秒没有回应`));
      }, timeoutMs);
      this.relayWaiting.set(reqId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ ...body, type: "ws_relay", req_id: reqId, op }));
      } catch (e) {
        clearTimeout(timer);
        this.relayWaiting.delete(reqId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  private settleRelay(data: Record<string, unknown>): void {
    const waiting = this.relayWaiting.get(String(data.req_id ?? ""));
    if (!waiting) return;
    this.relayWaiting.delete(String(data.req_id));
    clearTimeout(waiting.timer);
    if (data.error) waiting.reject(new WorkspaceError(String(data.error), String(data.code ?? "failed")));
    else waiting.resolve(data);
  }

  private failRelays(reason: string): void {
    for (const [id, w] of this.relayWaiting) {
      clearTimeout(w.timer);
      w.reject(new Error(reason));
      this.relayWaiting.delete(id);
    }
  }

  updateConfig(config: CollectorConfig): void {
    this.config = config;
  }

  useRoute(route: ServerRoute): void {
    this.route = route;
  }

  /** The server queued a control command (resync, …): fetch it now instead of at the next HTTP poll. */
  onCommandsPending(fn: () => void): void {
    this.commandsPending = fn;
  }

  /**
   * The route changed: move the connection over. Leaving the LAN, the old connection is likely dead
   * already; moving onto it, wait until no task is running so nothing streams through a reconnect.
   */
  reroute(): void {
    if (!this.ws || this.viaLan === Boolean(this.route?.onLan)) return;
    if (this.route?.onLan && this.runner.runningTaskIds.length) return;
    this.log(`Reconnecting ${this.route?.onLan ? "over the LAN" : "through the public URL"}`);
    this.ws.close(1000, "route changed");
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.pingTimer);
    clearInterval(this.pendingPatchTimer);
    this.failRelays("守护进程正在退出");
    this.ws?.close();
    this.wakeUp?.();
    this.runner.dispose();
    this.p2p.dispose();
    this.logins.stopAll();
  }

  /** Connects and stays connected until disposed. */
  async start(): Promise<void> {
    let attempt = 0;
    while (!this.disposed) {
      this.onConnection(false);
      try {
        const reason = await this.connectOnce(() => {
          attempt = 0;
        });
        if (reason === 4003) {
          this.log("Server rejected the device (4003 unauthorized); retrying with backoff");
        }
      } catch (e) {
        this.log(`WebSocket disconnected or failed: ${e instanceof Error ? e.message : e}`);
      } finally {
        clearInterval(this.pingTimer);
        this.ws = undefined;
        this.failRelays("和服务器的连接断开了");
        this.onConnection(false);
      }
      if (this.disposed) break;
      const delayMs = computeBackoffWithJitter(attempt, { baseMs: 1500, maxMs: 30_000, jitterRatio: 0.25 });
      attempt++;
      this.log(`Reconnecting WebSocket in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt})...`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delayMs);
        this.wakeUp = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** One connection's lifetime; resolves with the close code. */
  private connectOnce(onOpen: () => void): Promise<number> {
    const target = this.route?.target() ?? { base: this.config.serverUrl };
    const url = taskSocketUrl(target.base, this.config.deviceId);
    this.viaLan = Boolean(target.host);
    this.log(`Connecting to WebSocket: ${url}`);
    const ws = new WebSocket(url, {
      headers: {
        ...(target.host ? { host: target.host } : {}),
        "x-collector-token": this.config.token,
        "x-device-id": this.config.deviceId,
        ...(this.config.remoteExecKey ? { "x-remote-exec-key": this.config.remoteExecKey } : {}),
      },
      handshakeTimeout: 15_000,
      rejectUnauthorized: process.env.MEMENTO_INSECURE_TLS !== "1",
    });
    this.ws = ws;
    return new Promise<number>((resolve, reject) => {
      let opened = false;
      ws.on("open", () => {
        opened = true;
        onOpen();
        this.log("WebSocket transport connected, awaiting server handshake...");
        this.startPing();
        void this.reportCapabilities();
      });
      ws.on("message", (raw) => this.handleFrame(raw.toString()));
      ws.on("close", (code, reason) => {
        if (opened) this.log(`WebSocket closed by server (code: ${code}${reason.length ? `, reason: ${reason.toString()}` : ""})`);
        resolve(code);
      });
      ws.on("error", (e) => {
        if (!opened && this.viaLan) this.route?.drop(`内网 WebSocket 连不上（${e.message}）`);
        if (!opened) reject(e);
        else this.log(`WebSocket error: ${e.message}`);
      });
    });
  }

  private handleFrame(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    try {
      switch (data.type) {
        case "connected":
          this.onConnection(true);
          this.log(`Handshake verified by server (${String(data.device_name ?? "")})`);
          this.flushPendingOutbox();
          void this.reportQuotas();
          this.schedulePendingPatches();
          break;
        case "pong":
          break;
        case "commands_pending":
          this.commandsPending?.();
          break;
        case "get_agent_capabilities":
          void this.reportCapabilities(true);
          void this.reportQuotas();
          break;
        case "get_agent_quotas":
          void this.reportQuotas();
          break;
        case "task_dispatch": {
          if (!data.task || typeof data.task !== "object") break;
          const task = parseTaskDispatch(data.task as Record<string, unknown>);
          this.log(`Received task dispatch: ${task.id} (${task.action})`);
          void this.runner.execute(task);
          break;
        }
        case "task_cancel":
          if (data.task_id != null) this.runner.cancel(String(data.task_id));
          break;
        case "task_input":
          if (data.task_id != null && data.input != null) {
            this.runner.input(String(data.task_id), String(data.input), data.question_id != null ? String(data.question_id) : undefined);
          }
          break;
        case "p2p_offer": {
          const reqId = String(data.req_id ?? "");
          const ice = Array.isArray(data.ice_servers) ? data.ice_servers.map(String) : [];
          void this.p2p.answer(String(data.sdp ?? ""), ice).then((res) => this.sendJson({ type: "p2p_answer", req_id: reqId, ...res }));
          break;
        }
        case "file_stat_req":
          void this.handleFileStat(String(data.req_id ?? ""), String(data.path ?? ""));
          break;
        case "file_chunk_req":
          void this.handleFileChunk(
            String(data.req_id ?? ""),
            String(data.path ?? ""),
            typeof data.offset === "number" ? data.offset : 0,
            typeof data.length === "number" ? data.length : 512 * 1024,
          );
          break;
        case "ws_relay_reply":
          this.settleRelay(data);
          break;
        case "workspace_export_req":
          void this.handleWorkspaceExport(data);
          break;
        case "workspace_apply_req":
          void this.handleWorkspaceApply(data);
          break;
        case "workspace_exec_req":
          void this.handleWorkspaceExec(data);
          break;
        case "session_export_req":
          void this.handleSessionExport(data);
          break;
        case "agent_login_req":
          void this.handleAgentLogin(data);
          break;
        case "task_log_resync": {
          if (data.task_id != null) {
            const taskId = String(data.task_id);
            const fromSeq = typeof data.from_seq === "number" ? data.from_seq : 1;
            const resent = this.runner.resendBufferedChunks(taskId, fromSeq);
            this.log(`Resent ${resent} buffered log chunk(s) for task ${taskId} from seq ${fromSeq}`);
          }
          break;
        }
      }
    } catch (e) {
      this.log(`Error processing frame: ${e instanceof Error ? e.message : e}`);
    }
  }

  private enqueuePending(message: Record<string, unknown>): void {
    const type = String(message.type ?? "");
    if (!type || type === "ping" || type === "pong") return;

    // Idempotent deduplication: avoid duplicate chunks on reconnect
    if (type === "task_chunk" && message.task_id && message.seq !== undefined) {
      const exists = this.pendingOutbox.some(
        (m) => m.type === "task_chunk" && m.task_id === message.task_id && m.seq === message.seq
      );
      if (!exists) {
        this.pendingOutbox.push(message);
      }
    } else {
      this.pendingOutbox.push(message);
    }
    if (this.pendingOutbox.length > 1000) {
      // Keep queue bounded; never drop task_finished
      const dropIdx = this.pendingOutbox.findIndex((m) => m.type !== "task_finished");
      if (dropIdx !== -1) {
        this.pendingOutbox.splice(dropIdx, 1);
      } else {
        this.pendingOutbox.shift();
      }
    }
  }

  sendJson(message: Record<string, unknown>): void {
    const ws = this.ws;
    const type = String(message.type ?? "");
    if (type === "ping" || type === "pong") {
      if (ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(message));
        } catch {}
      }
      return;
    }

    // Preserve strict FIFO order: if there are pending messages, enqueue and flush
    if (this.pendingOutbox.length > 0) {
      this.enqueuePending(message);
      this.flushPendingOutbox();
      return;
    }

    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
        return;
      } catch (e) {
        this.log(`Failed to send frame: ${e instanceof Error ? e.message : e}`);
      }
    }
    // Queue critical task messages if socket is not open (e.g. during network or VPN switch)
    this.enqueuePending(message);
  }

  private flushPendingOutbox(): void {
    if (this.pendingOutbox.length === 0) return;
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    this.log(`Flushing ${this.pendingOutbox.length} queued messages after reconnect...`);
    while (this.pendingOutbox.length > 0) {
      const msg = this.pendingOutbox[0];
      try {
        ws.send(JSON.stringify(msg));
        this.pendingOutbox.shift();
      } catch (e) {
        this.log(`Failed flushing queued message: ${e instanceof Error ? e.message : e}`);
        break;
      }
    }
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    let count = 0;
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.sendJson({ type: "ping" });
      if (++count % QUOTA_EVERY_PINGS === 0) {
        void this.reportCapabilities();
        void this.reportQuotas();
      }
    }, PING_MS);
  }

  private async reportCapabilities(force = false): Promise<void> {
    try {
      const capabilities = await probeCapabilities(undefined, { force });
      this.sendJson({ type: "agent_capabilities", capabilities });
      this.log(`Reported agent capabilities: ${Object.keys(capabilities).join(", ")}`);
    } catch (e) {
      this.log(`Capability probe failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async reportQuotas(): Promise<void> {
    try {
      const report = await probeAllQuotas();
      this.sendJson({ type: "agent_quotas", quotas: report });
      const activeTools = Object.keys(report.tools).filter((k) => (report.tools as any)[k]?.available);
      this.log(`Reported agent quotas for tools: ${activeTools.join(", ")}`);
    } catch (e) {
      this.log(`Quota probe failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  private async handleFileStat(reqId: string, rawPath: string): Promise<void> {
    const path = deviceFilePath(rawPath);
    try {
      const st = await stat(path);
      if (!st.isFile()) throw new Error(`File not found on device: ${path}`);
      this.sendJson({ type: "file_stat_resp", req_id: reqId, exists: true, total_size: st.size });
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      this.sendJson({
        type: "file_stat_resp",
        req_id: reqId,
        exists: false,
        error: missing ? `File not found on device: ${path}` : e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async handleFileChunk(reqId: string, rawPath: string, offset: number, length: number): Promise<void> {
    const path = deviceFilePath(rawPath);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "r");
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, 8 * 1024 * 1024)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      this.sendJson({ type: "file_chunk_resp", req_id: reqId, data_b64: buffer.subarray(0, bytesRead).toString("base64"), bytes_read: bytesRead });
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      this.sendJson({ type: "file_chunk_resp", req_id: reqId, error: missing ? `File not found: ${path}` : e instanceof Error ? e.message : String(e) });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Changes another device made to code on this one, which couldn't be delivered then: sent now and every 5 minutes. */
  private schedulePendingPatches(): void {
    const flush = () => void flushPendingPatches(this.relay, this.log).catch(() => {});
    setTimeout(flush, 5_000).unref?.();
    if (!this.pendingPatchTimer) {
      this.pendingPatchTimer = setInterval(() => this.connected && flush(), 5 * 60_000);
      this.pendingPatchTimer.unref?.();
    }
  }

  /** Another device is about to work on code in a directory here: pack it up for the server to fetch. */
  private async handleWorkspaceExport(data: Record<string, unknown>): Promise<void> {
    const reqId = String(data.req_id ?? "");
    try {
      const have = Array.isArray(data.have) ? data.have.map(String) : [];
      const r = await exportWorkspace(deviceFilePath(String(data.path ?? "")), have);
      this.log(`Workspace export of ${r.root}: ${r.upToDate ? "up to date" : `${r.size} bytes`}`);
      this.sendJson({
        type: "workspace_resp",
        req_id: reqId,
        bundle_path: r.bundle,
        size: r.size,
        head: r.head,
        branch: r.branch,
        snapshot: r.snapshot,
        tree: r.tree,
        root: r.root,
        rel: r.rel,
        up_to_date: r.upToDate,
        upstream: r.upstream ?? "",
        user_name: r.userName ?? "",
        user_email: r.userEmail ?? "",
      });
    } catch (e) {
      this.sendJson({ type: "workspace_resp", req_id: reqId, error: e instanceof Error ? e.message : String(e), code: e instanceof WorkspaceError ? e.code : "failed" });
    }
  }

  /** An agent on another device runs a command here, on its changes to code in a directory here (in a checkout of its own). */
  private async handleWorkspaceExec(data: Record<string, unknown>): Promise<void> {
    const reqId = String(data.req_id ?? "");
    const path = String(data.path ?? "");
    try {
      this.log(`Running a command for an agent on another device in ${path}: ${String(data.command ?? "").slice(0, 200)}`);
      const r = await execOnSource(deviceFilePath(path), data);
      this.log(`Command for the agent on another device exited ${r.exit_code} after ${r.seconds}s`);
      this.sendJson({ type: "workspace_resp", req_id: reqId, ...r });
    } catch (e) {
      this.sendJson({ type: "workspace_resp", req_id: reqId, error: e instanceof Error ? e.message : String(e), code: e instanceof WorkspaceError ? e.code : "failed" });
    }
  }

  /** Another device is about to continue a Claude Code session that is here: where its transcript is, for the server to fetch. */
  private async handleSessionExport(data: Record<string, unknown>): Promise<void> {
    const reqId = String(data.req_id ?? "");
    try {
      const r = await exportClaudeSession(String(data.session_id ?? ""));
      this.log(`Session export of ${String(data.session_id ?? "")}: ${r.size} bytes`);
      this.sendJson({ type: "workspace_resp", req_id: reqId, ...r });
    } catch (e) {
      this.sendJson({ type: "workspace_resp", req_id: reqId, error: e instanceof Error ? e.message : String(e), code: "not_found" });
    }
  }

  /** Sign an agent CLI in from the web page: status / start / submit / poll / cancel. Links and codes never go to the log. */
  private async handleAgentLogin(data: Record<string, unknown>): Promise<void> {
    const reqId = String(data.req_id ?? "");
    const action = String(data.action ?? "status");
    const agent = String(data.agent ?? "") as LoginAgent;
    try {
      if (action === "status" && !agent) {
        this.sendJson({ type: "agent_login_resp", req_id: reqId, agents: await this.logins.statusAll() });
        return;
      }
      if (!LOGIN_AGENTS.includes(agent)) throw new Error(`不认识的智能体：${agent}`);
      let state;
      if (action === "start") state = await this.logins.start(agent);
      else if (action === "submit") state = await this.logins.submit(agent, String(data.code ?? ""));
      else if (action === "poll") state = await this.logins.poll(agent);
      else if (action === "cancel") {
        this.logins.stop(agent);
        state = await this.logins.status(agent);
      } else state = await this.logins.status(agent);
      this.log(`Agent login ${agent} ${action}: ${state.state}`);
      this.sendJson({ type: "agent_login_resp", req_id: reqId, ...state });
    } catch (e) {
      this.sendJson({ type: "agent_login_resp", req_id: reqId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** What an agent on another device changed in a directory here, and the commits it made. */
  private async handleWorkspaceApply(data: Record<string, unknown>): Promise<void> {
    const reqId = String(data.req_id ?? "");
    try {
      const { result: r, reply } = await applyWorkspaceRequest(deviceFilePath(String(data.path ?? "")), data);
      const commits = r.commits?.length ? `, ${r.commits.length} commit(s) ${r.committed === "branch" ? "on the branch" : `kept on ${r.commitBranch}`}` : "";
      const push = r.push ? `, push ${r.push.status}` : "";
      this.log(`Workspace patch of task ${String(data.task_id ?? "")}: ${r.applied ? "applied" : r.conflict ? `conflict, kept on ${r.branch ?? "patch file"}` : "saved"}${commits}${push}`);
      this.sendJson({ type: "workspace_resp", req_id: reqId, ...reply });
    } catch (e) {
      this.sendJson({ type: "workspace_resp", req_id: reqId, error: e instanceof Error ? e.message : String(e), code: e instanceof WorkspaceError ? e.code : "failed" });
    }
  }
}
