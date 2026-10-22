import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";

/**
 * WorkBuddy (Tencent Cloud AI Agent) is driven over ACP (Agent Client Protocol) on a
 * loopback HTTP gateway (`127.0.0.1:<port>/api/v1/acp`). Tasks run through a small
 * Node ESM runner (`assets/workbuddy_cli.mjs`) that connects to the gateway.
 *
 * Up to 5.7 the desktop app kept such a gateway running (`~/.workbuddy/local-gateway`).
 * 5.8 removed it: each desktop conversation now runs its own CLI, which receives the
 * login over a private channel. So memento serves the gateway itself from the CLI the
 * app bundles (`cli/dist/codebuddy-lite-wb.mjs`), with credentials kept in that
 * process's memory only: it never reads or writes the desktop's credential file, and
 * the user signs in once through a link the task prints (again after a reboot).
 */
const runnerAsset = () =>
  process.env.MEMENTO_WORKBUDDY_RUNNER || fileURLToPath(new URL("../assets/workbuddy_cli.mjs", import.meta.url));

const RUNNER_MARKERS = [
  "discoverGateway",
  "/api/v1/acp/connect",
  "session/set_config_option",
  "bypassPermissions",
  "agent_thought_chunk",
  "SIGINT_SIGTERM_HANDLER",
  "MEMENTO_GATEWAY_FILE",
];

/** Installs `~/.workbuddy/bin/workbuddy_cli.mjs` and a `workbuddy` wrapper on PATH. */
export async function ensureWorkbuddyCliInstalled(home = homeDir()): Promise<void> {
  try {
    const dir = join(home, ".workbuddy", "bin");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "workbuddy_cli.mjs");
    const current = await readFile(script, "utf8").catch(() => "");
    const target = await readFile(runnerAsset(), "utf8");
    if (current !== target || !RUNNER_MARKERS.every((m) => current.includes(m))) {
      await writeFile(script, target);
      if (process.platform !== "win32") await chmod(script, 0o755);
    }
    if (process.platform === "win32") {
      const cmdContent = `@echo off\r\nnode "${script}" %*\r\n`;
      const localCmd = join(dir, "workbuddy.cmd");
      if (!existsSync(localCmd)) await writeFile(localCmd, cmdContent);
      const winBin = join(home, "AppData", "Local", "workbuddy", "bin");
      await mkdir(winBin, { recursive: true });
      const cmd = join(winBin, "workbuddy.cmd");
      if (!existsSync(cmd)) await writeFile(cmd, cmdContent);
    } else {
      const shContent = `#!/bin/sh\nexec node "${script}" "$@"\n`;
      const wbWrapper = join(dir, "workbuddy");
      if (!existsSync(wbWrapper)) {
        await writeFile(wbWrapper, shContent);
        await chmod(wbWrapper, 0o755);
      }
      const localBin = join(home, ".local", "bin");
      await mkdir(localBin, { recursive: true });
      const wrapper = join(localBin, "workbuddy");
      if (!existsSync(wrapper)) {
        await writeFile(wrapper, shContent);
        await chmod(wrapper, 0o755);
      }
    }
  } catch {
    // WorkBuddy tasks will report if the runner is missing.
  }
}

export interface WorkbuddyGatewayInfo {
  endpoint: string;
  pid?: number;
  version?: string;
}

