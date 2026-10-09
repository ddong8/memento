#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { acquirePidFile, flutterAppRunning, installService, isServiceInstalled, runningCollectorPid, uninstallService } from "./autostart.js";
import { loadConfig, saveConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { LocalApi, readLocalApiInfo } from "./local-api.js";

const USAGE = `memento-daemon <command>

  run [--force]       运行守护进程（默认）；--force 即使旧版桌面端在运行也启动
  status              查看正在运行的守护进程状态
  login <token> [url] 保存 collector token（和服务器地址）
  install-service     登录时自动启动（macOS launchd / Linux systemd / Windows 启动项）
  uninstall-service   取消自动启动
`;

async function run(force = false): Promise<void> {
  const other = await runningCollectorPid();
  if (other) {
    console.error(`另一个 Memento 采集进程已在运行 (pid ${other})，退出。`);
    process.exit(1);
  }
  if (!force && !process.env.MEMENTO_DAEMON_FORCE && !process.env.MEMENTO_DAEMON_EMBEDDED && (await flutterAppRunning())) {
    console.error("旧版 Memento 桌面端正在运行，它自带采集；为避免重复上传不再启动。退出旧版后重试，或加 --force。");
    process.exit(3);
  }
  await acquirePidFile();
  const daemon = new Daemon();
  daemon.on("log", (line: string) => console.log(line));
  const api = new LocalApi(daemon);
  const info = await api.start(Number(process.env.MEMENTO_DAEMON_PORT ?? 0));
  daemon.log(`Local API on 127.0.0.1:${info.port}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    daemon.log(`${signal}: shutting down`);
    await daemon.stop();
    await api.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await daemon.start();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    await api.stop();
    process.exit(1);
  }
}

async function status(): Promise<void> {
  const info = await readLocalApiInfo();
  if (!info) {
    console.log(`守护进程未运行。自动启动：${(await isServiceInstalled()) ? "已开启" : "未开启"}`);
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, { headers: { Authorization: `Bearer ${info.token}` } });
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch {
    console.log(`守护进程 (pid ${info.pid}) 没有响应。`);
  }
}

async function login(token: string | undefined, url: string | undefined): Promise<void> {
  if (!token) throw new Error("用法: memento-daemon login <collector token> [服务器地址]");
  const config = await loadConfig();
  await saveConfig({ ...config, token, ...(url ? { serverUrl: url.replace(/\/+$/, "") } : {}) });
  console.log(`已保存，设备 ${config.deviceName}（${config.deviceId}）。`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [cmd = "run", ...rest] = argv;
  switch (cmd) {
    case "run":
      return run(rest.includes("--force"));
    case "status":
      return status();
    case "login":
      return login(rest[0], rest[1]);
    case "install-service": {
      const self = fileURLToPath(import.meta.url);
      console.log(`已设置自动启动：${await installService([process.execPath, self, "run"])}`);
      return;
    }
    case "uninstall-service":
      await uninstallService();
      console.log("已取消自动启动。");
      return;
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return;
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

// Run when executed directly (also through the npm bin symlink), not when imported
// or bundled into a host that calls main() itself.
const invoked = (() => {
  if (process.env.MEMENTO_DAEMON_EMBEDDED) return false;
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
