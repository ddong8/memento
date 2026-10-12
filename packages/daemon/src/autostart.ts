import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";

/**
 * One collector per device. The daemon records its pid in ~/.memento/collector.pid,
 * the same file the Flutter app checks before starting its in-process collector,
 * so running both never uploads everything twice.
 */
export const pidFile = (home = homeDir()) => join(mementoDir(home), "collector.pid");

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isZombieProcess(pid: number): Promise<boolean> {
  if (process.platform === "win32") return false;
  return new Promise((resolve) => {
    execFile("ps", ["-o", "state=", "-p", String(pid)], { timeout: 1500 }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(stdout.trim().toUpperCase().startsWith("Z"));
    });
  });
}

/** The pid of a collector already running on this device, if any. */
export async function runningCollectorPid(home = homeDir()): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(pidFile(home), "utf8")).trim(), 10);
    if (pid === process.pid || !isProcessAlive(pid)) return undefined;
    if (await isZombieProcess(pid)) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/** Process list lines that are the Flutter Memento app (whose built-in collector writes no pid file). */
export function flutterAppPids(
  psOutput: string,
  platform: NodeJS.Platform = process.platform,
  excludePids: number[] = [],
): number[] {
  const exclude = new Set(excludePids);
  const electronBundles = new Set<string>();

  if (platform === "darwin") {
    for (const raw of psOutput.split("\n")) {
      const line = raw.trim();
      const m = /^(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const cmd = m[2]!;
      const helperMatch = /(^.*\.app)\/Contents\/Frameworks\/.*Helper.*\.app/i.exec(cmd);
      if (helperMatch) {
        electronBundles.add(helperMatch[1]!);
      }
    }
  }

  const pids: number[] = [];
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (exclude.has(pid)) continue;
    const cmd = m[2]!;
    if (platform === "darwin") {
      const appMatch = /(^.*\.app)\/Contents\/MacOS\/Memento$/.exec(cmd);
      if (appMatch && !electronBundles.has(appMatch[1]!)) {
        pids.push(pid);
      }
    } else if (platform === "win32") {
      if (/(^|\\)memento\.exe$/i.test(cmd)) {
        pids.push(pid);
      }
    } else {
      if (/(^|\/)memento$/.test(cmd)) {
        pids.push(pid);
      }
    }
  }
  return pids;
}

/** Whether the Flutter desktop app is running (it collects in-process unless it sees our pid file). */
export async function flutterAppRunning(excludePids: number[] = []): Promise<boolean> {
  const list = await new Promise<string>((resolve) => {
    if (process.platform === "win32") {
      // In Flutter desktop on Windows, the app process loads flutter_windows.dll.
      // Searching only for processes loading flutter_windows.dll avoids false positives
      // from Electron's own child processes (which are all named memento.exe).
      execFile("tasklist", ["/M", "flutter_windows.dll", "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) =>
        resolve(
          err
            ? ""
            : String(stdout)
                .split("\n")
                .map((l) => l.split('","'))
                .filter((c) => c.length > 1)
                .map((c) => `${c[1]} ${c[0]!.replace(/^"/, "")}`)
                .join("\n"),
        ),
      );
    } else {
      execFile("ps", ["-axo", "pid=,comm="], (err, stdout) => resolve(err ? "" : String(stdout)));
    }
  });
  return flutterAppPids(list, process.platform, excludePids).length > 0;
}

/** Claims the pid file; false when another live collector holds it. Released on exit. */
export async function acquirePidFile(home = homeDir()): Promise<boolean> {
  if (await runningCollectorPid(home)) return false;
  const file = pidFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, String(process.pid));
  // Synchronous: async work never finishes in an exit hook.
  const release = () => {
    try {
      // Only remove it if it's still ours.
      if (readFileSync(file, "utf8").trim() === String(process.pid)) rmSync(file);
    } catch {
      // gone already
    }
  };
  process.once("exit", release);
  return true;
}

/**
 * Starting the headless daemon at login (the desktop app uses the OS login-item
 * setting instead): a launchd agent on macOS, a systemd user unit on Linux, a
 * Run key on Windows. `command` is the full command line, e.g. [node, cli.js, "run"].
 */
export const SERVICE_LABEL = "com.memento.daemon";

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(command: string[], logFile: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${command.map((c) => `        <string>${xmlEscape(c)}</string>`).join("\n")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`;
}

const quoteArg = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export function systemdUnit(command: string[]): string {
  return `[Unit]
Description=Memento daemon (collector and agent task runner)
After=network-online.target

[Service]
ExecStart=${command.map(quoteArg).join(" ")}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err) => resolve(!err)));
}

const paths = (home: string) => ({
  plist: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
  unit: join(home, ".config", "systemd", "user", "memento-daemon.service"),
  log: join(mementoDir(home), "daemon.log"),
});

const WIN_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WIN_VALUE = "MementoDaemon";

export async function installService(command: string[], home = homeDir()): Promise<string> {
  const p = paths(home);
  if (process.platform === "darwin") {
    await mkdir(dirname(p.plist), { recursive: true });
    await mkdir(dirname(p.log), { recursive: true });
    await run("launchctl", ["unload", p.plist]);
    await writeFile(p.plist, launchdPlist(command, p.log));
    await run("launchctl", ["load", "-w", p.plist]);
    return p.plist;
  }
  if (process.platform === "linux") {
    await mkdir(dirname(p.unit), { recursive: true });
    await writeFile(p.unit, systemdUnit(command));
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", "memento-daemon.service"]);
    return p.unit;
  }
  if (process.platform === "win32") {
    const ok = await run("reg", ["add", WIN_RUN_KEY, "/v", WIN_VALUE, "/t", "REG_SZ", "/d", command.map(quoteArg).join(" "), "/f"]);
    if (!ok) throw new Error("写入注册表启动项失败");
    return `${WIN_RUN_KEY}\\${WIN_VALUE}`;
  }
  throw new Error(`不支持的平台: ${process.platform}`);
}

export async function uninstallService(home = homeDir()): Promise<void> {
  const p = paths(home);
  if (process.platform === "darwin") {
    if (existsSync(p.plist)) {
      await run("launchctl", ["unload", "-w", p.plist]);
      await rm(p.plist, { force: true });
    }
  } else if (process.platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", "memento-daemon.service"]);
    await rm(p.unit, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
  } else if (process.platform === "win32") {
    await run("reg", ["delete", WIN_RUN_KEY, "/v", WIN_VALUE, "/f"]);
  }
}

export async function isServiceInstalled(home = homeDir()): Promise<boolean> {
  const p = paths(home);
  if (process.platform === "darwin") return existsSync(p.plist);
  if (process.platform === "linux") return existsSync(p.unit);
  if (process.platform === "win32") return run("reg", ["query", WIN_RUN_KEY, "/v", WIN_VALUE]);
  return false;
}
