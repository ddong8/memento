import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { CollectorConfig } from "../src/config.js";
import { IngestClient } from "../src/ingest.js";
import { hostFetch } from "../src/server-route.js";

// Uploads go gzip-compressed: a slice of a log is about a sixth of its size, through an uplink to the
// public entry of about 400 KB/s (10-30: a Windows collector sending a 150 MB log again took hours).

const config = { serverUrl: "https://mem.example.com", token: "tok", deviceId: "dev-1", deviceName: "pc", platform: "win32" } as unknown as CollectorConfig;

type Call = { url: string; headers: Record<string, string>; body: unknown };

function client(reply: (call: Call, n: number) => Response = () => Response.json({})) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), headers: init.headers as Record<string, string>, body: init.body };
    calls.push(call);
    return reply(call, calls.length);
  }) as typeof fetch;
  return { ingest: new IngestClient(config, () => {}, fetchImpl), calls };
}

const slice = (text: string) => ({
  toolId: "claude_code",
  category: "conversation",
  contentType: "jsonl",
  relativePath: "projects/-w-app/s.jsonl",
  content: text,
  contentHash: "h",
  offset: 0,
  endOffset: text.length,
  mode: "full" as const,
});

const inflated = (call: Call) => JSON.parse(gunzipSync(call.body as Uint8Array).toString("utf8"));

describe("compressed uploads", () => {
  it("a slice goes up gzip-compressed, a small request plain", async () => {
    const { ingest, calls } = client();
    const text = Array.from({ length: 200 }, (_, i) => JSON.stringify({ type: "user", message: { content: `第${i}行` } })).join("\n");
    expect((await ingest.ingestDocument(slice(text))).ok).toBe(true);
    expect(calls[0]!.headers["Content-Encoding"]).toBe("gzip");
    expect(inflated(calls[0]!)).toMatchObject({ tool: "claude_code", content: text, end_offset: text.length });
    expect((calls[0]!.body as Uint8Array).length).toBeLessThan(Buffer.byteLength(text) / 3);

    await ingest.sendHeartbeat({ queued: 0 });
    expect(calls[1]!.headers["Content-Encoding"]).toBeUndefined();
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ collect: { queued: 0 } });
  });

  it("a server that can't read them gets the same request plain, and plain ones after that", async () => {
    const { ingest, calls } = client((call) =>
      call.headers["Content-Encoding"] ? Response.json({ detail: "There was an error parsing the body" }, { status: 400 }) : Response.json({}),
    );
    const text = "x".repeat(20_000);
    expect((await ingest.ingestDocument(slice(text))).ok).toBe(true);
    expect(calls.map((c) => c.headers["Content-Encoding"] ?? "plain")).toEqual(["gzip", "plain"]);
    expect(JSON.parse(calls[1]!.body as string)).toMatchObject({ content: text });

    expect((await ingest.ingestDocument(slice(text))).ok).toBe(true);
    expect(calls.map((c) => c.headers["Content-Encoding"] ?? "plain")).toEqual(["gzip", "plain", "plain"]);
  });

  it("a request the server turns down either way stays compressed", async () => {
    const { ingest, calls } = client(() => Response.json({ detail: "bad" }, { status: 422 }));
    const text = "x".repeat(20_000);
    expect((await ingest.ingestDocument(slice(text))).ok).toBe(false);
    await ingest.ingestDocument(slice(text));
    expect(calls.map((c) => c.headers["Content-Encoding"] ?? "plain")).toEqual(["gzip", "plain", "gzip", "plain"]);
  });

  it("goes over the LAN route whole, with its compressed length", async () => {
    const got: { length?: string; encoding?: string; host?: string; body?: Buffer } = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        Object.assign(got, { length: req.headers["content-length"], encoding: req.headers["content-encoding"], host: req.headers.host, body: Buffer.concat(chunks) });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const body = new Uint8Array(gzipSync("第一行\n".repeat(5000)));
      const res = await hostFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ingest/file`, {
        method: "POST",
        headers: { "Content-Encoding": "gzip" },
        body,
      }, "mem.example.com");
      expect(res.status).toBe(200);
      expect(got).toMatchObject({ length: String(body.length), encoding: "gzip", host: "mem.example.com" });
      expect(gunzipSync(got.body!).toString("utf8")).toBe("第一行\n".repeat(5000));
    } finally {
      server.close();
    }
  });
});
