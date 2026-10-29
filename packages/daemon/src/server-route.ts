import { createHmac, randomBytes } from "node:crypto";
import http from "node:http";

/** The server's LAN addresses, as the heartbeat hands them out. */
export interface LanInfo {
  urls: string[];
  /** Per-device key, sent over TLS: lan-hello proves the LAN address knows it. */
  key: string;
}

type Log = (message: string) => void;

const PROBE_EVERY_MS = 5 * 60_000;

/**
 * Where this device reaches the server: on the server's LAN directly (fast, and off the small public
 * link), else through the public URL. A LAN address is only used once it proves to be this server
 * (lan-hello: the HMAC of a fresh challenge under the key the heartbeat gave over TLS), because
 * requests then carry the device token over plain HTTP. Any failure there falls back to the public URL
 * until the next probe.
 */
export class ServerRoute {
  private lan: { url: string; host: string } | null = null;
  private info: LanInfo | null = null;
  private checkedAt = 0;

  constructor(
    private publicUrl: string,
    private readonly deviceId: string,
    private readonly log: Log = () => {},
    /** Called when the route switches between the LAN and the public URL. */
    private readonly onChange: (onLan: boolean) => void = () => {},
  ) {}

  setPublicUrl(url: string): void {
    this.publicUrl = url;
  }

  get onLan(): boolean {
    return this.lan !== null;
  }

  /** Base URL for the next request, and the Host header it needs when that's a LAN address. */
  target(): { base: string; host?: string } {
    return this.lan ? { base: this.lan.url, host: this.lan.host } : { base: this.publicUrl };
  }

  /** From the heartbeat: probes when the addresses changed (else at most every five minutes). */
  async update(info: LanInfo | undefined): Promise<void> {
    if (!info?.key || !Array.isArray(info.urls) || !info.urls.length) {
      this.info = null;
      this.drop("服务器没有提供内网地址");
      return;
    }
    const changed = JSON.stringify(info) !== JSON.stringify(this.info);
    this.info = info;
    if (changed || (!this.lan && Date.now() - this.checkedAt >= PROBE_EVERY_MS)) await this.probe();
  }

  /** Tries the LAN addresses in turn; true when one answered as this server. */
  async probe(): Promise<boolean> {
    this.checkedAt = Date.now();
    const info = this.info;
    if (!info) return false;
    for (const url of info.urls) {
      if (await this.verify(url, info.key)) {
        if (this.lan?.url !== url) {
          this.lan = { url, host: new URL(this.publicUrl).host };
          this.log(`Reaching the server on the LAN (${url})`);
          this.onChange(true);
        }
        return true;
      }
    }
    this.drop("内网地址连不上或不是这台服务器");
    return false;
  }

  /** Probes again if it has been a while (called on a timer). */
  async maybeProbe(): Promise<void> {
    if (this.info && !this.lan && Date.now() - this.checkedAt >= PROBE_EVERY_MS) await this.probe();
  }

  /** Back to the public URL, after a LAN request or connection failed. */
  drop(reason: string): void {
    if (!this.lan) return;
    this.lan = null;
    this.log(`Back to the public server URL: ${reason}`);
    this.onChange(false);
  }

  private async verify(url: string, key: string): Promise<boolean> {
    const challenge = randomBytes(16).toString("hex");
    const query = `device=${encodeURIComponent(this.deviceId)}&challenge=${challenge}`;
    try {
      const res = await hostFetch(`${url}/api/ingest/lan-hello?${query}`, { timeoutMs: 1500 }, new URL(this.publicUrl).host);
      if (!res.ok) return false;
      const { proof } = (await res.json()) as { proof?: string };
      return proof === createHmac("sha256", key).update(challenge).digest("hex");
    } catch {
      return false;
    }
  }
}

/**
 * fetch() over plain HTTP with an explicit Host header, which the global fetch ignores: the LAN address
 * routes to memento by the public host name, as the public entry's requests do.
 */
export function hostFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number },
  host: string,
): Promise<Response> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname.replace(/^\[|\]$/g, ""),
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? "GET",
        headers: {
          ...init.headers,
          host,
          ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}),
        },
        timeout: init.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          const empty = status === 204 || status === 205 || status === 304 || chunks.length === 0;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("LAN request timed out")));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
