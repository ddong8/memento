// Standalone Desktop <-> Mobile Connection Manager:
//   1) Zero-restart LAN HTTP/SSE/WS forwarder (0.0.0.0:8771 -> 127.0.0.1:8770)
//   2) Automatic Tailscale Serve detection & 1-click enable (zero-config HTTPS when Tailscale is present)
//   3) Outbound stateless blind HTTPS reverse tunnel (WSS /api/relay/connect) for seamless 4G/5G access
//      with zero user data stored on the relay server.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import WebSocket from "ws";

const execFileAsync = promisify(execFile);

export const DEFAULT_RELAY_SERVER_URL = "https://mem.ihasy.com";
export const DEFAULT_LAN_PORT = 8771;
const MAX_TUNNEL_REQ_BYTES = 16 * 1024 * 1024;
const RELAY_CHUNK_BYTES = 192 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface MobileConnectConfig {
  enabled: boolean;
  lanEnabled: boolean;
  relayEnabled: boolean;
  relayServerUrl: string;
  tunnelSecret: string;
  lanPort: number;
}

export interface TailscaleServeInfo {
  installed: boolean;
  running: boolean;
  dnsName: string | null;
  serveUrl: string | null;
}

export interface MobileConnectStatus {
  isStandalone: boolean;
  enabled: boolean;
  lanEnabled: boolean;
  lanRunning: boolean;
  lanPort: number | null;
  lanUrls: string[];
  relayEnabled: boolean;
  relayServerUrl: string;
  relayState: "off" | "connecting" | "connected" | "error";
  relayApiUrl: string | null;
  relayError: string | null;
  tailscale: TailscaleServeInfo;
  deviceName: string;
}

export interface MobileConnectUpdate {
  enabled?: boolean;
  lanEnabled?: boolean;
  relayEnabled?: boolean;
  relayServerUrl?: string;
}

export interface MobilePairResult {
  ok: boolean;
  pairUrl?: string;
  expiresIn?: number;
  status?: MobileConnectStatus;
  error?: string;
}

/** Deterministic tunnel ID derived from the desktop's local 256-bit secret (matches packages/server). */
export function deriveTunnelId(secret: string): string {
  const digest = createHash("sha256").update(`memento-relay-v1:${secret}`, "utf8").digest("base64url");
  return `t_${digest.slice(0, 22)}`;
}

function isPrivateLanIpv4(addr: string): boolean {
  if (addr.startsWith("192.168.")) return true;
  if (addr.startsWith("10.")) return true;
  const m = /^172\.(\d+)\./.exec(addr);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function isTailscaleCgnat(addr: string): boolean {
  const m = /^100\.(\d+)\./.exec(addr);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** List non-internal IPv4 LAN addresses, prioritizing RFC1918 home/office Wi-Fi addresses. */
export function listLanAddresses(): string[] {
  const ifaces = networkInterfaces();
  const preferred: string[] = [];
  const other: string[] = [];
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    // Skip virtual docker/bridge/tailscale/utun interfaces when real LAN exists
    const lowName = name.toLowerCase();
    const isVirtual = /^(utun|tun|tap|tailscale|docker|br-|veth|vbox|vmnet|awdl|llw|bridge)/.test(lowName);
    for (const ent of entries) {
      if (ent.family !== "IPv4" || ent.internal) continue;
      const ip = ent.address;
      if (!ip || ip.startsWith("169.254.") || isTailscaleCgnat(ip)) continue;
      if (!isVirtual && isPrivateLanIpv4(ip)) {
        preferred.push(ip);
      } else if (isPrivateLanIpv4(ip)) {
        other.push(ip);
      }
    }
  }
  return [...new Set([...preferred, ...other])];
}

function cleanDeviceName(): string {
  return hostname().replace(/\.local$/i, "").trim().slice(0, 40) || "Memento Desktop";
}

function findTailscaleBin(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") {
    return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
  }
  if (platform === "win32") {
    return ["tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe"];
  }
  return ["tailscale", "/usr/bin/tailscale", "/usr/local/bin/tailscale"];
}

