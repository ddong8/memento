#!/usr/bin/env node
/**
 * Zero-Docker standalone Memento launcher (headless / CLI / server single-folder mode).
 * Runs embedded PostgreSQL 16 (UTF8 + pgvector) + Next.js standalone Web UI + @memento/server
 * on a single HTTP port (default http://127.0.0.1:8770).
 *
 * Environment overrides:
 *   MEMENTO_HOST      Bind address (default 127.0.0.1; set 0.0.0.0 for LAN/server exposure)
 *   MEMENTO_PORT      HTTP port (default 8770)
 *   MEMENTO_DATA_DIR  Persistent data directory (default ~/.memento/server-data)
 */
import { fork, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const PG_CTL = IS_WIN ? "pg_ctl.exe" : "pg_ctl";
const INITDB = IS_WIN ? "initdb.exe" : "initdb";

function locateBundleRoot() {
  // Inside packed standalone archive: ./server/main.mjs sits next to standalone.mjs
  if (existsSync(join(HERE, "server", "main.mjs"))) return HERE;
  // Inside repo: apps/desktop/dist-embedded
  const repoRoot = join(HERE, "..", "..", "..");
  const distEmbedded = join(repoRoot, "apps", "desktop", "dist-embedded");
  if (existsSync(join(distEmbedded, "server", "main.mjs"))) return distEmbedded;
  throw new Error("未找到单机运行包（缺少 server/main.mjs）。请先运行打包脚本或在解压后的单机目录内启动。");
}

function parseEnv(text) {
  const out = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return out;
}

function buildPgExecEnv(pgNative) {
  const env = { ...process.env, LC_MESSAGES: "C" };
  if (IS_WIN) {
    const shim = join(pgNative, "bin", "cmd-noautorun.exe");
    if (existsSync(shim)) {
      for (const k of Object.keys(env)) {
        if (k.toLowerCase() === "comspec") delete env[k];
      }
      env.ComSpec = shim;
    }
  }
  return env;
}

function runFile(bin, args, env = process.env, timeoutMs = 60_000) {
  return new Promise((done) => {
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdout?.destroy(); } catch {}
      try { child.stderr?.destroy(); } catch {}
      done({ code, out });
    };
    child.stdout?.on("data", (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString("utf8"); });
    child.once("error", (err) => { out += err instanceof Error ? err.message : String(err); finish(1); });
    child.once("exit", (code) => setTimeout(() => finish(code ?? 1), 60));
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(1); }, timeoutMs);
  });
}

function pickFreePort(preferred) {
  const tryPort = (port) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(null));
      srv.listen(port, "127.0.0.1", () => {
        const addr = srv.address();
        const chosen = typeof addr === "object" && addr ? addr.port : port;
        srv.close(() => resolve(chosen));
      });
    });
  return tryPort(preferred).then((p) => p ?? tryPort(0)).then((p) => p ?? preferred);
}

