import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * The daemon's settings, in ~/.memento (collector.json, device_id, remote_exec_key).
 * The desktop app's embedded daemon and the standalone daemon read the same files,
 * so switching between them keeps the device's identity, token and remote-exec enrollment.
 */
export interface CollectorConfig {
  serverUrl: string;
  token: string;
  deviceId: string;
  /** "haixingdeMac-mini (Darwin)": what the server shows the device as. */
  deviceName: string;
  /** "Darwin" | "Windows" | "Linux" */
  platform: string;
  remoteExecKey?: string;
  extraWatchDirs: string[];
  /** Where the web app is when it isn't on the server's own origin (self-hosted: :3001 next to the API on :8001). */
  webUrl?: string;
  /** Last visited route in the client (e.g. /app, /ask, /inbox) to restore on relaunch. */
  lastRoute?: string;
}

export const DEFAULT_SERVER_URL = "https://mem.ihasy.com";

/** The real home directory, also from inside a sandboxed macOS app container. */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return env.USERPROFILE ?? env.HOME ?? "C:\\Users\\Default";
  const home = env.HOME ?? "/";
  if (process.platform === "darwin" && home.includes("/Library/Containers/")) {
    const [outer] = home.split("/Library/Containers/");
    if (outer) return outer;
  }
  return home;
}

export const mementoDir = (home = homeDir()) => join(home, ".memento");
export const configPaths = (home = homeDir()) => {
  const dir = mementoDir(home);
  return {
    dir,
    config: join(dir, "collector.json"),
    legacyJson: join(dir, "config.json"),
    legacyToml: join(dir, "config.toml"),
    deviceId: join(dir, "device_id"),
    remoteExecKey: join(dir, "remote_exec_key"),
  };
};

export function platformLabel(p: NodeJS.Platform = osPlatform()): string {
  if (p === "darwin") return "Darwin";
  if (p === "win32") return "Windows";
  if (p === "linux") return "Linux";
  return p;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function newDeviceId(): string {
  // Existing devices already carry ids of this shape; new ones match them.
  const now = BigInt(Date.now()) * 1000n;
  return `memento-${now.toString(16)}-${randomBytes(4).toString("hex")}`;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Load from disk, environment, then defaults — in that order of precedence. */
export async function loadConfig(options: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CollectorConfig> {
  const env = options.env ?? process.env;
  const paths = configPaths(options.home ?? homeDir(env));
  let serverUrl = env.MEMENTO_SERVER_URL ?? DEFAULT_SERVER_URL;
  let token = env.MEMENTO_SERVER_TOKEN ?? "";
  let execKey = env.MEMENTO_REMOTE_EXEC_KEY;
  const extraWatchDirs: string[] = [];
  let webUrl = env.MEMENTO_WEB_URL || undefined;

  let deviceId = (await readText(paths.deviceId))?.trim() ?? "";
  if (!deviceId) {
    deviceId = newDeviceId();
    try {
      await mkdir(paths.dir, { recursive: true });
      await writeFile(paths.deviceId, deviceId);
    } catch {
      // A read-only home still gets an id for this run.
    }
  }

  if (!execKey) execKey = (await readText(paths.remoteExecKey))?.trim() || undefined;

  const json = await readText(paths.config);
  const legacy = json === undefined ? await readText(paths.legacyJson) : undefined;
  try {
    if (json !== undefined || legacy !== undefined) {
      const map = JSON.parse((json ?? legacy)!) as Record<string, unknown>;
      if (nonEmpty(map.server_url)) serverUrl = map.server_url;
      if (nonEmpty(map.token)) token = map.token;
      else if (nonEmpty(map.server_token)) token = map.server_token;
      if (json !== undefined) {
        if (nonEmpty(map.remote_exec_key)) execKey = map.remote_exec_key;
        if (Array.isArray(map.extra_watch_dirs)) extraWatchDirs.push(...map.extra_watch_dirs.filter(nonEmpty));
        if (!webUrl && nonEmpty(map.web_url)) webUrl = map.web_url;
      } else if (nonEmpty(map.obsidian_vault_path)) {
        extraWatchDirs.push(map.obsidian_vault_path);
      }
    } else {
      const toml = await readText(paths.legacyToml);
      for (const line of toml?.split("\n") ?? []) {
        const t = line.trim();
        const value = () => t.split("=").pop()!.trim().replace(/["']/g, "");
        if (t.startsWith("url") && t.includes("=") && value()) serverUrl = value();
        else if (t.startsWith("token") && t.includes("=") && value()) token = value();
      }
    }
  } catch {
    // A broken config file falls back to environment and defaults.
  }

  const plat = platformLabel();
  return {
    serverUrl: serverUrl.replace(/\/+$/, ""),
    token,
    deviceId,
    deviceName: `${hostname()} (${plat})`,
    platform: plat,
    remoteExecKey: execKey || undefined,
    extraWatchDirs,
    ...(webUrl ? { webUrl: webUrl.replace(/\/+$/, "") } : {}),
  };
}

/**
 * The config with the remote-exec key a heartbeat returned, or null when there is nothing to change (no
 * key, or the one already held). The server only hands one out once remote execution is on, which can be
 * long after the daemon started.
 */
export function withRemoteExecKey(config: CollectorConfig, key: string | undefined): CollectorConfig | null {
  if (!key || key === config.remoteExecKey) return null;
  return { ...config, remoteExecKey: key };
}

export async function saveConfig(config: CollectorConfig, home = homeDir()): Promise<void> {
  const paths = configPaths(home);
  await mkdir(paths.dir, { recursive: true });
  const data = {
    server_url: config.serverUrl,
    token: config.token,
    device_id: config.deviceId,
    device_name: config.deviceName,
    platform: config.platform,
    ...(config.remoteExecKey ? { remote_exec_key: config.remoteExecKey } : {}),
    extra_watch_dirs: config.extraWatchDirs,
    ...(config.webUrl ? { web_url: config.webUrl } : {}),
    updated_at: new Date().toISOString(),
  };
  await writeFile(paths.config, JSON.stringify(data, null, 2));
  if (config.remoteExecKey) await writeFile(paths.remoteExecKey, config.remoteExecKey);
}
