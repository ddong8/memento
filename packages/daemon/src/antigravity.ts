import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";

/**
 * Antigravity has no headless CLI of its own; tasks go through a small Python
 * runner (assets/agy_cli.py) that talks to the running app's language server.
 */
/** Where the runner ships: next to the daemon's code, or MEMENTO_AGY_RUNNER (bundled apps). */
const runnerAsset = () => process.env.MEMENTO_AGY_RUNNER || fileURLToPath(new URL("../assets/agy_cli.py", import.meta.url));
/** A runner older than these features gets rewritten. */
const RUNNER_MARKERS = [
  "_auto_discover_antigravity_ls",
  "gemini-3.8-flash",
  "--timeout",
  "ANTIGRAVITY_SOURCE_METADATA",
  "last_error_message",
  "active_background_tasks",
  "STATUS_STILL_RUNNING",
  'if __name__ == "__main__":',
];

function run(cmd: string, args: string[], timeout = 5000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout: String(stdout) }),
    );
  });
}

/** Installs ~/.gemini/antigravity/bin/agy_cli.py and an `agy` wrapper on PATH. */
export async function ensureAgyCliInstalled(home = homeDir()): Promise<void> {
  try {
    const dir = join(home, ".gemini", "antigravity", "bin");
    await mkdir(dir, { recursive: true });
    const script = join(dir, "agy_cli.py");
    const current = await readFile(script, "utf8").catch(() => "");
    if (!RUNNER_MARKERS.every((m) => current.includes(m))) {
      await writeFile(script, await readFile(runnerAsset(), "utf8"));
      if (process.platform !== "win32") await chmod(script, 0o755);
    }
    if (process.platform === "win32") {
      const winBin = join(home, "AppData", "Local", "agy", "bin");
      await mkdir(winBin, { recursive: true });
      const cmd = join(winBin, "agy.cmd");
      if (!existsSync(cmd)) await writeFile(cmd, `@echo off\r\npython "${script}" %*\r\n`);
    } else {
      const localBin = join(home, ".local", "bin");
      await mkdir(localBin, { recursive: true });
      const wrapper = join(localBin, "agy");
      if (!existsSync(wrapper)) {
        await writeFile(wrapper, `#!/bin/sh\nexec python3 "${script}" "$@"\n`);
        await chmod(wrapper, 0o755);
      }
    }
  } catch {
    // Antigravity tasks will report the missing runner.
  }
}

let cached: { env: Record<string, string>; at: number } | undefined;

function findLanguageServer(lines: string[]): { pid?: string; csrf?: string } {
  for (const line of lines) {
    if (line.includes("language_server") && line.includes("antigravity") && !line.includes("grep")) {
      return { pid: /^\s*(\d+)/.exec(line)?.[1], csrf: /--csrf_token\s+(\S+)/.exec(line)?.[1] };
    }
  }
  return {};
}

async function probePorts(ports: number[], csrf: string | undefined): Promise<{ port?: number; csrf?: string }> {
  for (const port of ports) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { "User-Agent": "Antigravity-Probe" },
        signal: AbortSignal.timeout(1500),
      });
      if (res.status !== 200) continue;
      const body = await res.text();
      if (body.includes("antigravity") || body.includes("csrfToken")) {
        return { port, csrf: csrf || /"csrfToken":"([^"]+)"/.exec(body)?.[1] };
      }
    } catch {
      // not this one
    }
  }
  return {};
}

async function lastProjectId(files: string[]): Promise<string | undefined> {
  for (const f of files) {
    try {
      const data = JSON.parse(await readFile(f, "utf8")) as { lastCreatedProjectId?: unknown };
      if (data.lastCreatedProjectId != null) return String(data.lastCreatedProjectId);
    } catch {
      // absent or unreadable
    }
  }
  return undefined;
}

/**
 * Where the running Antigravity app's language server listens, with its CSRF
 * token and last project; null when Antigravity isn't running. On macOS the app
 * is started when it's installed but closed.
 */
export async function discoverAntigravityEnv(forceRefresh = false): Promise<Record<string, string> | null> {
  if (!forceRefresh && cached && Date.now() - cached.at < 30_000) return cached.env;
  cached = undefined;
  const home = homeDir();
  try {
    let pid: string | undefined;
    let csrf: string | undefined;
    const ports: number[] = [];
    let projectFiles: string[];

    if (process.platform === "win32") {
      const ps = await run("powershell", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name LIKE '%language_server%'\" | Select-Object -Property ProcessId, CommandLine | ConvertTo-Json",
      ]);
      try {
        const decoded = JSON.parse(ps.stdout.trim()) as unknown;
        for (const item of (Array.isArray(decoded) ? decoded : [decoded]) as { ProcessId?: unknown; CommandLine?: unknown }[]) {
          const cmd = String(item?.CommandLine ?? "");
          if (cmd.includes("antigravity")) {
            pid = String(item.ProcessId);
            csrf = /--csrf_token\s+(\S+)/.exec(cmd)?.[1];
            break;
          }
        }
      } catch {
        // no process list
      }
      if (!pid) return null;
      const net = await run("cmd", ["/c", `netstat -ano | findstr ${pid}`]);
      for (const line of net.stdout.split("\n")) {
        const m = line.includes("LISTENING") ? /127\.0\.0\.1:(\d+)/.exec(line) : null;
        if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
      }
      projectFiles = [join(process.env.APPDATA ?? "", "Antigravity", "app_storage.json")];
    } else {
      const list = async () => (await run("ps", ["-eo", "pid,command"])).stdout.split("\n");
      ({ pid, csrf } = findLanguageServer(await list()));
      if (!pid && process.platform === "darwin" && existsSync("/Applications/Antigravity.app")) {
        await run("open", ["-a", "Antigravity"]);
        await new Promise((r) => setTimeout(r, 3000));
        ({ pid, csrf } = findLanguageServer(await list()));
      }
      if (!pid) return null;
      const lsof = await run("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pid]);
      for (const line of lsof.stdout.split("\n")) {
        const m = /TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/.exec(line);
        if (m && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
      }
      projectFiles = [
        join(home, "Library", "Application Support", "Antigravity", "app_storage.json"),
        join(home, ".config", "Antigravity", "app_storage.json"),
      ];
    }

    const found = await probePorts(ports, csrf);
    if (found.port === undefined) return null;
    const env: Record<string, string> = { ANTIGRAVITY_LS_ADDRESS: `localhost:${found.port}` };
    if (found.csrf) env.ANTIGRAVITY_CSRF_TOKEN = found.csrf;
    const project = await lastProjectId(projectFiles);
    if (project) env.ANTIGRAVITY_PROJECT_ID = project;
    cached = { env, at: Date.now() };
    return env;
  } catch {
    return null;
  }
}
