// Previewing a local web server on this device from the web app: which ports are listening (dev servers an
// agent or the terminal started), and one HTTP request at a time fetched from localhost for the server's
// preview relay. Only loopback addresses are fetched, never another host.
import { execFile } from "node:child_process";

export interface ListeningPort {
  port: number;
  process: string;
  pid?: number;
}

/** Ports that are never someone's dev server (this app's own, databases, system services). */
const NOT_WEB = new Set([22, 53, 111, 631, 3306, 5432, 5433, 6379, 27017, 9200, 11211]);
/** System processes that listen on ports (macOS AirPlay takes 5000/7000, which Flask also uses: by name, not port). */
const NOT_WEB_PROCS = /^(ControlCe|rapportd|sharingd|identitys|launchd|mDNSRespo|systemd|sshd|cupsd|postgres|redis-ser|mysqld|mongod|Electron|Memento|Code H|Antigravi|language_|clash|ollama|claude|codex|Cursor|WorkBuddy|Google|Chrome|Dropbox|Spotify)/i;
/** The OS's ephemeral range: apps' own sockets, not dev servers (which take 3000, 5173, 8000, 8080...). */
const EPHEMERAL_FROM = 49152;

function run(cmd: string, args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_e, stdout) => done(String(stdout ?? "")));
  });
}

/** `lsof -nP -iTCP -sTCP:LISTEN` output -> ports (one row per port, first process wins). */
export function parseLsof(out: string): ListeningPort[] {
  const seen = new Map<number, ListeningPort>();
  for (const line of out.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const m = /:(\d+)$/.exec(cols[8]!.replace(/\s*\(LISTEN\)$/, ""));
    if (!m) continue;
    const port = Number(m[1]);
    if (!seen.has(port)) seen.set(port, { port, process: cols[0]!.replace(/\\x20/g, " "), pid: Number(cols[1]) || undefined });
  }
  return [...seen.values()];
}

/** `ss -ltnpH` output (Linux without lsof) -> ports. */
export function parseSs(out: string): ListeningPort[] {
  const seen = new Map<number, ListeningPort>();
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const m = /:(\d+)$/.exec(cols[3]!);
    if (!m) continue;
    const port = Number(m[1]);
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (!seen.has(port)) seen.set(port, { port, process: proc?.[1] ?? "", pid: proc ? Number(proc[2]) : undefined });
  }
  return [...seen.values()];
}

/** PowerShell `Get-NetTCPConnection -State Listen | ... | ConvertTo-Json` -> ports. */
export function parseWindows(out: string): ListeningPort[] {
  let rows: unknown;
  try {
    rows = JSON.parse(out.trim() || "[]");
  } catch {
    return [];
  }
  const list = (Array.isArray(rows) ? rows : [rows]) as { LocalPort?: number; OwningProcess?: number; Name?: string }[];
  const seen = new Map<number, ListeningPort>();
  for (const r of list) {
    if (typeof r?.LocalPort === "number" && !seen.has(r.LocalPort)) seen.set(r.LocalPort, { port: r.LocalPort, process: r.Name ?? "", pid: r.OwningProcess });
  }
  return [...seen.values()];
}

/** Listening TCP ports that could be a dev server: unprivileged, not a known database / system service. */
export async function listeningPorts(platform: NodeJS.Platform = process.platform): Promise<ListeningPort[]> {
  let ports: ListeningPort[];
  if (platform === "win32") {
    ports = parseWindows(
      await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ LocalPort = $_.LocalPort; OwningProcess = $_.OwningProcess; Name = (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } } | ConvertTo-Json -Compress",
      ]),
    );
  } else {
    ports = parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"]));
    if (!ports.length && platform === "linux") ports = parseSs(await run("ss", ["-ltnpH"]));
  }
  return ports
    .filter((p) => p.port >= 1024 && p.port < EPHEMERAL_FROM && !NOT_WEB.has(p.port) && !NOT_WEB_PROCS.test(p.process))
    .sort((a, b) => a.port - b.port);
}

export interface PreviewRequest {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body_b64?: string;
}

export interface PreviewResponse {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body_b64?: string;
  truncated?: boolean;
  error?: string;
}

const MAX_BODY = 12 * 1024 * 1024;
/** Request headers not passed on to the local server (hop-by-hop, or the relay's own). */
const DROP_REQ = new Set(["host", "connection", "content-length", "accept-encoding", "authorization", "cookie", "origin", "referer", "upgrade"]);
const DROP_RES = new Set(["connection", "transfer-encoding", "content-encoding", "content-length", "keep-alive"]);

/** One HTTP request to http://127.0.0.1:<port><path>, the response back as base64 (cut at 12 MB). */
export async function fetchLocal(req: PreviewRequest, fetchImpl: typeof fetch = fetch): Promise<PreviewResponse> {
  const port = Math.round(Number(req.port));
  if (!(port >= 1 && port <= 65535)) return { ok: false, error: "端口不合法" };
  const path = typeof req.path === "string" && req.path.startsWith("/") ? req.path : "/";
  const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(req.method) ? req.method : "GET";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_REQ.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" || !req.body_b64 ? undefined : Buffer.from(req.body_b64, "base64"),
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!DROP_RES.has(k)) out[k] = v;
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, headers: out, body_b64: buf.subarray(0, MAX_BODY).toString("base64"), ...(buf.length > MAX_BODY ? { truncated: true } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /ECONNREFUSED|fetch failed/.test(msg) ? `端口 ${port} 上没有服务在运行` : msg };
  }
}
