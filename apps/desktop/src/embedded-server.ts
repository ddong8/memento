// Zero-Docker embedded Memento server for the desktop single-installer (docs/ts-server-migration.md P7).
// Runs embedded PostgreSQL 16 (+ prebuilt pgvector) and the bundled @memento/server inside Electron's Node runtime
// (utilityProcess.fork when available, child_process.fork otherwise), storing data in ~/.memento/server-data/.
// Also provides bidirectional account data migration (standalone <-> cloud/enterprise server) with local backup.
import { execFile, fork, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseEnv } from "./local-server";

export interface EmbeddedServerConfig {
  /** Directory containing bundled server/main.mjs, server/schema.sql, and optional embedded-pg/ + pgvector/ */
  bundleDir: string;
  /** Persistent user data directory (default ~/.memento/server-data) */
  dataDir?: string;
  /** Local HTTP port for the embedded API (default 8770) */
  port?: number;
  /** Optional custom spawner (e.g., Electron utilityProcess.fork) */
  spawnServer?: (entry: string, env: NodeJS.ProcessEnv, onLog: (line: string) => void) => EmbeddedProcessHandle;
}

export interface EmbeddedProcessHandle {
  kill: () => void;
  onExit: (cb: (code: number | null) => void) => void;
}

export interface EmbeddedStatus {
  available: boolean;
  hasEmbeddedPg: boolean;
  hasExternalPg: boolean;
  installed: boolean;
  running: boolean;
  url: string;
  dataDir: string;
}

export interface MigrationOptions {
  fromUrl: string;
  fromToken: string;
  toUrl: string;
  toToken: string;
  backupDir?: string;
  onProgress?: (line: string) => void;
}

export interface MigrationResult {
  ok: boolean;
  backupPath?: string;
  counts?: Record<string, number>;
  warnings?: string[];
  error?: string;
}

const PG_CTL_BIN = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
const INITDB_BIN = process.platform === "win32" ? "initdb.exe" : "initdb";

