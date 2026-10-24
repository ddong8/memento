import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import { IngestClient } from "../src/ingest.js";
import { ServerRoute } from "../src/server-route.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

const KEY = "k-for-device";

/** Stands in for the server's LAN address: answers lan-hello (rightly or not) and records requests. */
async function lanServer(rightKey = true) {
  const seen: { path: string; host: string | undefined; token: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seen.push({ path: url.pathname, host: req.headers.host, token: req.headers["x-collector-token"] as string | undefined });
    if (url.pathname === "/api/ingest/lan-hello") {
      const proof = createHmac("sha256", rightKey ? KEY : "someone-else").update(url.searchParams.get("challenge") ?? "").digest("hex");
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ proof }));
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ commands: [] }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const config = { serverUrl: "https://mem.example.com", token: "tok", deviceId: "dev-1", deviceName: "mac", platform: "darwin" } as CollectorConfig;

describe("LAN route to the server", () => {
  it("uses a LAN address once it proves to be the server, with the public host", async () => {
    const lan = await lanServer();
    const changes: boolean[] = [];
    const route = new ServerRoute(config.serverUrl, "dev-1", () => {}, (on) => changes.push(on));
    await route.update({ urls: [lan.url], key: KEY });
    expect(route.onLan).toBe(true);
    expect(route.target()).toEqual({ base: lan.url, host: "mem.example.com" });
    expect(changes).toEqual([true]);

    // Requests then go there, by the public host name, carrying the device token
    const ingest = new IngestClient(config, () => {}, () => Promise.reject(new Error("public URL must not be used")));
    ingest.useRoute(route);
    await ingest.pollCommands();
    expect(lan.seen.at(-1)).toMatchObject({ host: "mem.example.com", token: "tok" });
    expect(lan.seen[0]!.token).toBeUndefined(); // the handshake itself never carries the token
  });

  it("stays on the public URL when the LAN address can't prove it is the server", async () => {
    const impostor = await lanServer(false);
    const route = new ServerRoute(config.serverUrl, "dev-1");
    await route.update({ urls: [impostor.url], key: KEY });
    expect(route.onLan).toBe(false);
    expect(route.target()).toEqual({ base: "https://mem.example.com" });
    expect(impostor.seen.every((r) => r.token === undefined)).toBe(true);
  });

  it("falls back to the public URL when a LAN request fails", async () => {
    const lan = await lanServer();
    const route = new ServerRoute(config.serverUrl, "dev-1");
    await route.update({ urls: [lan.url], key: KEY });
    for (const s of servers.splice(0)) s.close(); // the LAN address goes away (left home)
    await new Promise((r) => setTimeout(r, 50));

    const publicCalls: string[] = [];
    const ingest = new IngestClient(config, () => {}, (async (url: string) => {
      publicCalls.push(String(url));
      return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch);
    ingest.useRoute(route);
    await ingest.pollCommands();
    expect(route.onLan).toBe(false);
    expect(publicCalls).toHaveLength(1);
    expect(publicCalls[0]).toMatch(/^https:\/\/mem\.example\.com\//);
  });
});
