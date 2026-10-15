import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";

/**
 * WorkBuddy (Tencent Cloud AI Agent) exposes a local ACP (Agent Client Protocol)
 * gateway on loopback (`127.0.0.1:<port>/api/v1/acp`). Tasks run through a small
 * Node ESM runner (`assets/workbuddy_cli.mjs`) that connects to the gateway.
 */
const runnerAsset = () =>
  process.env.MEMENTO_WORKBUDDY_RUNNER || fileURLToPath(new URL("../assets/workbuddy_cli.mjs", import.meta.url));

const RUNNER_MARKERS = [
  "discoverGateway",
  "/api/v1/acp/connect",
  "session/set_config_option",
  "bypassPermissions",
  "agent_thought_chunk",
];

/** Installs `~/.workbuddy/bin/workbuddy_cli.mjs` and a `workbuddy` wrapper on PATH. */
export async function ensureWorkbuddyCliInstalled(home = homeDir()): Promise<void> {
  try {
    const dir = join(home, ".workbuddy", "bin");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "workbuddy_cli.mjs");
    const current = await readFile(script, "utf8").catch(() => "");
    if (!RUNNER_MARKERS.every((m) => current.includes(m))) {
      await writeFile(script, await readFile(runnerAsset(), "utf8"));
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