function runFile(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = 60_000): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(bin, args, { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      done({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

async function pickFreePort(preferred: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | null>((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const chosen = typeof addr === "object" && addr ? addr.port : port;
        srv.close(() => resolve(chosen));
      });
    });
  return (await tryPort(preferred)) ?? (await tryPort(0)) ?? preferred;
}

/** Generate persistent per-machine secrets and standalone server environment (0600, never leaves the machine). */
export function buildEmbeddedEnv(opts: { port: number; pgPort: number; dataDir: string; existing?: Map<string, string>; rand?: (n: number) => string }): string {
  const rand = opts.rand ?? ((n) => randomBytes(n).toString("hex"));
  const prev = opts.existing ?? new Map<string, string>();
  const pgPass = prev.get("POSTGRES_PASSWORD") || rand(24);
  const entries: [string, string][] = [
    ["POSTGRES_PASSWORD", pgPass],
    ["MEMENTO_DATABASE_URL", `postgres://postgres:${pgPass}@127.0.0.1:${opts.pgPort}/postgres`],
    ["MEMENTO_REDIS_URL", ""],
    ["MEMENTO_STORAGE_DIR", join(opts.dataDir, "storage")],
    ["MEMENTO_SECRET_KEY", prev.get("MEMENTO_SECRET_KEY") || rand(32)],
    ["MEMENTO_COLLECTOR_TOKEN", prev.get("MEMENTO_COLLECTOR_TOKEN") || rand(32)],
    ["MEMENTO_DATA_KEY", prev.get("MEMENTO_DATA_KEY") || rand(32)],
    ["MEMENTO_HOST", "127.0.0.1"],
    ["MEMENTO_PORT", String(opts.port)],
    ["MEMENTO_PUBLIC_URL", `http://127.0.0.1:${opts.port}`],
    ["MEMENTO_CORS_ALLOW_ORIGIN_REGEX", "^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$"],
    ["MEMENTO_REGISTRATION_MODE", prev.get("MEMENTO_REGISTRATION_MODE") || "closed"],
    ["MEMENTO_ENABLE_SCHEDULER", "true"],
    ["MEMENTO_REMOTE_EXEC", "1"],
    ["MEMENTO_EMBEDDED_PG_PORT", String(opts.pgPort)],
  ];
  return entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

/** Locate bundled native Postgres directory (dist/embedded-pg/native or node_modules/@embedded-postgres/<plat>/native). */
export function locateEmbeddedPgNative(bundleDir: string): string | null {
  const plat = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const candidates = [
    join(bundleDir, "embedded-pg", "native"),
    join(bundleDir, "node_modules", `@embedded-postgres/${plat}`, "native"),
    join(bundleDir, "..", "node_modules", `@embedded-postgres/${plat}`, "native"),
    join(bundleDir, "..", "..", "node_modules", `@embedded-postgres/${plat}`, "native"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "bin", PG_CTL_BIN))) return dir;
  }
  return null;
}

/** Copy prebuilt pgvector library & extension SQL into the embedded Postgres native tree when present. */
export function installBundledPgvector(bundleDir: string, pgNativeDir: string): boolean {
  const plat = `${process.platform}-${process.arch}`;
  const srcCandidates = [join(bundleDir, "pgvector"), join(bundleDir, "pgvector", plat)];
  const src = srcCandidates.find((d) => existsSync(join(d, "lib")) && existsSync(join(d, "extension")));
  if (!src) return false;
  const pkglib = existsSync(join(pgNativeDir, "lib", "postgresql")) ? join(pgNativeDir, "lib", "postgresql") : join(pgNativeDir, "lib");
  const extDir = existsSync(join(pgNativeDir, "share", "postgresql", "extension"))
    ? join(pgNativeDir, "share", "postgresql", "extension")
    : join(pgNativeDir, "share", "extension");
  try {
    for (const f of readdirSync(join(src, "lib"))) {
      const dst = join(pkglib, f);
      if (!existsSync(dst)) cpSync(join(src, "lib", f), dst);
    }
    for (const f of readdirSync(join(src, "extension"))) {
      const dst = join(extDir, f);
      if (!existsSync(dst)) cpSync(join(src, "extension", f), dst);
    }
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnServer(entry: string, env: NodeJS.ProcessEnv, onLog: (line: string) => void): EmbeddedProcessHandle {
  const child: ChildProcess = fork(entry, [], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const forward = (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/[\r\n]+/)) {
      const t = line.trim();
      if (t) onLog(t);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  return {
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
    onExit: (cb) => {
      child.on("exit", (code) => cb(code));
    },
  };
}

export class EmbeddedServer {
  readonly dataDir: string;
  readonly port: number;
  private proc: EmbeddedProcessHandle | null = null;
  private pgNative: string | null = null;
  private pgDataDir: string;
  private starting: Promise<{ ok: boolean; url?: string; error?: string }> | null = null;

  constructor(private readonly opts: EmbeddedServerConfig) {
    this.dataDir = opts.dataDir ?? join(homedir(), ".memento", "server-data");
    this.port = opts.port ?? 8770;
    this.pgDataDir = join(this.dataDir, "pg");
  }

  private envPath(): string {
    return join(this.dataDir, ".env");
  }

  private serverEntry(): string {
    return join(this.opts.bundleDir, "server", "main.mjs");
  }

  url(): string {
    try {
      const env = parseEnv(readFileSync(this.envPath(), "utf8"));
      return (env.get("MEMENTO_PUBLIC_URL") || `http://127.0.0.1:${this.port}`).replace(/\/+$/, "");
    } catch {
      return `http://127.0.0.1:${this.port}`;
    }
  }

  isAvailable(): boolean {
    return existsSync(this.serverEntry()) && Boolean(locateEmbeddedPgNative(this.opts.bundleDir));
  }

  async healthy(url = this.url()): Promise<boolean> {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      return res.ok && body?.status === "ok";
    } catch {
      return false;
    }
  }

  async status(): Promise<EmbeddedStatus> {
    const pgNative = locateEmbeddedPgNative(this.opts.bundleDir);
    const hasEntry = existsSync(this.serverEntry());
    const running = await this.healthy();
    return {
      available: hasEntry && Boolean(pgNative),
      hasEmbeddedPg: Boolean(pgNative),
      hasExternalPg: false,
      installed: existsSync(this.envPath()),
      running,
      url: this.url(),
      dataDir: this.dataDir,
    };
  }

  start(progress: (line: string) => void = () => {}): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (!this.starting) {
      this.starting = this.doStart(progress).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async doStart(progress: (line: string) => void): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (await this.healthy()) {
      return { ok: true, url: this.url() };
    }
    const entry = this.serverEntry();
    if (!existsSync(entry)) {
      return { ok: false, error: `内置服务端文件缺失：${entry}` };
    }
    const pgNative = locateEmbeddedPgNative(this.opts.bundleDir);
    if (!pgNative) {
      return { ok: false, error: "当前安装包未包含内置 PostgreSQL 二进制，可切换 Docker 单机模式或连接外部服务器" };
    }
    this.pgNative = pgNative;
    installBundledPgvector(this.opts.bundleDir, pgNative);

    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dataDir, "storage"), { recursive: true, mode: 0o700 });

    const existing = existsSync(this.envPath()) ? parseEnv(readFileSync(this.envPath(), "utf8")) : new Map<string, string>();
    const pgPort = Number(existing.get("MEMENTO_EMBEDDED_PG_PORT")) || (await pickFreePort(54329));
    const httpPort = Number(existing.get("MEMENTO_PORT")) || (await pickFreePort(this.port));
    const envText = buildEmbeddedEnv({ port: httpPort, pgPort, dataDir: this.dataDir, existing });
    writeFileSync(this.envPath(), envText, { mode: 0o600 });
    try {
      chmodSync(this.envPath(), 0o600);
    } catch {
      /* windows */
    }
    const envMap = parseEnv(envText);

    // 1) Initialize embedded PG16 cluster once with UTF8 (default SQL_ASCII breaks Chinese FTS)
    const pgCtl = join(pgNative, "bin", PG_CTL_BIN);
    const initdb = join(pgNative, "bin", INITDB_BIN);
    const pgLog = join(this.dataDir, "pg.log");
    const pgPassFile = join(this.dataDir, ".pgpass.tmp");
    if (!existsSync(join(this.pgDataDir, "PG_VERSION"))) {
      progress("初始化本机内置数据库（PostgreSQL 16 · UTF8）…");
      mkdirSync(this.pgDataDir, { recursive: true, mode: 0o700 });
      writeFileSync(pgPassFile, `${envMap.get("POSTGRES_PASSWORD") || "memento"}\n`, { mode: 0o600 });
      const initRes = await runFile(initdb, [
        "-D",
        this.pgDataDir,
        "-U",
        "postgres",
        "--auth=scram-sha-256",
        `--pwfile=${pgPassFile}`,
        "--encoding=UTF8",
        "--locale=C",
      ]);
      try {
        writeFileSync(pgPassFile, "");
      } catch {
        /* ignore */
      }
      if (initRes.code !== 0) {
        return { ok: false, error: `内置数据库初始化失败：\n${initRes.out.slice(-400)}` };
      }
    }

    // 2) Start embedded PostgreSQL via pg_ctl (works on Windows admin accounts too)
    progress("启动内置数据库…");
    const st = await runFile(pgCtl, ["-D", this.pgDataDir, "status"]);
    if (st.code !== 0) {
      const up = await runFile(pgCtl, [
        "-D",
        this.pgDataDir,
        "-o",
        `-p ${pgPort} -h 127.0.0.1`,
        "-w",
        "-l",
        pgLog,
        "start",
      ]);
      if (up.code !== 0) {
        return { ok: false, error: `内置数据库启动失败：\n${up.out.slice(-400)}` };
      }
    }

    // 3) Spawn bundled @memento/server (runs automatic idempotent DDL migrations on startup)
    progress("启动 Memento 内置服务端…");
    const procEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of envMap) procEnv[k] = v;
    const spawner = this.opts.spawnServer ?? defaultSpawnServer;
    this.proc = spawner(entry, procEnv, progress);
    this.proc.onExit(() => {
      this.proc = null;
    });

    const url = `http://127.0.0.1:${httpPort}`;
    for (let i = 0; i < 60; i++) {
      if (await this.healthy(url)) {
        progress("本机内置服务已就绪");
        return { ok: true, url };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error: "内置服务端启动超时，请检查 ~/.memento/server-data/pg.log" };
  }

  async stop(): Promise<{ ok: boolean; error?: string }> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.pgNative && existsSync(join(this.pgDataDir, "PG_VERSION"))) {
      const pgCtl = join(this.pgNative, "bin", PG_CTL_BIN);
      await runFile(pgCtl, ["-D", this.pgDataDir, "-m", "fast", "-w", "stop"]).catch(() => {});
    }
    return { ok: true };
  }
}

