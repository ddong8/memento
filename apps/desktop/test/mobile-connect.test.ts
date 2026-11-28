import { mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  buildPairingUrl,
  deriveTunnelId,
  LanForwarder,
  MobileConnectManager,
  RelayTunnelClient,
} from "../src/mobile-connect";

describe("desktop mobile-connect (LAN forwarder + stateless relay client + pairing)", () => {
  let localServer: http.Server;
  let localPort = 0;
  let abortedSseCount = 0;

  beforeAll(async () => {
    localServer = http.createServer(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (req.url === "/api/auth/pair/create" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer local-jwt") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ detail: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "pairCode_1234567890abcdef", expires_in: 90 }));
        return;
      }
      if (req.url === "/api/echo" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), origin: req.headers.origin ?? null }));
        return;
      }
      if (req.url === "/api/events/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: first\n\n");
        const timer = setTimeout(() => {
          res.write("data: second\n\n");
          res.end();
        }, 25);
        req.on("close", () => {
          clearTimeout(timer);
          if (!res.writableEnded) abortedSseCount++;
        });
        return;
      }
      if (req.url === "/api/events/hang") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: open\n\n");
        req.on("close", () => {
          abortedSseCount++;
        });
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", () => resolve()));
    localPort = (localServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  it("LanForwarder proxies HTTP, SSE, and handles CORS preflight for mem.ihasy.com & LAN origins", async () => {
    const fwd = new LanForwarder();
    const port = await fwd.start(`http://127.0.0.1:${localPort}`, 0);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Origin: "https://mem.ihasy.com" },
      });
      expect(health.status).toBe(200);
      expect(health.headers.get("access-control-allow-origin")).toBe("https://mem.ihasy.com");
      expect(await health.json()).toEqual({ status: "ok" });

      const preflight = await fetch(`http://127.0.0.1:${port}/api/echo`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://192.168.1.99:8771",
          "Access-Control-Request-Method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("http://192.168.1.99:8771");

      const post = await fetch(`http://127.0.0.1:${port}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json", Origin: "https://mem.ihasy.com" },
        body: JSON.stringify({ hello: "lan" }),
      });
      expect(post.status).toBe(200);
      expect(await post.json()).toEqual({ body: { hello: "lan" }, origin: null });

      const sse = await fetch(`http://127.0.0.1:${port}/api/events/stream`);
      expect(sse.status).toBe(200);
      expect(await sse.text()).toBe("data: first\n\ndata: second\n\n");
    } finally {
      await fwd.stop();
    }
  });

  it("RelayTunnelClient connects to WSS relay, streams HTTP/SSE to localhost, and honors req_abort", async () => {
    const relaySrv = http.createServer();
    const wss = new WebSocketServer({ server: relaySrv, path: "/api/relay/connect" });
    let serverWs: import("ws").WebSocket | null = null;
    const framesByReq = new Map<string, Record<string, unknown>[]>();
    const endWaiters = new Map<string, () => void>();
    const headWaiters = new Map<string, () => void>();

    wss.on("connection", (ws) => {
      serverWs = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "ready", tunnelId: deriveTunnelId(String(msg.secret)) }));
          return;
        }
        const reqId = String(msg.reqId || "");
        if (!reqId) return;
        const arr = framesByReq.get(reqId) ?? [];
        arr.push(msg);
        framesByReq.set(reqId, arr);
        if (msg.type === "res_head") headWaiters.get(reqId)?.();
        if (msg.type === "res_end") endWaiters.get(reqId)?.();
      });
    });

    await new Promise<void>((resolve) => relaySrv.listen(0, "127.0.0.1", () => resolve()));
    const relayPort = (relaySrv.address() as AddressInfo).port;
    const secret = "a".repeat(64);
    const client = new RelayTunnelClient(`http://127.0.0.1:${relayPort}`, secret, `http://127.0.0.1:${localPort}`);

    try {
      client.start();
      const ready = await client.waitUntilReady(3000);
      expect(ready).toBe(true);
      expect(client.status.state).toBe("connected");
      expect(client.status.tunnelId).toBe(deriveTunnelId(secret));

      // 1) POST JSON
      const req1 = "req-post-1";
      const done1 = new Promise<void>((r) => endWaiters.set(req1, r));
      serverWs!.send(JSON.stringify({ type: "req_head", reqId: req1, method: "POST", path: "/api/echo", headers: { "content-type": "application/json", origin: "https://mem.ihasy.com" } }));
      serverWs!.send(JSON.stringify({ type: "req_chunk", reqId: req1, b64: Buffer.from(JSON.stringify({ ok: 1 })).toString("base64") }));
      serverWs!.send(JSON.stringify({ type: "req_end", reqId: req1 }));
      await done1;
      const body1 = Buffer.concat(
        (framesByReq.get(req1) || []).filter((f) => f.type === "res_chunk").map((f) => Buffer.from(String(f.b64), "base64")),
      ).toString("utf8");
      expect(JSON.parse(body1)).toEqual({ body: { ok: 1 }, origin: null });

      // 2) SSE stream + client abort cleanup
      const beforeAborts = abortedSseCount;
      const req2 = "req-sse-abort";
      const head2 = new Promise<void>((r) => headWaiters.set(req2, r));
      serverWs!.send(JSON.stringify({ type: "req_head", reqId: req2, method: "GET", path: "/api/events/hang", headers: {} }));
      serverWs!.send(JSON.stringify({ type: "req_end", reqId: req2 }));
      await head2;
      serverWs!.send(JSON.stringify({ type: "req_abort", reqId: req2 }));
      await new Promise((r) => setTimeout(r, 60));
      expect(abortedSseCount).toBeGreaterThan(beforeAborts);
    } finally {
      client.stop();
      wss.close();
      await new Promise<void>((resolve) => relaySrv.close(() => resolve()));
    }
  });

  it("MobileConnectManager persists secret stably and builds compact pairing URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memento-mc-"));
    try {
      const m1 = new MobileConnectManager(dir);
      // Point relay to unreachable loopback port so unit tests never touch external networks
      await m1.update({ enabled: false, relayServerUrl: "http://127.0.0.1:1", relayEnabled: false }, `http://127.0.0.1:${localPort}`);
      const pairRes = await m1.createPairing(`http://127.0.0.1:${localPort}`, "local-jwt");
      expect(pairRes.ok).toBe(true);
      expect(pairRes.pairUrl).toContain("memento://pair?");
      expect(pairRes.pairUrl).toContain("code=pairCode_1234567890abcdef");
      const secret1 = m1.config.tunnelSecret;
      await m1.stop();

      const m2 = new MobileConnectManager(dir);
      expect(m2.config.tunnelSecret).toBe(secret1);
      expect(m2.config.enabled).toBe(true);
      await m2.stop();

      const url = buildPairingUrl({
        code: "abc",
        deviceName: "Mac-mini",
        lanUrl: "http://192.168.1.5:8771/",
        tsUrl: "https://mac.tail.ts.net/",
        relayApiUrl: "https://mem.ihasy.com/api/relay/t/t_1234567890123456789012/",
        uiOrigin: "https://mem.ihasy.com/",
      });
      expect(url).toBe(
        "memento://pair?v=1&code=abc&name=Mac-mini&lan=http%3A%2F%2F192.168.1.5%3A8771&ts=https%3A%2F%2Fmac.tail.ts.net&relay=https%3A%2F%2Fmem.ihasy.com%2Fapi%2Frelay%2Ft%2Ft_1234567890123456789012&ui=https%3A%2F%2Fmem.ihasy.com",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