/** Finds an active WorkBuddy local gateway from `~/.workbuddy/local-gateway/state.json` or `~/.workbuddy/sessions/*.json`. */
export async function discoverWorkbuddyGateway(home = homeDir()): Promise<WorkbuddyGatewayInfo | null> {
  try {
    const lgState = join(home, ".workbuddy", "local-gateway", "state.json");
    if (existsSync(lgState)) {
      try {
        const lgData = JSON.parse(await readFile(lgState, "utf8")) as { port?: number; pid?: number };
        if (typeof lgData.port === "number" && lgData.port > 0) {
          const ep = `http://127.0.0.1:${lgData.port}`;
          const res = await fetch(`${ep}/api/v1/health`, {
            signal: AbortSignal.timeout(1200),
          }).catch(() => null);
          if (res) {
            return {
              endpoint: ep,
              ...(typeof lgData.pid === "number" ? { pid: lgData.pid } : {}),
            };
          }
        }
      } catch {
        // fallback to sessions dir
      }
    }

    const sessionsDir = join(home, ".workbuddy", "sessions");
    const names = (await readdir(sessionsDir)).filter((f) => f.endsWith(".json"));
    const withStat = await Promise.all(
      names.map(async (f) => {
        const p = join(sessionsDir, f);
        const st = await stat(p).catch(() => null);
        return st ? { path: p, mtime: st.mtimeMs } : null;
      }),
    );
    const sorted = withStat
      .filter((x): x is { path: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);

    for (const item of sorted) {
      try {
        const data = JSON.parse(await readFile(item.path, "utf8")) as {
          endpoint?: string;
          pid?: number;
          version?: string;
        };
        if (!data.endpoint) continue;
        const res = await fetch(`${data.endpoint}/api/v1/health`, {
          signal: AbortSignal.timeout(1200),
        }).catch(() => null);
        if (res) {
          return {
            endpoint: data.endpoint,
            ...(typeof data.pid === "number" ? { pid: data.pid } : {}),
            ...(typeof data.version === "string" ? { version: data.version } : {}),
          };
        }
      } catch {
        // try next session file
      }
    }
  } catch {
    // no sessions directory
  }
  return null;
}

/** Checks whether WorkBuddy desktop app or `~/.workbuddy` is present on this machine. */
export function isWorkbuddyInstalled(home = homeDir()): boolean {
  if (existsSync(join(home, ".workbuddy")) || existsSync(join(home, ".codebuddy"))) return true;
  if (
    process.platform === "darwin" &&
    (existsSync("/Applications/WorkBuddy.app") || existsSync(join(home, "Applications", "WorkBuddy.app")))
  ) {
    return true;
  }
  if (
    process.platform === "win32" &&
    (existsSync(join(home, "AppData", "Local", "Programs", "WorkBuddy")) ||
      existsSync(join(home, "AppData", "Roaming", "WorkBuddy")) ||
      existsSync("C:\\Program Files\\WorkBuddy") ||
      existsSync("C:\\Program Files (x86)\\WorkBuddy") ||
      existsSync("D:\\Program Files\\WorkBuddy"))
  ) {
    return true;
  }
  if (
    process.platform === "linux" &&
    (existsSync("/opt/WorkBuddy") ||
      existsSync("/opt/workbuddy") ||
      existsSync("/usr/share/workbuddy") ||
      existsSync(join(home, ".local", "share", "WorkBuddy")))
  ) {
    return true;
  }
  return false;
}

// ── WorkBuddy ≥ 5.8: memento's own gateway on the CLI the app bundles ─────

const LITE_CLI = ["app.asar.unpacked", "cli", "dist", "codebuddy-lite-wb.mjs"];

export interface WorkbuddyLiteCli {
  /** Node runtime to run it with: the one WorkBuddy installs for its CLI, else `node` on PATH. */
  node: string;
  /** `.../cli/dist/codebuddy-lite-wb.mjs` */
  entry: string;
}

/** WorkBuddy's app resources directories (the one holding `app.asar`), most likely first. */
export function workbuddyResourceDirs(home = homeDir(), env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (platform === "darwin") {
    return ["/Applications/WorkBuddy.app/Contents/Resources", join(home, "Applications", "WorkBuddy.app", "Contents", "Resources")];
  }
  const installs =
    platform === "win32"
      ? [
          join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "WorkBuddy"),
          join(env.ProgramFiles ?? "C:\\Program Files", "WorkBuddy"),
          join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "WorkBuddy"),
          "D:\\Program Files\\WorkBuddy",
          join(env.APPDATA ?? join(home, "AppData", "Roaming"), "WorkBuddy"),
        ]
      : ["/opt/WorkBuddy", "/opt/workbuddy", "/usr/lib/workbuddy", join(home, ".local", "share", "WorkBuddy")];
  return installs.map((d) => join(d, "resources"));
}