/**
 * Bidirectional account data migration between any two Memento servers (standalone <-> self-hosted / cloud).
 * Always saves a timestamped local backup ZIP before importing into the target server.
 */
export async function migrateServerData(opts: MigrationOptions): Promise<MigrationResult> {
  const log = opts.onProgress ?? (() => {});
  const fromBase = opts.fromUrl.trim().replace(/\/+$/, "");
  const toBase = opts.toUrl.trim().replace(/\/+$/, "");
  if (!fromBase || !toBase) return { ok: false, error: "缺少源或目标服务器地址" };
  if (!opts.fromToken || !opts.toToken) return { ok: false, error: "需要分别提供源服务器和目标服务器的登录凭据" };

  try {
    log(`正在从 ${fromBase} 导出完整账号数据…`);
    const expRes = await fetch(`${fromBase}/api/data/export?include_full=1`, {
      headers: { Authorization: `Bearer ${opts.fromToken}` },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!expRes.ok) {
      const txt = await expRes.text().catch(() => "");
      return { ok: false, error: `源服务器导出失败（HTTP ${expRes.status}）：${txt.slice(0, 200)}` };
    }
    const zipBuf = Buffer.from(await expRes.arrayBuffer());
    if (!zipBuf.byteLength) return { ok: false, error: "导出的备份包为空" };

    // Always keep a local backup before importing
    const backupDir = opts.backupDir ?? join(homedir(), ".memento", "server-data", "backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupPath = join(backupDir, `migrate-${stamp}.zip`);
    writeFileSync(backupPath, zipBuf, { mode: 0o600 });
    log(`已保存本地备份（${(zipBuf.byteLength / 1024 / 1024).toFixed(2)} MB）：${backupPath}`);

    log(`正在向 ${toBase} 导入数据…`);
    const form = new FormData();
    form.append("file", new Blob([zipBuf], { type: "application/zip" }), `migrate-${stamp}.zip`);
    const impRes = await fetch(`${toBase}/api/data/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.toToken}` },
      body: form,
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const impText = await impRes.text();
    let impJson: Record<string, unknown> = {};
    try {
      impJson = JSON.parse(impText) as Record<string, unknown>;
    } catch {
      /* non-json */
    }
    if (!impRes.ok) {
      return {
        ok: false,
        backupPath,
        error: `目标服务器导入失败（HTTP ${impRes.status}）：${String(impJson.detail || impText).slice(0, 240)}`,
      };
    }

    log("数据迁移完成");
    return {
      ok: true,
      backupPath,
      counts: (impJson.counts && typeof impJson.counts === "object" ? (impJson.counts as Record<string, number>) : {}) as Record<string, number>,
      warnings: Array.isArray(impJson.warnings) ? (impJson.warnings as string[]) : [],
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
