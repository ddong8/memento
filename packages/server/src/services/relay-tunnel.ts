// Stateless blind HTTPS reverse tunnel for standalone desktop <-> mobile access.
// Zero database tables, zero disk writes, zero user data stored on the relay server.
//
// Security model:
// - Desktop holds a local 256-bit random `secret` (stored only in ~/.memento/server-data/mobile-connect.json).
// - `tunnelId` is deterministically derived as "t_" + sha256("memento-relay-v1:" + secret).base64url(0..22).
// - Only the holder of `secret` can register `tunnelId` on WSS /api/relay/connect.
// - Mobile sends standard Memento HTTP/SSE requests (with its own standalone JWT) to
//   ALL /api/relay/t/:tunnelId/* which are streamed verbatim to the connected desktop.
//
// Multi-replica support (k3s api-ts replicas >= 2):
// - Tunnel ownership is recorded in Redis via `cluster.own("relay:" + tunnelId)`.
// - If an HTTP request lands on Replica B while Desktop is connected to Replica A,
//   Replica B forwards the request via `cluster.call(ownerPod, "relay.open", ...)` and
//   receives streamed response frames in strict FIFO order on Replica B's single fixed
//   Redis pub/sub channel `${PREFIX}relay-res:${podId}`.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { cluster, OWN_TTL, PREFIX } from "./cluster";

export const RELAY_PREFIX = "relay:";
export const RELAY_MAX_REQ_BYTES = 16 * 1024 * 1024;
export const RELAY_CHUNK_BYTES = 192 * 1024;
export const RELAY_HEAD_TIMEOUT_MS = 30_000;
export const RELAY_PING_INTERVAL_MS = 25_000;
export const RELAY_IDLE_TIMEOUT_MS = 65_000;
export const RELAY_AUTH_TIMEOUT_MS = 10_000;

const REQ_HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
]);

const RES_STRIP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "x-memento-server",
]);

export function deriveTunnelId(secret: string): string {
  const digest = createHash("sha256").update(`memento-relay-v1:${secret}`, "utf8").digest("base64url");
  return `t_${digest.slice(0, 22)}`;
}

export function isValidTunnelId(id: string): boolean {
  return /^t_[A-Za-z0-9_-]{22}$/.test(id);
}

export interface RelayWsLike {
  readyState: number;
  send(data: string, cb?: (err?: Error) => void): void;
  ping?(data?: unknown): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
}

interface TunnelConn {
  tunnelId: string;
  ws: RelayWsLike;
  lastPongAt: number;
  activeReqIds: Set<string>;
}

interface LocalPendingResponse {
  kind: "local";
  tunnelId: string;
  ownerPod: string;
  settledHead: boolean;
  closed: boolean;
  headTimer: NodeJS.Timeout;
  resolveHead: (res: Response) => void;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  onCleanup: () => void;
}

interface RemoteForwardRequest {
  kind: "remote";
  tunnelId: string;
  replyPod: string;
}

type PendingEntry = LocalPendingResponse | RemoteForwardRequest;

export interface RelayClusterLike {
  readonly podId: string;
  readonly available: boolean;
  op(name: string, handler: (payload: Record<string, unknown>) => Promise<unknown> | unknown): void;
  on(channel: string, handler: (channel: string, msg: Record<string, unknown>) => Promise<void> | void): void;
  publish(channel: string, message: Record<string, unknown>): void;
  call(pod: string, op: string, payload: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  own(key: string, ttl?: number, value?: string): Promise<void>;
  disown(key: string, value?: string): Promise<void>;
  owner(key: string): Promise<string | null>;
}

function sendJson(ws: RelayWsLike, msg: Record<string, unknown>): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export class RelayTunnelManager {
  private readonly tunnels = new Map<string, TunnelConn>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly resChannel: string;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cl: RelayClusterLike = cluster) {
    this.resChannel = `${PREFIX}relay-res:${this.cl.podId}`;
    this.bindCluster();
  }

