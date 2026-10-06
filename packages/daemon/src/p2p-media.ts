import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";

type Log = (message: string) => void;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/mp4",
  ".wav": "audio/wav",
};

/** The first global unicast IPv6 address on this machine (ISP prefixes change, so ask again when needed). */
export function findGlobalIpv6(): string | undefined {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === "IPv6" && !a.internal)
    .map((a) => a.address);
  const linkLocal = (ip: string) => /^fe[89ab]/i.test(ip);
  return (
    addrs.find((ip) => !linkLocal(ip) && !/^f[cd]/i.test(ip) && /^[23]/.test(ip)) ??
    addrs.find((ip) => !linkLocal(ip) && ip !== "::1")
  );
}

/** Byte range for a Range header against a file of `size` bytes; null when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
  let start = 0;
  let end = size > 0 ? size - 1 : 0;
  let partial = false;
  if (header?.startsWith("bytes=")) {
    const [a, b] = header.slice(6).trim().split("-");
    if (a) start = Number.parseInt(a, 10) || 0;
    if (b) end = Number.parseInt(b, 10);
    if (Number.isNaN(end) || end >= size) end = size - 1;
    partial = true;
  }
  if (start > end || (size > 0 && start >= size)) return null;
  return { start, end, partial };
}

/**
 * Streams a device's media files straight to the user's phone or desktop over
 * IPv6 (with Range support), so a video an agent made doesn't go through the
 * server. Requests need the device's collector token.
 */
export class P2pMediaServer {
  private server: Server | undefined;
  port: number | undefined;
  ipv6: string | undefined;

  constructor(
    private readonly authToken: string,
    private readonly log: Log = () => {},
    private readonly preferredPort = 8765,
  ) {}

  async start(): Promise<boolean> {
    if (this.server) return true;
    this.ipv6 = findGlobalIpv6();
    const server = createServer((req, res) => this.handle(req, res));
    const listen = (port: number) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: "::" }, () => resolve());
      });
    try {
      try {
        await listen(this.preferredPort);
      } catch (e) {
        this.log(`[P2P] port ${this.preferredPort} unavailable, using an ephemeral one: ${e instanceof Error ? e.message : e}`);
        await listen(0);
      }
      server.unref();
      this.server = server;
      this.port = (server.address() as AddressInfo).port;
      this.log(`[P2P] media server on [::]:${this.port} (public IPv6: ${this.ipv6 ?? "none"})`);
      return true;
    } catch (e) {
      this.log(`[P2P] media server failed to start: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  refreshIpv6(): string | undefined {
    const now = findGlobalIpv6();
    if (now !== this.ipv6) {
      this.ipv6 = now;
      this.log(`[P2P] IPv6 now ${now ?? "none"}`);
    }
    return this.ipv6;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range, Authorization, Content-Type, X-P2P-Token");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    res.setHeader("Accept-Ranges", "bytes");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/p2p/stream" && url.pathname !== "/p2p/video") {
      res.writeHead(404).end("Not Found");
      return;
    }
    const token = url.searchParams.get("token") ?? req.headers["x-p2p-token"];
    const remote = req.socket.remoteAddress;
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (this.authToken && token !== this.authToken && !isLoopback) {
      res.writeHead(403).end("Invalid or missing P2P token");
      return;
    }
    let path = url.searchParams.get("path") ?? "";
    if (!path) {
      res.writeHead(400).end("Missing path parameter");
      return;
    }
    path = path.replace(/^file:\/\//, "");
    if (process.platform === "win32" && path.startsWith("/") && path[2] === ":") path = path.slice(1);
    if (path.split(/[/\\]/).includes("..")) {
      res.writeHead(403).end("Path traversal forbidden");
      return;
    }
    if (!existsSync(path)) {
      res.writeHead(404).end("File not found");
      return;
    }
    const size = statSync(path).size;
    const range = parseRange(req.headers.range, size);
    if (!range) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(range.partial ? 206 : 200, {
      "Content-Type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": size > 0 ? range.end - range.start + 1 : 0,
      ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(path, { start: range.start, end: range.end, highWaterMark: 64 * 1024 });
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }
}