async function waitHttp(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
      if (r.status > 0 && r.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  const bundleRoot = locateBundleRoot();
  const dataDir = process.env.MEMENTO_DATA_DIR || join(homedir(), ".memento", "server-data");
  const pgDataDir = join(dataDir, "pg");
  const envPath = join(dataDir, ".env");
  const pgNative = join(bundleRoot, "embedded-pg", "native");
  const serverEntry = join(bundleRoot, "server", "main.mjs");
  const webDir = join(bundleRoot, "web");
  const webEntry = join(webDir, "apps", "web", "server.js");

  if (!existsSync(join(pgNative, "bin", PG_CTL))) {
    throw new Error(`缺少内置 PostgreSQL 16 二进制：${join(pgNative, "bin", PG_CTL)}`);
  }

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "storage"), { recursive: true, mode: 0o700 });

  const prev = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : new Map();
  const host = process.env.MEMENTO_HOST || prev.get("MEMENTO_HOST") || "127.0.0.1";
  const port = Number(process.env.MEMENTO_PORT || prev.get("MEMENTO_PORT")) || (await pickFreePort(8770));
  const pgPort = Number(prev.get("MEMENTO_EMBEDDED_PG_PORT")) || (await pickFreePort(54329));
  const webPort = existsSync(webEntry) ? await pickFreePort(38770) : 0;
  const pgPass = prev.get("POSTGRES_PASSWORD") || randomBytes(24).toString("hex");
  const publicUrl = process.env.MEMENTO_PUBLIC_URL || prev.get("MEMENTO_PUBLIC_URL") || `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

  const envEntries = [
    ["POSTGRES_PASSWORD", pgPass],
    ["MEMENTO_DATABASE_URL", `postgres://postgres:${pgPass}@127.0.0.1:${pgPort}/postgres`],
    ["MEMENTO_REDIS_URL", "none"],
    ["MEMENTO_STORAGE_DIR", join(dataDir, "storage")],
    ["MEMENTO_SECRET_KEY", prev.get("MEMENTO_SECRET_KEY") || randomBytes(32).toString("hex")],
    ["MEMENTO_COLLECTOR_TOKEN", prev.get("MEMENTO_COLLECTOR_TOKEN") || randomBytes(32).toString("hex")],
    ["MEMENTO_DATA_KEY", prev.get("MEMENTO_DATA_KEY") || randomBytes(32).toString("hex")],
    ["MEMENTO_HOST", host],
    ["MEMENTO_PORT", String(port)],
    ["MEMENTO_PUBLIC_URL", publicUrl],
    ["MEMENTO_CORS_ALLOW_ORIGIN_REGEX", prev.get("MEMENTO_CORS_ALLOW_ORIGIN_REGEX") || ".*"],
    ["MEMENTO_REGISTRATION_MODE", prev.get("MEMENTO_REGISTRATION_MODE") || "closed"],
    ["MEMENTO_ENABLE_SCHEDULER", "true"],
    ["MEMENTO_REMOTE_EXEC", "1"],
    ["MEMENTO_EMBEDDED_PG_PORT", String(pgPort)],
    ...(webPort ? [["MEMENTO_WEB_UPSTREAM", `http://127.0.0.1:${webPort}`]] : []),
  ];
  writeFileSync(envPath, envEntries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch {}

  const pgCtl = join(pgNative, "bin", PG_CTL);
  const initdb = join(pgNative, "bin", INITDB);
  const pgEnv = buildPgExecEnv(pgNative);
  if (!existsSync(join(pgDataDir, "PG_VERSION"))) {
    console.log("[memento] 初始化内置 PostgreSQL 16 (UTF8)...");
    if (existsSync(pgDataDir)) rmSync(pgDataDir, { recursive: true, force: true });
    mkdirSync(pgDataDir, { recursive: true, mode: 0o700 });
    const passFile = join(dataDir, ".pgpass.tmp");
    writeFileSync(passFile, `${pgPass}\n`, { mode: 0o600 });
    const res = await runFile(initdb, ["-D", pgDataDir, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${passFile}`, "--encoding=UTF8", "--locale=C"], pgEnv);
    try { writeFileSync(passFile, ""); } catch {}
    if (res.code !== 0) throw new Error(`initdb 失败:\n${res.out}`);
  }

  const st = await runFile(pgCtl, ["-D", pgDataDir, "status"], pgEnv);
  if (st.code !== 0) {
    console.log(`[memento] 启动内置数据库 127.0.0.1:${pgPort} ...`);
    const up = await runFile(pgCtl, ["-D", pgDataDir, "-o", `-p ${pgPort} -h 127.0.0.1`, "-w", "-l", join(dataDir, "pg.log"), "start"], pgEnv);
    if (up.code !== 0) throw new Error(`pg_ctl start 失败:\n${up.out}`);
  }

  let webChild = null;
  let apiChild = null;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[memento] 正在优雅停止服务与内置数据库...");
    try { apiChild?.kill("SIGTERM"); } catch {}
    try { webChild?.kill("SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    await runFile(pgCtl, ["-D", pgDataDir, "-m", "fast", "-w", "stop"], pgEnv).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  if (webPort) {
    console.log(`[memento] 启动内置 Web 界面 127.0.0.1:${webPort} ...`);
    webChild = fork(webEntry, [], {
      cwd: webDir,
      env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(webPort) },
      stdio: "inherit",
    });
    if (!(await waitHttp(`http://127.0.0.1:${webPort}/auth/login`, 25_000))) {
      throw new Error("内置 Web 界面启动超时");
    }
  }

  console.log(`[memento] 启动 Memento 单机服务端 ${publicUrl} ...`);
  const apiEnv = { ...process.env };
  for (const [k, v] of envEntries) apiEnv[k] = v;
  apiChild = fork(serverEntry, [], { cwd: join(bundleRoot, "server"), env: apiEnv, stdio: "inherit" });
  apiChild.on("exit", (code) => {
    if (!stopping) {
      console.error(`[memento] 服务端异常退出 (code=${code})`);
      void shutdown();
    }
  });

  if (await waitHttp(`http://127.0.0.1:${port}/health`, 30_000)) {
    console.log(`[memento] 单机版已就绪: ${publicUrl} (数据目录: ${dataDir})`);
  } else {
    throw new Error("服务端健康检查超时");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