  get localCount(): number {
    return this.tunnels.size;
  }

  hasLocal(tunnelId: string): boolean {
    const conn = this.tunnels.get(tunnelId);
    return Boolean(conn && conn.ws.readyState === WebSocket.OPEN);
  }

  private bindCluster(): void {
    // Receive streamed response frames destined for HTTP requests terminated on this pod.
    this.cl.on(this.resChannel, (_ch, msg) => {
      this.handleResponseFrame(msg);
    });

    // Cross-replica RPC: Replica B asks Replica A (which holds Desktop's WS) to open a tunneled HTTP request.
    this.cl.op("relay.open", (payload) => {
      const tunnelId = String(payload.tunnelId ?? "");
      const reqId = String(payload.reqId ?? "");
      const replyPod = String(payload.replyPod ?? "");
      const method = String(payload.method ?? "GET");
      const path = String(payload.path ?? "/");
      const headers = (payload.headers && typeof payload.headers === "object" ? payload.headers : {}) as Record<string, string>;
      const bodyB64 = typeof payload.bodyB64 === "string" ? payload.bodyB64 : "";
      const done = payload.done !== false;

      const conn = this.tunnels.get(tunnelId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
        return { ok: false, reason: "offline" };
      }

      this.pending.set(reqId, { kind: "remote", tunnelId, replyPod });
      conn.activeReqIds.add(reqId);

      const sent = sendJson(conn.ws, {
        type: "req_head",
        reqId,
        method,
        path,
        headers,
      });
      if (!sent) {
        this.pending.delete(reqId);
        conn.activeReqIds.delete(reqId);
        return { ok: false, reason: "send_failed" };
      }
      if (bodyB64) {
        sendJson(conn.ws, { type: "req_chunk", reqId, b64: bodyB64 });
      }
      if (done) {
        sendJson(conn.ws, { type: "req_end", reqId });
      }
      return { ok: true };
    });

    this.cl.op("relay.chunk", (payload) => {
      const tunnelId = String(payload.tunnelId ?? "");
      const reqId = String(payload.reqId ?? "");
      const b64 = String(payload.b64 ?? "");
      const done = Boolean(payload.done);
      const conn = this.tunnels.get(tunnelId);
      if (!conn || conn.ws.readyState !== WebSocket.OPEN) return { ok: false };
      if (b64) sendJson(conn.ws, { type: "req_chunk", reqId, b64 });
      if (done) sendJson(conn.ws, { type: "req_end", reqId });
      return { ok: true };
    });

    this.cl.op("relay.abort", (payload) => {
      const tunnelId = String(payload.tunnelId ?? "");
      const reqId = String(payload.reqId ?? "");
      this.pending.delete(reqId);
      const conn = this.tunnels.get(tunnelId);
      if (conn) {
        conn.activeReqIds.delete(reqId);
        sendJson(conn.ws, { type: "req_abort", reqId });
      }
      return { ok: true };
    });
  }

  private ensureHeartbeat(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      for (const [tunnelId, conn] of [...this.tunnels.entries()]) {
        if (conn.ws.readyState !== WebSocket.OPEN || now - conn.lastPongAt > RELAY_IDLE_TIMEOUT_MS) {
          try {
            conn.ws.terminate?.();
          } catch {
            try {
              conn.ws.close(4008, "ping timeout");
            } catch {
              /* ignore */
            }
          }
          void this.unregisterTunnel(tunnelId, conn.ws);
          continue;
        }
        try {
          conn.ws.ping?.();
        } catch {
          /* ignore */
        }
      }
    }, RELAY_PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  /** Register an authenticated desktop tunnel connection on this pod. */
  async registerTunnel(secret: string, ws: RelayWsLike): Promise<string> {
    const tunnelId = deriveTunnelId(secret);
    const existing = this.tunnels.get(tunnelId);
    if (existing && existing.ws !== ws) {
      this.failActiveRequests(existing, 502, "Desktop tunnel reconnected");
      try {
        existing.ws.close(4001, "replaced");
      } catch {
        /* ignore */
      }
    }
    const conn: TunnelConn = {
      tunnelId,
      ws,
      lastPongAt: Date.now(),
      activeReqIds: new Set(),
    };
    this.tunnels.set(tunnelId, conn);
    this.ensureHeartbeat();
    await this.cl.own(`${RELAY_PREFIX}${tunnelId}`, OWN_TTL);
    return tunnelId;
  }