/** The Node runtime WorkBuddy downloads for its CLI (`~/.workbuddy/binaries/node/versions/<current>`). */
export function workbuddyBundledNode(home = homeDir(), platform = process.platform): string | null {
  const versions = join(home, ".workbuddy", "binaries", "node", "versions");
  let names: string[] = [];
  try {
    const current = readFileSync(join(versions, "current"), "utf8").trim();
    if (current) names.push(current);
  } catch {
    // no pointer file: fall back to whatever versions are there, newest name first
  }
  try {
    const others = readdirSync(versions).filter((n) => !n.startsWith(".") && n !== "current" && !names.includes(n));
    names = [...names, ...others.sort().reverse()];
  } catch {
    return null;
  }
  for (const name of names) {
    const candidates =
      platform === "win32"
        ? [join(versions, name, "node.exe"), join(versions, name, "bin", "node.exe")]
        : [join(versions, name, "bin", "node")];
    for (const c of candidates) if (existsSync(c)) return c;
  }
  return null;
}

/** WorkBuddy ≥ 5.8's bundled CLI, if this machine has one. */
export function findWorkbuddyLiteCli(
  home = homeDir(),
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): WorkbuddyLiteCli | null {
  const override = env.MEMENTO_WORKBUDDY_CLI_ENTRY;
  const entry = [override, ...workbuddyResourceDirs(home, env, platform).map((d) => join(d, ...LITE_CLI))].find(
    (p): p is string => !!p && existsSync(p),
  );
  if (!entry) return null;
  return { node: workbuddyBundledNode(home, platform) ?? "node", entry };
}

export interface MementoWorkbuddyGateway {
  endpoint: string;
  password: string;
  pid: number;
  startedAt: number;
}

/** Where the runner finds the gateway memento serves (0600, it holds the gateway password). */
export const workbuddyGatewayFile = (home = homeDir()) => join(mementoDir(home), "workbuddy-gateway.json");
/** The gateway's CLI config, sessions and logs; deliberately not `~/.workbuddy` (that one is the app's). */
export const workbuddyCliDir = (home = homeDir()) => join(mementoDir(home), "workbuddy-cli");

/** Headers every request to memento's WorkBuddy gateway needs. */
export const workbuddyGatewayHeaders = (password: string): Record<string, string> => ({
  Authorization: `Bearer ${password}`,
  "x-codebuddy-request": "1",
});

