// Tests for the stateless blind HTTPS reverse tunnel (/api/relay) and one-time mobile pairing codes (/api/auth/pair/*).
import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { createApp } from "../src/app";
import { createAccessToken } from "../src/auth/jwt";
import { loadSettings } from "../src/config";
import type { Deps } from "../src/context";
import { attachRelayWebSocket } from "../src/routes/relay";
import { attachDeviceWebSocket } from "../src/routes/tasks";
import { deriveTunnelId, isValidTunnelId, type RelayClusterLike, RelayTunnelManager, relayTunnels } from "../src/services/relay-tunnel";

/** Minimal in-memory cluster bus simulating two k3s api-ts replicas over Redis. */
class MockClusterBus {
  readonly ownership = new Map<string, string>();
  readonly pods = new Map<string, MockClusterNode>();

  node(podId: string): MockClusterNode {
    const n = new MockClusterNode(podId, this);
    this.pods.set(podId, n);
    return n;
  }
}

class MockClusterNode implements RelayClusterLike {
  readonly available = true;
  private readonly ops = new Map<string, (payload: Record<string, unknown>) => Promise<unknown> | unknown>();
  private readonly subs = new Map<string, (channel: string, msg: Record<string, unknown>) => Promise<void> | void>();

  constructor(
    readonly podId: string,
    private readonly bus: MockClusterBus,
  ) {}

  op(name: string, handler: (payload: Record<string, unknown>) => Promise<unknown> | unknown): void {
    this.ops.set(name, handler);
  }

  on(channel: string, handler: (channel: string, msg: Record<string, unknown>) => Promise<void> | void): void {
    this.subs.set(channel, handler);
  }

  publish(channel: string, message: Record<string, unknown>): void {
    // Preserve async FIFO delivery just like Redis pub/sub
    queueMicrotask(() => {
      for (const pod of this.bus.pods.values()) {
        const h = pod.subs.get(channel);
        if (h) void h(channel, { ...message, origin: this.podId });
      }
    });
  }

  async call(pod: string, op: string, payload: Record<string, unknown>): Promise<unknown> {
    const target = this.bus.pods.get(pod);
    if (!target) throw new Error(`pod ${pod} unreachable`);
    const h = target.ops.get(op);
    if (!h) throw new Error(`unknown op ${op}`);
    return h(payload);
  }

  async own(key: string): Promise<void> {
    this.bus.ownership.set(key, this.podId);
  }

  async disown(key: string): Promise<void> {
    if (this.bus.ownership.get(key) === this.podId) this.bus.ownership.delete(key);
  }

  async owner(key: string): Promise<string | null> {
    return this.bus.ownership.get(key) ?? null;
  }
}

function makeFakeApp(userRow?: { id: string; email: string; name: string | null; role: string; status: string; collectorToken: string; avatarUrl: string | null }) {
  const settings = loadSettings({
    MEMENTO_DEBUG: "1",
    MEMENTO_REDIS_URL: "none",
    MEMENTO_SECRET_KEY: "test-pair-secret-key-at-least-32-chars",
    MEMENTO_BUILD_SHA: "relay-test",
  });
  const fakeDb = {
    execute: async () => [{ "?column?": 1 }],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (userRow ? [userRow] : []),
        }),
        limit: async () => (userRow ? [userRow] : []),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [],
      }),
    }),
  } as unknown as Deps["db"];
  return {
    settings,
    app: createApp({ settings, db: fakeDb, redis: () => null }),
  };
}