async function runTailscale(args: string[], timeoutMs = 3000): Promise<{ bin: string; stdout: string } | null> {
  for (const bin of findTailscaleBin()) {
    if (bin.includes("/") || bin.includes("\\")) {
      if (!existsSync(bin)) continue;
    }
    try {
      const { stdout } = await execFileAsync(bin, args, { timeout: timeoutMs, windowsHide: true });
      return { bin, stdout: stdout || "" };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Detect whether Tailscale is installed, logged in, and already serving the local Memento port. */
export async function detectTailscaleServe(localPort: number): Promise<TailscaleServeInfo> {
  const stRes = await runTailscale(["status", "--json"], 2500);
  if (!stRes) {
    return { installed: false, running: false, dnsName: null, serveUrl: null };
  }
  let running = false;
  let dnsName: string | null = null;
  try {
    const parsed = JSON.parse(stRes.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    running = parsed.BackendState === "Running";
    const rawDns = (parsed.Self?.DNSName || "").replace(/\.+$/, "").trim();
    if (rawDns) dnsName = rawDns;
  } catch {
    return { installed: true, running: false, dnsName: null, serveUrl: null };
  }

  let serveUrl: string | null = null;
  if (running && dnsName) {
    try {
      const { stdout } = await execFileAsync(stRes.bin, ["serve", "status", "--json"], { timeout: 2500, windowsHide: true });
      const raw = stdout || "";
      if (raw.includes(`:${localPort}`) && raw.includes(dnsName)) {
        serveUrl = `https://${dnsName}`;
      }
    } catch {
      /* not serving yet */
    }
  }
  return { installed: true, running, dnsName, serveUrl };
}

/** Enable Tailscale Serve in the background to expose the local standalone port over private Tailnet HTTPS. */
export async function enableTailscaleServe(localPort: number): Promise<{ ok: boolean; serveUrl?: string; error?: string }> {
  const probe = await runTailscale(["status", "--json"], 2500);
  if (!probe) return { ok: false, error: "未检测到 Tailscale，请先安装并登录 Tailscale" };
  try {
    await execFileAsync(probe.bin, ["serve", "--bg", `http://127.0.0.1:${localPort}`], { timeout: 10_000, windowsHide: true });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const info = await detectTailscaleServe(localPort);
  if (info.dnsName) {
    return { ok: true, serveUrl: info.serveUrl || `https://${info.dnsName}` };
  }
  return { ok: false, error: "Tailscale Serve 已执行，但未获取到 Tailnet 域名，请在 Tailscale 控制台开启 MagicDNS / HTTPS" };
}

/** Build a compact `memento://pair?v=1&...` deep link suitable for native iOS/Android Camera QR scanning. */
export function buildPairingUrl(opts: {
  code: string;
  deviceName?: string;
  lanUrl?: string | null;
  tsUrl?: string | null;
  relayApiUrl?: string | null;
  uiOrigin?: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("v", "1");
  params.set("code", opts.code);
  if (opts.deviceName) params.set("name", opts.deviceName.slice(0, 40));
  if (opts.lanUrl) params.set("lan", opts.lanUrl.replace(/\/+$/, ""));
  if (opts.tsUrl) params.set("ts", opts.tsUrl.replace(/\/+$/, ""));
  if (opts.relayApiUrl) params.set("relay", opts.relayApiUrl.replace(/\/+$/, ""));
  if (opts.uiOrigin) params.set("ui", opts.uiOrigin.replace(/\/+$/, ""));
  return `memento://pair?${params.toString()}`;
}

function isAllowedCorsOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return (
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
    /^https?:\/\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/i.test(origin) ||
    /^https?:\/\/[a-z0-9-]+\.local(:\d+)?$/i.test(origin) ||
    /^https:\/\/[a-z0-9.-]+\.ts\.net$/i.test(origin) ||
    /^https:\/\/mem\.ihasy\.com$/i.test(origin)
  );
}

/**
 * Lightweight zero-restart LAN forwarder (0.0.0.0:8771 -> 127.0.0.1:8770).
 * Keeps 127.0.0.1:8770 loopback-only when disabled and avoids restarting embedded Postgres/Next.js.
 */
export class LanForwarder {
  private server: http.Server | null = null;
  private listenPort: number | null = null;
  private targetPort = 8770;

  get running(): boolean {
    return Boolean(this.server?.listening && this.listenPort);
  }

  get port(): number | null {
    return this.listenPort;
  }

  async start(targetLocalUrl: string, preferredPort = DEFAULT_LAN_PORT): Promise<number> {
    const parsed = new URL(targetLocalUrl);
    this.targetPort = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    if (this.server?.listening && this.listenPort) return this.listenPort;

    const srv = http.createServer((req, res) => {
      const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
      const allowOrigin = isAllowedCorsOrigin(origin) ? origin! : undefined;

      if (req.method === "OPTIONS" && allowOrigin) {
        res.writeHead(204, {
          "access-control-allow-origin": allowOrigin,
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": String(req.headers["access-control-request-headers"] || "Authorization,Content-Type,Accept"),
          "access-control-max-age": "600",
          vary: "Origin",
        });
        res.end();
        return;
      }

      const fwdHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        const low = k.toLowerCase();
        if (low === "host" || low === "origin" || HOP_BY_HOP.has(low)) continue;
        fwdHeaders[k] = v;
      }
      fwdHeaders.host = `127.0.0.1:${this.targetPort}`;

      const upReq = http.request(
        {
          hostname: "127.0.0.1",
          port: this.targetPort,
          method: req.method,
          path: req.url || "/",
          headers: fwdHeaders,
        },
        (upRes) => {
          const outHeaders: http.OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            const low = k.toLowerCase();
            if (HOP_BY_HOP.has(low)) continue;
            if (allowOrigin && low.startsWith("access-control-")) continue;
            outHeaders[k] = v;
          }
          if (allowOrigin) {
            outHeaders["access-control-allow-origin"] = allowOrigin;
            outHeaders["access-control-allow-credentials"] = "true";
            outHeaders["vary"] = "Origin";
          }
          res.writeHead(upRes.statusCode ?? 502, outHeaders);
          upRes.pipe(res);
        },
      );

      upReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        }
        res.end(JSON.stringify({ detail: `Local server unreachable: ${err.message}` }));
      });
      req.on("aborted", () => upReq.destroy());
      req.pipe(upReq);
    });

    // Forward WebSocket upgrades transparently to 127.0.0.1:<targetPort>
    srv.on("upgrade", (req, socket, head) => {
      const upstream = net.connect(this.targetPort, "127.0.0.1", () => {
        const headerLines: string[] = [`${req.method || "GET"} ${req.url || "/"} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i]!;
          const v = req.rawHeaders[i + 1] ?? "";
          if (k.toLowerCase() === "host") continue;
          headerLines.push(`${k}: ${v}`);
        }
        headerLines.push(`Host: 127.0.0.1:${this.targetPort}`, "", "");
        upstream.write(headerLines.join("\r\n"));
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });

    const listenOn = (port: number) =>
      new Promise<number | null>((resolve) => {
        const onErr = () => {
          srv.removeListener("listening", onOk);
          resolve(null);
        };
        const onOk = () => {
          srv.removeListener("error", onErr);
          const addr = srv.address();
          resolve(typeof addr === "object" && addr ? addr.port : port);
        };
        srv.once("error", onErr);
        srv.once("listening", onOk);
        srv.listen(port, "0.0.0.0");
      });

    const bound = (await listenOn(preferredPort)) ?? (await listenOn(0));
    if (!bound) {
      srv.close();
      throw new Error("无法绑定局域网端口");
    }
    this.server = srv;
    this.listenPort = bound;
    return bound;
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    this.listenPort = null;
    if (!srv) return;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

interface IncomingTunnelReq {
  method: string;
  path: string;
  headers: Record<string, string>;
  chunks: Buffer[];
  totalBytes: number;
  aborted: boolean;
}

/**
 * Outbound WSS blind relay client: connects from desktop -> relay server (/api/relay/connect)
 * and streams multiplexed HTTP + SSE requests straight to http://127.0.0.1:<localPort>.
 */
export class RelayTunnelClient {
  private ws: WebSocket | null = null;
  private state: "off" | "connecting" | "connected" | "error" = "off";
  private lastError: string | null = null;
  private tunnelId: string | null = null;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private readonly incoming = new Map<string, IncomingTunnelReq>();
  private readonly activeUpstreams = new Map<string, { abort: () => void }>();
  private readyWaiters: Array<(ok: boolean) => void> = [];

  constructor(
    private relayServerUrl: string,
    private readonly secret: string,
    private targetLocalUrl: string,
  ) {
    this.tunnelId = deriveTunnelId(secret);
  }

  get status() {
    return {
      state: this.state,
      tunnelId: this.tunnelId,
      error: this.lastError,
      relayApiUrl: this.tunnelId ? `${this.relayServerUrl.replace(/\/+$/, "")}/api/relay/t/${this.tunnelId}` : null,
    };
  }

  start(relayServerUrl?: string, targetLocalUrl?: string): void {
    if (relayServerUrl) this.relayServerUrl = relayServerUrl.replace(/\/+$/, "");
    if (targetLocalUrl) this.targetLocalUrl = targetLocalUrl.replace(/\/+$/, "");
    if (!this.stopped && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.stopped = false;
    this.backoffMs = 1000;
    this.connect();
  }

  waitUntilReady(timeoutMs = 3000): Promise<boolean> {
    if (this.state === "connected") return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(this.state === "connected"), timeoutMs);
      timer.unref?.();
      this.readyWaiters.push(done);
    });
  }

  private notifyReady(ok: boolean): void {
    const waiters = this.readyWaiters.splice(0, this.readyWaiters.length);
    for (const fn of waiters) fn(ok);
  }

  stop(): void {
    this.stopped = true;
    this.state = "off";
    this.lastError = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.incoming.clear();
    for (const up of this.activeUpstreams.values()) up.abort();
    this.activeUpstreams.clear();
    if (this.ws) {
      try {
        this.ws.close(1000, "client stop");
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.notifyReady(false);
  }

  private wsEndpoint(): string {
    const base = this.relayServerUrl.replace(/\/+$/, "");
    const wsBase = base.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
    return `${wsBase}/api/relay/connect`;
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsEndpoint(), { handshakeTimeout: 10_000 });
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.sendJson({ type: "auth", secret: this.secret });
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          this.sendJson({ type: "ping" });
        }
      }, 25_000);
      this.pingTimer.unref?.();
    });

    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(frame.type ?? "");
      if (type === "ready") {
        this.state = "connected";
        this.lastError = null;
        this.backoffMs = 1000;
        if (typeof frame.tunnelId === "string") this.tunnelId = frame.tunnelId;
        this.notifyReady(true);
        return;
      }
      if (type === "pong") return;
      if (type === "ping") {
        this.sendJson({ type: "pong" });
        return;
      }
      if (type === "error") {
        this.state = "error";
        this.lastError = String(frame.message || "relay error");
        return;
      }
      if (type === "req_head") {
        const reqId = String(frame.reqId ?? "");
        if (!reqId) return;
        const headers = (frame.headers && typeof frame.headers === "object" ? frame.headers : {}) as Record<string, string>;
        this.incoming.set(reqId, {
          method: String(frame.method || "GET"),
          path: String(frame.path || "/"),
          headers,
          chunks: [],
          totalBytes: 0,
          aborted: false,
        });
        return;
      }
      if (type === "req_chunk") {
        const reqId = String(frame.reqId ?? "");
        const rec = this.incoming.get(reqId);
        if (!rec || rec.aborted) return;
        const buf = Buffer.from(String(frame.b64 || ""), "base64");
        rec.totalBytes += buf.length;
        if (rec.totalBytes > MAX_TUNNEL_REQ_BYTES) {
          rec.aborted = true;
          this.incoming.delete(reqId);
          this.sendJson({ type: "res_error", reqId, status: 413, message: "Request too large" });
          return;
        }
        rec.chunks.push(buf);
        return;
      }
      if (type === "req_end") {
        const reqId = String(frame.reqId ?? "");
        const rec = this.incoming.get(reqId);
        this.incoming.delete(reqId);
        if (!rec || rec.aborted) return;
        this.dispatchLocalRequest(reqId, rec);
        return;
      }
      if (type === "req_abort") {
        const reqId = String(frame.reqId ?? "");
        this.incoming.delete(reqId);
        const up = this.activeUpstreams.get(reqId);
        if (up) {
          this.activeUpstreams.delete(reqId);
          up.abort();
        }
      }
    });

    const onDisconnect = (errMsg?: string) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.incoming.clear();
      for (const up of this.activeUpstreams.values()) up.abort();
      this.activeUpstreams.clear();
      if (!this.stopped) {
        this.state = "error";
        if (errMsg) this.lastError = errMsg;
        this.scheduleReconnect();
      }
    };

    ws.on("error", (err) => {
      this.lastError = err.message || "隧道连接错误";
      onDisconnect(this.lastError);
    });
    ws.on("close", (_code, reasonBuf) => {
      const reason = reasonBuf?.toString("utf8") || "";
      onDisconnect(reason || this.lastError || "隧道连接已断开，正在重连…");
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private dispatchLocalRequest(reqId: string, rec: IncomingTunnelReq): void {
    let target: URL;
    try {
      const sub = rec.path.startsWith("/") ? rec.path : `/${rec.path}`;
      target = new URL(sub, this.targetLocalUrl);
    } catch {
      this.sendJson({ type: "res_error", reqId, status: 400, message: "Invalid path" });
      return;
    }

    const body = rec.chunks.length ? Buffer.concat(rec.chunks) : null;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(rec.headers)) {
      const low = k.toLowerCase();
      // Strip origin & hop-by-hop headers so local loopback CORS never rejects valid relayed calls.
      if (low === "host" || low === "origin" || low === "content-length" || low === "accept-encoding" || HOP_BY_HOP.has(low)) {
        continue;
      }
      headers[k] = v;
    }
    headers.host = target.host;
    // Request uncompressed body from localhost so chunks stream cleanly without double-compression.
    headers["accept-encoding"] = "identity";
    if (body && body.length > 0) {
      headers["content-length"] = String(body.length);
    }

    let finished = false;
    const upReq = http.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 80,
        method: rec.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upRes) => {
        const resHeaders: Array<[string, string]> = [];
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!v || HOP_BY_HOP.has(k.toLowerCase())) continue;
          if (Array.isArray(v)) {
            for (const item of v) resHeaders.push([k, item]);
          } else {
            resHeaders.push([k, v]);
          }
        }
        this.sendJson({
          type: "res_head",
          reqId,
          status: upRes.statusCode ?? 502,
          headers: resHeaders,
        });

        upRes.on("data", (chunk: Buffer) => {
          if (finished) return;
          for (let off = 0; off < chunk.length; off += RELAY_CHUNK_BYTES) {
            const slice = chunk.subarray(off, Math.min(off + RELAY_CHUNK_BYTES, chunk.length));
            this.sendJson({ type: "res_chunk", reqId, b64: slice.toString("base64") });
          }
        });
        upRes.on("end", () => {
          if (finished) return;
          finished = true;
          this.activeUpstreams.delete(reqId);
          this.sendJson({ type: "res_end", reqId });
        });
        upRes.on("error", (err) => {
          if (finished) return;
          finished = true;
          this.activeUpstreams.delete(reqId);
          this.sendJson({ type: "res_error", reqId, status: 502, message: err.message });
        });
      },
    );

    this.activeUpstreams.set(reqId, {
      abort: () => {
        finished = true;
        try {
          upReq.destroy();
        } catch {
          /* ignore */
        }
      },
    });

    upReq.on("error", (err) => {
      if (finished) return;
      finished = true;
      this.activeUpstreams.delete(reqId);
      this.sendJson({ type: "res_error", reqId, status: 502, message: `本机服务未就绪：${err.message}` });
    });

    if (body && body.length > 0) upReq.write(body);
    upReq.end();
  }
}

export class MobileConnectManager {
  private readonly configPath: string;
  private cfg: MobileConnectConfig;
  private readonly lan = new LanForwarder();
  private relay: RelayTunnelClient | null = null;
  private targetLocalUrl: string | null = null;

  constructor(private readonly dataDir = join(homedir(), ".memento", "server-data")) {
    this.configPath = join(this.dataDir, "mobile-connect.json");
    this.cfg = this.loadConfig();
  }

  get config(): MobileConnectConfig {
    return { ...this.cfg };
  }

  private loadConfig(): MobileConnectConfig {
    const fallback: MobileConnectConfig = {
      enabled: false,
      lanEnabled: true,
      relayEnabled: true,
      relayServerUrl: DEFAULT_RELAY_SERVER_URL,
      tunnelSecret: randomBytes(32).toString("hex"),
      lanPort: DEFAULT_LAN_PORT,
    };
    if (!existsSync(this.configPath)) return fallback;
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<MobileConnectConfig>;
      return {
        enabled: parsed.enabled === true,
        lanEnabled: parsed.lanEnabled !== false,
        relayEnabled: parsed.relayEnabled !== false,
        relayServerUrl:
          typeof parsed.relayServerUrl === "string" && /^https?:\/\//i.test(parsed.relayServerUrl.trim())
            ? parsed.relayServerUrl.trim().replace(/\/+$/, "")
            : DEFAULT_RELAY_SERVER_URL,
        tunnelSecret:
          typeof parsed.tunnelSecret === "string" && parsed.tunnelSecret.trim().length >= 32
            ? parsed.tunnelSecret.trim()
            : fallback.tunnelSecret,
        lanPort: typeof parsed.lanPort === "number" && parsed.lanPort >= 1024 && parsed.lanPort <= 65535 ? parsed.lanPort : DEFAULT_LAN_PORT,
      };
    } catch {
      return fallback;
    }
  }

  private saveConfig(): void {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(this.configPath, 0o600);
    } catch {
      /* windows */
    }
  }

  async syncRuntime(targetLocalUrl: string): Promise<void> {
    this.targetLocalUrl = targetLocalUrl.replace(/\/+$/, "");
    if (!this.cfg.enabled) {
      await this.stop();
      return;
    }

    if (this.cfg.lanEnabled) {
      if (!this.lan.running) {
        await this.lan.start(this.targetLocalUrl, this.cfg.lanPort);
      }
    } else {
      await this.lan.stop();
    }

    if (this.cfg.relayEnabled) {
      if (!this.relay) {
        this.relay = new RelayTunnelClient(this.cfg.relayServerUrl, this.cfg.tunnelSecret, this.targetLocalUrl);
      }
      this.relay.start(this.cfg.relayServerUrl, this.targetLocalUrl);
    } else if (this.relay) {
      this.relay.stop();
      this.relay = null;
    }
  }

  async startIfEnabled(targetLocalUrl: string): Promise<void> {
    this.targetLocalUrl = targetLocalUrl.replace(/\/+$/, "");
    if (this.cfg.enabled) {
      await this.syncRuntime(this.targetLocalUrl);
    }
  }

  async update(patch: MobileConnectUpdate, targetLocalUrl: string): Promise<MobileConnectStatus> {
    const relayChanged =
      typeof patch.relayServerUrl === "string" &&
      /^https?:\/\//i.test(patch.relayServerUrl.trim()) &&
      patch.relayServerUrl.trim().replace(/\/+$/, "") !== this.cfg.relayServerUrl;

    if (typeof patch.enabled === "boolean") this.cfg.enabled = patch.enabled;
    if (typeof patch.lanEnabled === "boolean") this.cfg.lanEnabled = patch.lanEnabled;
    if (typeof patch.relayEnabled === "boolean") this.cfg.relayEnabled = patch.relayEnabled;
    if (typeof patch.relayServerUrl === "string" && /^https?:\/\//i.test(patch.relayServerUrl.trim())) {
      this.cfg.relayServerUrl = patch.relayServerUrl.trim().replace(/\/+$/, "");
    }
    this.saveConfig();

    if (relayChanged && this.relay) {
      this.relay.stop();
      this.relay = null;
    }
    await this.syncRuntime(targetLocalUrl);
    return this.status(true, targetLocalUrl);
  }

  async stop(): Promise<void> {
    if (this.relay) {
      this.relay.stop();
      this.relay = null;
    }
    await this.lan.stop();
  }

  async status(isStandalone: boolean, targetLocalUrl: string): Promise<MobileConnectStatus> {
    const parsedPort = Number(new URL(targetLocalUrl).port) || 8770;
    const lanPort = this.lan.port;
    const lanIps = listLanAddresses();
    const lanUrls = lanPort ? lanIps.map((ip) => `http://${ip}:${lanPort}`) : [];
    const relaySt = this.relay?.status;
    const tailscale = isStandalone ? await detectTailscaleServe(parsedPort) : { installed: false, running: false, dnsName: null, serveUrl: null };
    const tunnelId = deriveTunnelId(this.cfg.tunnelSecret);
    return {
      isStandalone,
      enabled: this.cfg.enabled,
      lanEnabled: this.cfg.lanEnabled,
      lanRunning: this.lan.running,
      lanPort,
      lanUrls,
      relayEnabled: this.cfg.relayEnabled,
      relayServerUrl: this.cfg.relayServerUrl,
      relayState: this.cfg.enabled && this.cfg.relayEnabled ? (relaySt?.state ?? "connecting") : "off",
      relayApiUrl: this.cfg.enabled && this.cfg.relayEnabled ? `${this.cfg.relayServerUrl}/api/relay/t/${tunnelId}` : null,
      relayError: relaySt?.error ?? null,
      tailscale,
      deviceName: cleanDeviceName(),
    };
  }

  async enableTailscale(targetLocalUrl: string): Promise<{ ok: boolean; status: MobileConnectStatus; error?: string }> {
    const parsedPort = Number(new URL(targetLocalUrl).port) || 8770;
    const res = await enableTailscaleServe(parsedPort);
    const st = await this.status(true, targetLocalUrl);
    return { ok: res.ok, status: st, error: res.error };
  }

  /**
   * One-click pairing flow: ensures mobile access is enabled (LAN + stateless Relay),
   * mints a 90s single-use pairing code on the local standalone server, and builds `memento://pair?...`.
   */
  async createPairing(targetLocalUrl: string, localJwt: string): Promise<MobilePairResult> {
    const base = targetLocalUrl.replace(/\/+$/, "");
    if (!this.cfg.enabled) {
      this.cfg.enabled = true;
      this.saveConfig();
    }
    await this.syncRuntime(base);
    if (this.cfg.relayEnabled && this.relay) {
      await this.relay.waitUntilReady(2500);
    }

    try {
      const res = await fetch(`${base}/api/auth/pair/create`, {
        method: "POST",
        headers: { Authorization: `Bearer ${localJwt}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return {
          ok: false,
          status: await this.status(true, base),
          error: res.status === 401 ? "请先在桌面端登录本机单机账号后再生成配对二维码" : `生成配对码失败（HTTP ${res.status}）${txt ? `：${txt.slice(0, 120)}` : ""}`,
        };
      }
      const body = (await res.json()) as { code?: string; expires_in?: number };
      if (!body.code) {
        return { ok: false, status: await this.status(true, base), error: "本机服务未返回配对码" };
      }
      const st = await this.status(true, base);
      const pairUrl = buildPairingUrl({
        code: body.code,
        deviceName: st.deviceName,
        lanUrl: st.lanUrls[0] ?? null,
        tsUrl: st.tailscale.serveUrl,
        relayApiUrl: st.relayApiUrl,
        uiOrigin: st.relayApiUrl ? st.relayServerUrl : null,
      });
      return {
        ok: true,
        pairUrl,
        expiresIn: body.expires_in ?? 90,
        status: st,
      };
    } catch (err) {
      return {
        ok: false,
        status: await this.status(true, base),
        error: err instanceof Error ? err.message : "连接本机服务失败",
      };
    }
  }
}