/** Pulls the endpoint and password out of the CLI's `--serve` banner (it is printed with ANSI colours). */
export function parseGatewayBanner(text: string): { endpoint: string; password: string } | null {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const endpoint = /Endpoint\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(plain)?.[1];
  const password = /Password\s+(\S+)/.exec(plain)?.[1];
  return endpoint && password ? { endpoint, password } : null;
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gatewayHealthy(gw: MementoWorkbuddyGateway): Promise<boolean> {
  if (!pidAlive(gw.pid)) return false;
  const res = await fetch(`${gw.endpoint}/api/v1/health`, {
    headers: workbuddyGatewayHeaders(gw.password),
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  return !!res?.ok;
}

async function readGatewayFile(home: string): Promise<MementoWorkbuddyGateway | null> {
  try {
    const gw = JSON.parse(await readFile(workbuddyGatewayFile(home), "utf8")) as Partial<MementoWorkbuddyGateway>;
    if (typeof gw.endpoint === "string" && typeof gw.password === "string" && typeof gw.pid === "number") {
      return { endpoint: gw.endpoint, password: gw.password, pid: gw.pid, startedAt: gw.startedAt ?? 0 };
    }
  } catch {
    // none yet
  }
  return null;
}

async function startGateway(home: string, cli: WorkbuddyLiteCli, timeoutMs: number): Promise<MementoWorkbuddyGateway> {
  const dir = workbuddyCliDir(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dir, 0o700);
  // The banner (with the password) goes to a private log rather than a pipe nobody drains after start-up.
  const logPath = join(dir, "gateway.log");
  const fd = openSync(logPath, "w", 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(cli.node, [cli.entry, "--serve", "--host", "127.0.0.1"], {
      cwd: dir,
      env: {
        ...process.env,
        // Keep credentials and config safely isolated inside ~/.memento/workbuddy-cli (0700).
        // This persists login credentials across daemon and machine restarts so the user only signs in once.
        CODEBUDDY_CONFIG_DIR: dir,
        // 5.8 ships only the lite bundle; without this the CLI looks for the removed full one.
        CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
        SERVER__HOST: "127.0.0.1",
      },
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(fd);
  }
  if (!pid) throw new Error("WorkBuddy gateway did not start");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const banner = parseGatewayBanner(await readFile(logPath, "utf8").catch(() => ""));
    if (banner) {
      const gw: MementoWorkbuddyGateway = { ...banner, pid, startedAt: Date.now() };
      if (await gatewayHealthy(gw)) {
        const file = workbuddyGatewayFile(home);
        await writeFile(`${file}.tmp`, JSON.stringify(gw), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
        return gw;
      }
    }
    if (!pidAlive(pid)) break;
  }
  try {
    process.kill(pid);
  } catch {
    // already gone
  }
  throw new Error(`WorkBuddy gateway did not come up (see ${logPath})`);
}

let gatewayStart: Promise<MementoWorkbuddyGateway | null> | null = null;

/**
 * Makes sure memento's WorkBuddy gateway is running on WorkBuddy ≥ 5.8 and returns it
 * (null when WorkBuddy predates 5.8 or isn't installed). A gateway left by an earlier
 * daemon is reused, so a signed-in session survives memento restarts.
 */
export async function ensureWorkbuddyGateway(
  home = homeDir(),
  options: { cli?: WorkbuddyLiteCli | null; timeoutMs?: number } = {},
): Promise<MementoWorkbuddyGateway | null> {
  const cli = options.cli === undefined ? findWorkbuddyLiteCli(home) : options.cli;
  if (!cli) return null;
  gatewayStart ??= (async () => {
    const existing = await readGatewayFile(home);
    if (existing && (await gatewayHealthy(existing))) return existing;
    if (existing?.pid && pidAlive(existing.pid)) {
      try {
        process.kill(existing.pid, "SIGKILL");
      } catch {
        // already stopped
      }
    }
    return startGateway(home, cli, options.timeoutMs ?? 45_000);
  })().finally(() => {
    gatewayStart = null;
  });
  return gatewayStart;
}

/**
 * Cancels an active session on WorkBuddy gateway.
 * Directly called by daemon upon task cancellation so that abort doesn't depend on a dying child process.
 */
export async function cancelWorkbuddySession(sessionId: string, home = homeDir()): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const managed = await readGatewayFile(home);
    let endpoint = "";
    let authHeaders: Record<string, string> = {};
    if (managed && (await gatewayHealthy(managed))) {
      endpoint = managed.endpoint;
      authHeaders = workbuddyGatewayHeaders(managed.password);
    } else {
      const native = await discoverWorkbuddyGateway(home);
      if (native) {
        endpoint = native.endpoint;
      }
    }
    if (!endpoint) return false;

    // Connect to obtain connectionId
    const connRes = await fetch(`${endpoint}/api/v1/acp/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    const connData = (await connRes?.json().catch(() => null)) as { connectionId?: string } | null;
    const connId = connData?.connectionId;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...authHeaders,
      ...(connId ? { "acp-connection-id": connId } : {}),
    };

    const res = await fetch(`${endpoint}/api/v1/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);

    return !!res?.ok;
  } catch {
    return false;
  }
}
