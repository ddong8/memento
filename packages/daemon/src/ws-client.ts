import { open, stat } from "node:fs/promises";

import WebSocket from "ws";

import { probeCapabilities } from "./capabilities.js";
import type { CollectorConfig } from "./config.js";
import { P2pMediaServer } from "./p2p-media.js";
import { probeAllQuotas } from "./quotas.js";
import { parseTaskDispatch, TaskRunner } from "./task-runner.js";

type Log = (message: string) => void;

const PING_MS = 25_000;
/** Refresh and report the P2P IPv6 endpoint every 12 pings (~5 minutes): ISP prefixes change. */
const P2P_EVERY_PINGS = 12;

export function taskSocketUrl(serverUrl: string, deviceId: string): string {
  const base = serverUrl.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://").replace(/\/+$/, "");
  return `${base}/api/tasks/ws/${encodeURIComponent(deviceId)}`;
}

const stripFileScheme = (p: string) => p.replace(/^file:\/\//, "");

/**
 * The device's live link to the server: receives dispatched tasks, cancels and
 * follow-ups, streams task output back, answers file reads for media the app
 * wants to show, and reconnects with backoff when the link drops.
 */
export class WsTaskClient {
  private disposed = false;
  private ws: WebSocket | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private p2p: P2pMediaServer | undefined;
  private wakeUp: (() => void) | undefined;
  readonly runner: TaskRunner;

  constructor(
    private config: CollectorConfig,
    private readonly log: Log = () => {},
    private readonly onConnection: (online: boolean) => void = () => {},
  ) {
    this.runner = new TaskRunner((m) => this.sendJson(m), log);
  }

  updateConfig(config: CollectorConfig): void {
    this.config = config;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
    this.wakeUp?.();
    void this.p2p?.stop();
    this.p2p = undefined;
    this.runner.dispose();
  }

  /** Connects and stays connected until disposed. */
  async start(): Promise<void> {
    this.p2p ??= new P2pMediaServer(this.config.token, this.log);
    await this.p2p.start().catch((e: unknown) => this.log(`Failed to start IPv6 P2P server: ${e instanceof Error ? e.message : e}`));

    let backoff = 2;
    while (!this.disposed) {
      this.onConnection(false);
      try {
        const reason = await this.connectOnce(() => (backoff = 2));
        if (reason === 4003) {
          this.log("Server rejected the device (4003 unauthorized); retrying");
          backoff = 5;
        }
      } catch (e) {
        this.log(`WebSocket disconnected or failed: ${e instanceof Error ? e.message : e} (reconnecting in ${backoff}s)`);
      } finally {
        clearInterval(this.pingTimer);
        this.ws = undefined;
        this.onConnection(false);
      }
      if (this.disposed) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, backoff * 1000);
        this.wakeUp = () => {
          clearTimeout(t);
          resolve();
        };
      });
      backoff = Math.min(Math.max(backoff * 2, 2), 30);
    }
  }

  /** One connection's lifetime; resolves with the close code. */
  private connectOnce(onOpen: () => void): Promise<number> {
    const url = taskSocketUrl(this.config.serverUrl, this.config.deviceId);
    this.log(`Connecting to WebSocket: ${url}`);
    const ws = new WebSocket(url, {
      headers: {
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
        void this.reportP2pInfo();
      });
      ws.on("message", (raw) => this.handleFrame(raw.toString()));
      ws.on("close", (code, reason) => {
        if (opened) this.log(`WebSocket closed by server (code: ${code}${reason.length ? `, reason: ${reason.toString()}` : ""})`);
        resolve(code);
      });
      ws.on("error", (e) => {
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
          void this.reportP2pInfo();
          void this.reportQuotas();
          break;
        case "pong":
          break;
        case "get_agent_capabilities":
          void this.reportCapabilities();
          void this.reportQuotas();
          void this.reportP2pInfo();
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
          if (data.task_id != null && data.input != null) this.runner.input(String(data.task_id), String(data.input));
          break;
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
      }
    } catch (e) {
      this.log(`Error processing frame: ${e instanceof Error ? e.message : e}`);
    }
  }

  sendJson(message: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      this.log(`Failed to send frame: ${e instanceof Error ? e.message : e}`);
    }
  }

  private startPing(): void {
    clearInterval(this.pingTimer);
    let count = 0;
    this.pingTimer = setInterval(() => {
      if (!this.connected) return;
      this.sendJson({ type: "ping" });
      if (++count % P2P_EVERY_PINGS === 0) void this.reportP2pInfo();
    }, PING_MS);
  }

  private async reportCapabilities(): Promise<void> {
    try {
      const capabilities = await probeCapabilities();
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

  private async reportP2pInfo(): Promise<void> {
    const p2p = this.p2p;
    if (!p2p?.port) return;
    const ipv6 = p2p.refreshIpv6();
    if (!ipv6) return;
    this.sendJson({ type: "p2p_network_info", ipv6, port: p2p.port, token: this.config.token });
    this.log(`Registered IPv6 P2P streaming endpoint with coordinator: [${ipv6}]:${p2p.port}`);
  }

  private async handleFileStat(reqId: string, rawPath: string): Promise<void> {
    const path = stripFileScheme(rawPath);
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
    const path = stripFileScheme(rawPath);
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
}
