import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";
import type { Daemon } from "./daemon.js";
import { GUARD_TOOLS, type GuardTool, type StopInput } from "./guard.js";
import { curlConfigPath, curlConfigText } from "./guard-inject.js";

/**
 * Loopback API for the desktop app and `memento-daemon status`. Where it listens
 * and its bearer token are in ~/.memento/daemon.json (readable only by the user).
 *
 *   GET  /status        DaemonStatus
 *   GET  /logs          recent log lines
 *   GET  /events        SSE: "status" and "log" events
 *   POST /rediscover    discover tools again and report them
 *   POST /resync        re-upload all watched files
 *   POST /sync-profile  apply the resident profile and skills now
 *   POST /hooks/stop    Stop hook of Claude Code / Codex (guard.ts); needs the token
 *
 * The address and token are also written as a curl config for the hook script
 * (guard-inject.ts), and removed on stop so the hook lets turns end.
 */
export interface LocalApiInfo {
  port: number;
  token: string;
  pid: number;
}

export const localApiFile = (home = homeDir()) => join(mementoDir(home), "daemon.json");

export async function readLocalApiInfo(home = homeDir()): Promise<LocalApiInfo | undefined> {
  try {
    return JSON.parse(await readFile(localApiFile(home), "utf8")) as LocalApiInfo;
  } catch {
    return undefined;
  }
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

const MAX_HOOK_BODY = 2 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_HOOK_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

export class LocalApi {
  private server: Server | undefined;
  private readonly token = randomBytes(24).toString("hex");

  constructor(
    private readonly daemon: Daemon,
    private readonly home = homeDir(),
  ) {}

  async start(port = 0): Promise<LocalApiInfo> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    this.server = server;
    const info: LocalApiInfo = { port: (server.address() as AddressInfo).port, token: this.token, pid: process.pid };
    const file = localApiFile(this.home);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(info), { mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
    const curl = curlConfigPath(this.home);
    await mkdir(dirname(curl), { recursive: true });
    await writeFile(curl, curlConfigText(info.port, info.token), { mode: 0o600 });
    await chmod(curl, 0o600).catch(() => {});
    return info;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
    const info = await readLocalApiInfo(this.home);
    if (info?.pid === process.pid) {
      await rm(localApiFile(this.home), { force: true });
      await rm(curlConfigPath(this.home), { force: true });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const path = parsedUrl.pathname;
    const force = parsedUrl.searchParams.get("force") === "1" || parsedUrl.searchParams.get("fresh") === "1";
    try {
      if (req.method === "GET" && path === "/status") return json(res, 200, this.daemon.status);
      if (req.method === "GET" && path === "/quotas") {
        const { probeAllQuotas } = await import("./quotas.js");
        const quotas = await probeAllQuotas(this.home, { force });
        return json(res, 200, quotas);
      }
      if (req.method === "GET" && path === "/logs") return json(res, 200, { logs: this.daemon.recentLogs });
      if (req.method === "GET" && path === "/events") return this.events(req, res);
      if (req.method === "POST" && path === "/rediscover") {
        await this.daemon.rediscover();
        return json(res, 200, this.daemon.status);
      }
      if (req.method === "POST" && path === "/resync") {
        await this.daemon.resync();
        return json(res, 202, { status: "queued" });
      }
      if (req.method === "POST" && path === "/hooks/stop") {
        if (!authorized(req, this.token)) return json(res, 401, { error: "unauthorized" });
        const header = String(req.headers["x-memento-tool"] ?? "claude_code");
        const tool: GuardTool = (GUARD_TOOLS as readonly string[]).includes(header) ? (header as GuardTool) : "claude_code";
        const input = JSON.parse((await readBody(req)) || "{}") as StopInput;
        const verdict = await this.daemon.checkStop(tool, input);
        return json(res, 200, verdict.block ? { decision: "block", reason: verdict.reason } : {});
      }
      if (req.method === "POST" && path === "/sync-profile") {
        await this.daemon.syncProfileAndSkills();
        return json(res, 200, { status: "done" });
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private events(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("status", this.daemon.status);
    const onStatus = (s: unknown) => send("status", s);
    const onLog = (line: string) => send("log", line);
    this.daemon.on("status", onStatus);
    this.daemon.on("log", onLog);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      this.daemon.off("status", onStatus);
      this.daemon.off("log", onLog);
    });
  }
}