  async unregisterTunnel(tunnelId: string, ws: RelayWsLike): Promise<void> {
    const cur = this.tunnels.get(tunnelId);
    if (!cur || cur.ws !== ws) return;
    this.tunnels.delete(tunnelId);
    this.failActiveRequests(cur, 502, "Desktop tunnel disconnected");
    await this.cl.disown(`${RELAY_PREFIX}${tunnelId}`);
  }

  private failActiveRequests(conn: TunnelConn, status: number, message: string): void {
    for (const reqId of [...conn.activeReqIds]) {
      conn.activeReqIds.delete(reqId);
      const entry = this.pending.get(reqId);
      if (!entry) continue;
      if (entry.kind === "remote") {
        this.pending.delete(reqId);
        this.cl.publish(`${PREFIX}relay-res:${entry.replyPod}`, {
          type: "res_error",
          reqId,
          status,
          message,
        });
      } else {
        this.handleResponseFrame({ type: "res_error", reqId, status, message });
      }
    }
  }

  /** Handle a JSON frame sent by a connected desktop client. */
  handleDesktopFrame(tunnelId: string, frame: Record<string, unknown>): void {
    const conn = this.tunnels.get(tunnelId);
    if (conn) conn.lastPongAt = Date.now();
    const type = String(frame.type ?? "");
    if (type === "pong") return;
    if (type === "ping") {
      if (conn) sendJson(conn.ws, { type: "pong" });
      return;
    }

    const reqId = String(frame.reqId ?? "");
    if (!reqId) return;
    const entry = this.pending.get(reqId);
    if (!entry) return;

    const isTerminal = type === "res_end" || type === "res_error";
    if (isTerminal && conn) {
      conn.activeReqIds.delete(reqId);
    }

    if (entry.kind === "remote") {
      if (isTerminal) this.pending.delete(reqId);
      this.cl.publish(`${PREFIX}relay-res:${entry.replyPod}`, {
        type,
        reqId,
        status: frame.status,
        headers: frame.headers,
        b64: frame.b64,
        message: frame.message,
      });
      return;
    }

    this.handleResponseFrame(frame);
  }