describe("stateless blind relay tunnel", () => {
  it("derives deterministic, unguessable tunnel IDs from 256-bit secrets", () => {
    const s1 = randomBytes(32).toString("hex");
    const s2 = randomBytes(32).toString("hex");
    const id1 = deriveTunnelId(s1);
    const id2 = deriveTunnelId(s2);
    expect(id1).toBe(deriveTunnelId(s1));
    expect(id1).not.toBe(id2);
    expect(isValidTunnelId(id1)).toBe(true);
    expect(isValidTunnelId("t_short")).toBe(false);
    expect(isValidTunnelId("../evil")).toBe(false);
  });

  it("returns 502 tunnel_offline when desktop is not connected, and 400 on malformed tunnelId", async () => {
    const { app } = makeFakeApp();
    const bad = await app.request("/api/relay/t/not-valid/health");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("invalid_tunnel");

    const validId = deriveTunnelId(randomBytes(32).toString("hex"));
    const offline = await app.request(`/api/relay/t/${validId}/health`);
    expect(offline.status).toBe(502);
    expect(((await offline.json()) as { code: string }).code).toBe("tunnel_offline");
  });

  describe("WebSocket + HTTP/SSE end-to-end (coexisting with /api/tasks/ws)", () => {
    let server: http.Server;
    let port = 0;

    beforeAll(async () => {
      const { settings, app } = makeFakeApp();
      const deps: Deps = {
        settings,
        db: { execute: async () => [{ "?column?": 1 }] } as unknown as Deps["db"],
        redis: () => null,
      };
      server = http.createServer(async (req, res) => {
        const url = `http://127.0.0.1:${port}${req.url || "/"}`;
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
        const hasBody = req.method !== "GET" && req.method !== "HEAD";
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
          else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
        }
        const webReq = new Request(url, {
          method: req.method,
          headers,
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });
        const webRes = await app.fetch(webReq);
        const outH: Record<string, string> = {};
        webRes.headers.forEach((v, k) => {
          outH[k] = v;
        });
        res.writeHead(webRes.status, outH);
        if (!webRes.body) {
          res.end();
          return;
        }
        const reader = webRes.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
        res.end();
      });
      attachDeviceWebSocket(server, deps);
      attachRelayWebSocket(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      relayTunnels.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("rejects short/invalid relay secret on WSS /api/relay/connect", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/connect`);
      const closed = await new Promise<{ code: number }>((resolve) => {
        ws.on("open", () => ws.send(JSON.stringify({ type: "auth", secret: "too-short" })));
        ws.on("close", (code) => resolve({ code }));
      });
      expect(closed.code).toBe(4003);
    });

    it("forwards JSON POST bodies, SSE token streaming, and client aborts cleanly", async () => {
      const secret = randomBytes(32).toString("hex");
      const expectedId = deriveTunnelId(secret);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay/connect`);
      const reqBodies = new Map<string, Buffer[]>();
      const abortedReqIds: string[] = [];

      const readyId = await new Promise<string>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("open", () => ws.send(JSON.stringify({ type: "auth", secret })));
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          if (msg.type === "ready") {
            resolve(String(msg.tunnelId));
            return;
          }
          if (msg.type === "req_head") {
            reqBodies.set(String(msg.reqId), []);
            (reqBodies as unknown as Map<string, unknown>).set(`meta:${msg.reqId}`, msg);
            return;
          }
          if (msg.type === "req_chunk") {
            const arr = reqBodies.get(String(msg.reqId));
            if (arr) arr.push(Buffer.from(String(msg.b64 || ""), "base64"));
            return;
          }
          if (msg.type === "req_abort") {
            abortedReqIds.push(String(msg.reqId));
            return;
          }
          if (msg.type === "req_end") {
            const reqId = String(msg.reqId);
            const meta = (reqBodies as unknown as Map<string, { method: string; path: string; headers: Record<string, string> }>).get(`meta:${reqId}`)!;
            const body = Buffer.concat(reqBodies.get(reqId) || []).toString("utf8");
            reqBodies.delete(reqId);

            if (meta.path === "/api/echo") {
              const payload = JSON.stringify({ method: meta.method, auth: meta.headers.authorization, body: JSON.parse(body || "{}") });
              ws.send(JSON.stringify({ type: "res_head", reqId, status: 200, headers: { "content-type": "application/json" } }));
              ws.send(JSON.stringify({ type: "res_chunk", reqId, b64: Buffer.from(payload).toString("base64") }));
              ws.send(JSON.stringify({ type: "res_end", reqId }));
              return;
            }
            if (meta.path === "/api/events/stream?q=1") {
              ws.send(JSON.stringify({ type: "res_head", reqId, status: 200, headers: { "content-type": "text/event-stream" } }));
              ws.send(JSON.stringify({ type: "res_chunk", reqId, b64: Buffer.from("data: hello\n\n").toString("base64") }));
              setTimeout(() => {
                ws.send(JSON.stringify({ type: "res_chunk", reqId, b64: Buffer.from("data: world\n\n").toString("base64") }));
                ws.send(JSON.stringify({ type: "res_end", reqId }));
              }, 20);
              return;
            }
          }
        });
      });

      expect(readyId).toBe(expectedId);

      // 1) POST JSON round-trip
      const postRes = await fetch(`http://127.0.0.1:${port}/api/relay/t/${readyId}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer standalone-jwt" },
        body: JSON.stringify({ ping: "pong" }),
      });
      expect(postRes.status).toBe(200);
      expect(await postRes.json()).toEqual({
        method: "POST",
        auth: "Bearer standalone-jwt",
        body: { ping: "pong" },
      });

      // 2) SSE streaming round-trip (verify unbuffered streaming + headers)
      const sseRes = await fetch(`http://127.0.0.1:${port}/api/relay/t/${readyId}/api/events/stream?q=1`);
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      expect(sseRes.headers.get("x-accel-buffering")).toBe("no");
      expect(await sseRes.text()).toBe("data: hello\n\ndata: world\n\n");

      ws.close();
      await new Promise((r) => setTimeout(r, 30));
      expect(relayTunnels.hasLocal(readyId)).toBe(false);
      expect(abortedReqIds).toHaveLength(0);
    });
  });

  it("forwards HTTP + streaming SSE across two k3s replicas via Cluster RPC & FIFO pub/sub", async () => {
    const bus = new MockClusterBus();
    const replicaA = new RelayTunnelManager(bus.node("pod-a"));
    const replicaB = new RelayTunnelManager(bus.node("pod-b"));

    const secret = randomBytes(32).toString("hex");
    const receivedFrames: Record<string, unknown>[] = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        receivedFrames.push(frame);
        if (frame.type === "req_end") {
          const reqId = String(frame.reqId);
          replicaA.handleDesktopFrame(tunnelId, {
            type: "res_head",
            reqId,
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
          replicaA.handleDesktopFrame(tunnelId, {
            type: "res_chunk",
            reqId,
            b64: Buffer.from("data: chunk-1\n\n").toString("base64"),
          });
          replicaA.handleDesktopFrame(tunnelId, {
            type: "res_chunk",
            reqId,
            b64: Buffer.from("data: chunk-2\n\n").toString("base64"),
          });
          replicaA.handleDesktopFrame(tunnelId, { type: "res_end", reqId });
        }
      },
      close() {},
    };

    // Desktop connects to Replica A
    const tunnelId = await replicaA.registerTunnel(secret, fakeWs);
    expect(replicaA.hasLocal(tunnelId)).toBe(true);
    expect(replicaB.hasLocal(tunnelId)).toBe(false);

    // Phone HTTP SSE request hits Replica B!
    const res = await replicaB.forwardHttp(
      tunnelId,
      new Request("https://mem.ihasy.com/api/relay/t/x/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: "hi" }),
      }),
      "/api/ask",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe("data: chunk-1\n\ndata: chunk-2\n\n");
    expect(receivedFrames.some((f) => f.type === "req_head" && f.path === "/api/ask")).toBe(true);

    replicaA.close();
    replicaB.close();
  });
});