  private handleResponseFrame(frame: Record<string, unknown>): void {
    const reqId = String(frame.reqId ?? "");
    const entry = this.pending.get(reqId);
    if (!entry || entry.kind !== "local") return;

    const type = String(frame.type ?? "");
    if (type === "res_head") {
      if (entry.settledHead || entry.closed) return;
      entry.settledHead = true;
      clearTimeout(entry.headTimer);

      const rawStatus = Number(frame.status);
      const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 502;
      const outHeaders = new Headers();
      if (Array.isArray(frame.headers)) {
        for (const pair of frame.headers) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const k = String(pair[0] ?? "");
          const v = String(pair[1] ?? "");
          if (!k || RES_STRIP_HEADERS.has(k.toLowerCase())) continue;
          try {
            outHeaders.append(k, v);
          } catch {
            /* skip invalid header */
          }
        }
      } else if (frame.headers && typeof frame.headers === "object") {
        for (const [k, v] of Object.entries(frame.headers as Record<string, unknown>)) {
          if (!k || RES_STRIP_HEADERS.has(k.toLowerCase())) continue;
          if (Array.isArray(v)) {
            for (const item of v) {
              try {
                outHeaders.append(k, String(item));
              } catch {
                /* skip */
              }
            }
          } else if (v !== undefined && v !== null) {
            try {
              outHeaders.set(k, String(v));
            } catch {
              /* skip */
            }
          }
        }
      }
      const ct = (outHeaders.get("content-type") || "").toLowerCase();
      if (ct.includes("text/event-stream")) {
        outHeaders.set("cache-control", "no-cache, no-transform");
        outHeaders.set("x-accel-buffering", "no");
      }

      const bodyless = status === 204 || status === 304 || status === 205;
      if (bodyless) {
        entry.closed = true;
        this.pending.delete(reqId);
        entry.onCleanup();
        entry.resolveHead(new Response(null, { status, headers: outHeaders }));
        return;
      }

      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          entry.controller = controller;
        },
        cancel: () => {
          if (entry.closed) return;
          entry.closed = true;
          this.pending.delete(reqId);
          entry.onCleanup();
          this.sendAbort(entry.tunnelId, entry.ownerPod, reqId);
        },
      });
      entry.resolveHead(new Response(stream, { status, headers: outHeaders }));
      return;
    }

    if (type === "res_chunk") {
      if (entry.closed || !entry.controller) return;
      const b64 = typeof frame.b64 === "string" ? frame.b64 : "";
      if (!b64) return;
      try {
        entry.controller.enqueue(new Uint8Array(Buffer.from(b64, "base64")));
      } catch {
        /* consumer closed */
      }
      return;
    }

    if (type === "res_end") {
      if (entry.closed) return;
      entry.closed = true;
      clearTimeout(entry.headTimer);
      this.pending.delete(reqId);
      entry.onCleanup();
      if (!entry.settledHead) {
        entry.settledHead = true;
        entry.resolveHead(new Response(null, { status: 204 }));
      } else {
        try {
          entry.controller?.close();
        } catch {
          /* already closed */
        }
      }
      return;
    }

    if (type === "res_error") {
      if (entry.closed) return;
      entry.closed = true;
      clearTimeout(entry.headTimer);
      this.pending.delete(reqId);
      entry.onCleanup();
      const status = Number(frame.status) >= 400 && Number(frame.status) <= 599 ? Number(frame.status) : 502;
      const message = String(frame.message || "Desktop relay error");
      if (!entry.settledHead) {
        entry.settledHead = true;
        entry.resolveHead(
          new Response(JSON.stringify({ detail: message, code: "relay_upstream_error" }), {
            status,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
        );
      } else {
        try {
          entry.controller?.error(new Error(message));
        } catch {
          /* already errored/closed */
        }
      }
    }
  }

  private sendAbort(tunnelId: string, ownerPod: string, reqId: string): void {
    if (ownerPod === this.cl.podId) {
      const conn = this.tunnels.get(tunnelId);
      if (conn) {
        conn.activeReqIds.delete(reqId);
        sendJson(conn.ws, { type: "req_abort", reqId });
      }
      return;
    }
    void this.cl.call(ownerPod, "relay.abort", { tunnelId, reqId }, 5000).catch(() => {});
  }

  /** Forward an incoming HTTP/SSE request to the connected desktop (local pod or peer replica). */
  async forwardHttp(tunnelId: string, req: Request, forwardPath: string): Promise<Response> {
    if (!isValidTunnelId(tunnelId)) {
      return new Response(JSON.stringify({ detail: "Invalid tunnel ID", code: "invalid_tunnel" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    const localConn = this.tunnels.get(tunnelId);
    let ownerPod: string | null = localConn && localConn.ws.readyState === WebSocket.OPEN ? this.cl.podId : null;
    if (!ownerPod) {
      const remoteOwner = await this.cl.owner(`${RELAY_PREFIX}${tunnelId}`);
      if (remoteOwner && remoteOwner !== this.cl.podId) {
        ownerPod = remoteOwner;
      }
    }
    if (!ownerPod) {
      return new Response(
        JSON.stringify({ detail: "桌面端单机服务当前未在线，请确认电脑端 Memento 已启动并开启手机远程连接", code: "tunnel_offline" }),
        {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        },
      );
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    let bodyBuf = Buffer.alloc(0);
    if (hasBody) {
      const clHeader = Number(req.headers.get("content-length") || "0");
      if (Number.isFinite(clHeader) && clHeader > RELAY_MAX_REQ_BYTES) {
        return new Response(JSON.stringify({ detail: "Request payload exceeds relay limit (16MB)", code: "payload_too_large" }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      const ab = await req.arrayBuffer();
      if (ab.byteLength > RELAY_MAX_REQ_BYTES) {
        return new Response(JSON.stringify({ detail: "Request payload exceeds relay limit (16MB)", code: "payload_too_large" }), {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      bodyBuf = Buffer.from(ab);
    }

    const fwdHeaders: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (REQ_HOP_BY_HOP.has(k.toLowerCase())) return;
      fwdHeaders[k.toLowerCase()] = v;
    });

    const reqId = randomUUID().replaceAll("-", "");
    const targetOwner = ownerPod;

    return new Promise<Response>((resolve) => {
      const onClientAbort = () => {
        const cur = this.pending.get(reqId);
        if (!cur || cur.kind !== "local" || cur.closed) return;
        cur.closed = true;
        clearTimeout(cur.headTimer);
        this.pending.delete(reqId);
        try {
          cur.controller?.close();
        } catch {
          /* ignore */
        }
        this.sendAbort(tunnelId, targetOwner, reqId);
      };
      req.signal?.addEventListener("abort", onClientAbort, { once: true });

      const onCleanup = () => {
        req.signal?.removeEventListener("abort", onClientAbort);
      };

      const headTimer = setTimeout(() => {
        const cur = this.pending.get(reqId);
        if (!cur || cur.kind !== "local" || cur.settledHead) return;
        cur.settledHead = true;
        cur.closed = true;
        this.pending.delete(reqId);
        onCleanup();
        this.sendAbort(tunnelId, targetOwner, reqId);
        resolve(
          new Response(JSON.stringify({ detail: "桌面端响应超时", code: "tunnel_timeout" }), {
            status: 504,
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
        );
      }, RELAY_HEAD_TIMEOUT_MS);
      headTimer.unref?.();

      const entry: LocalPendingResponse = {
        kind: "local",
        tunnelId,
        ownerPod: targetOwner,
        settledHead: false,
        closed: false,
        headTimer,
        resolveHead: resolve,
        controller: null,
        onCleanup,
      };
      this.pending.set(reqId, entry);

      const failEarly = (status: number, message: string, code: string) => {
        if (entry.settledHead) return;
        entry.settledHead = true;
        entry.closed = true;
        clearTimeout(headTimer);
        this.pending.delete(reqId);
        onCleanup();
        resolve(
          new Response(JSON.stringify({ detail: message, code }), {
            status,
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
          }),
        );
      };

      if (targetOwner === this.cl.podId) {
        const conn = this.tunnels.get(tunnelId);
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
          failEarly(502, "桌面端单机服务当前未在线", "tunnel_offline");
          return;
        }
        conn.activeReqIds.add(reqId);
        if (!sendJson(conn.ws, { type: "req_head", reqId, method: req.method, path: forwardPath, headers: fwdHeaders })) {
          conn.activeReqIds.delete(reqId);
          failEarly(502, "隧道连接已断开", "tunnel_offline");
          return;
        }
        for (let off = 0; off < bodyBuf.length; off += RELAY_CHUNK_BYTES) {
          const slice = bodyBuf.subarray(off, Math.min(off + RELAY_CHUNK_BYTES, bodyBuf.length));
          sendJson(conn.ws, { type: "req_chunk", reqId, b64: slice.toString("base64") });
        }
        sendJson(conn.ws, { type: "req_end", reqId });
        return;
      }

      // Cross-replica dispatch to ownerPod via Redis Cluster RPC
      void (async () => {
        try {
          const singleChunk = bodyBuf.length <= RELAY_CHUNK_BYTES;
          const openRes = (await this.cl.call(
            targetOwner,
            "relay.open",
            {
              tunnelId,
              reqId,
              replyPod: this.cl.podId,
              method: req.method,
              path: forwardPath,
              headers: fwdHeaders,
              bodyB64: singleChunk && bodyBuf.length > 0 ? bodyBuf.toString("base64") : "",
              done: singleChunk,
            },
            10_000,
          )) as { ok?: boolean } | null;
          if (!openRes?.ok) {
            failEarly(502, "桌面端单机服务当前未在线", "tunnel_offline");
            return;
          }
          if (!singleChunk) {
            for (let off = 0; off < bodyBuf.length; off += RELAY_CHUNK_BYTES) {
              const end = Math.min(off + RELAY_CHUNK_BYTES, bodyBuf.length);
              const slice = bodyBuf.subarray(off, end);
              const res = (await this.cl.call(
                targetOwner,
                "relay.chunk",
                { tunnelId, reqId, b64: slice.toString("base64"), done: end >= bodyBuf.length },
                10_000,
              )) as { ok?: boolean } | null;
              if (!res?.ok) {
                failEarly(502, "桌面端连接已中断", "tunnel_offline");
                return;
              }
            }
          }
        } catch {
          failEarly(502, "桌面端单机服务当前未在线", "tunnel_offline");
        }
      })();
    });
  }

  /** Attach WSS /api/relay/connect onto a Node HTTP server. */
  attachWebSocket(server: HttpServer): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const rawUrl = req.url || "/";
      const pathname = new URL(rawUrl, "http://localhost").pathname;
      if (pathname !== "/api/relay/connect") return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.handleWsConnection(ws);
      });
    });
    return wss;
  }

  handleWsConnection(ws: WebSocket): void {
    let authedTunnelId: string | null = null;
    const authTimer = setTimeout(() => {
      if (!authedTunnelId) {
        try {
          ws.close(4003, "auth timeout");
        } catch {
          /* ignore */
        }
      }
    }, RELAY_AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    ws.on("pong", () => {
      if (authedTunnelId) {
        const conn = this.tunnels.get(authedTunnelId);
        if (conn && conn.ws === ws) conn.lastPongAt = Date.now();
      }
    });

    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }

      if (!authedTunnelId) {
        if (frame.type !== "auth" || typeof frame.secret !== "string" || frame.secret.trim().length < 32 || frame.secret.length > 256) {
          clearTimeout(authTimer);
          sendJson(ws, { type: "error", message: "invalid relay secret" });
          ws.close(4003, "invalid auth");
          return;
        }
        const secret = frame.secret.trim();
        clearTimeout(authTimer);
        void this.registerTunnel(secret, ws).then((tunnelId) => {
          authedTunnelId = tunnelId;
          sendJson(ws, { type: "ready", tunnelId });
        });
        return;
      }

      this.handleDesktopFrame(authedTunnelId, frame);
    });

    const cleanup = () => {
      clearTimeout(authTimer);
      if (authedTunnelId) {
        const id = authedTunnelId;
        authedTunnelId = null;
        void this.unregisterTunnel(id, ws);
      }
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  close(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const [tunnelId, conn] of [...this.tunnels.entries()]) {
      this.failActiveRequests(conn, 503, "Relay server shutting down");
      try {
        conn.ws.close(1001, "shutting down");
      } catch {
        /* ignore */
      }
      this.tunnels.delete(tunnelId);
      void this.cl.disown(`${RELAY_PREFIX}${tunnelId}`).catch(() => {});
    }
  }
}

export const relayTunnels = new RelayTunnelManager();