describe("one-time mobile pairing codes (/api/auth/pair/*)", () => {
  it("creates a 90s single-use code and exchanges it once for a JWT", async () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "owner@local.memento",
      name: "Local Owner",
      role: "owner",
      status: "active",
      collectorToken: "collector-tok-123",
      avatarUrl: null,
    };
    const { settings, app } = makeFakeApp(user);
    const jwt = await createAccessToken(user.id, user.role, settings.secretKey, 60, settings.algorithm);

    // Create requires auth
    const unauth = await app.request("/api/auth/pair/create", { method: "POST" });
    expect(unauth.status).toBe(401);

    const created = await app.request("/api/auth/pair/create", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(created.status).toBe(200);
    const { code, expires_in } = (await created.json()) as { code: string; expires_in: number };
    expect(code.length).toBeGreaterThanOrEqual(24);
    expect(expires_in).toBe(90);

    // Claim once succeeds
    const claimed = await app.request("/api/auth/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(claimed.status).toBe(200);
    const body = (await claimed.json()) as { access_token: string; user_id: string; role: string; user: { email: string } };
    expect(body.access_token.split(".")).toHaveLength(3);
    expect(body.user_id).toBe(user.id);
    expect(body.role).toBe("owner");
    expect(body.user.email).toBe(user.email);

    // Replay is rejected (single-use)
    const replay = await app.request("/api/auth/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(replay.status).toBe(401);
  });
});
