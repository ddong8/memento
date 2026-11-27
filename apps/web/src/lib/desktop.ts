/** How collection is going (packages/daemon/src/watcher.ts CollectStats); null before v1.0.95. */
export interface CollectStats {
  files: number;
  queued: number;
  urgent: number;
  failing: number;
  backoff_until: string | null;
  uploads: number;
  bytes: number;
  conflicts: number;
  reconciled: number;
  resent: number;
  last_upload_at: string | null;
  last_reconcile_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  started_at: string;
}

/** What the Memento desktop app exposes to the web UI (apps/desktop/src/preload.ts). */
interface DaemonStatus {
  running: boolean;
  online: boolean;
  deviceName: string;
  deviceId: string;
  serverUrl: string;
  tools: Record<string, { root?: string; projects?: { name: string; path: string }[] } & Record<string, unknown>>;
  runningTasks: string[];
  startedAt: string | null;
  collect?: CollectStats | null;
}

export interface DaemonState {
  mode: "starting" | "running" | "external" | "stopped" | "no-token" | "crashed";
  label: string;
  status: DaemonStatus | null;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  openAtLogin: boolean;
  packaged: boolean;
  nativeGlass?: boolean;
  glassEnabled?: boolean;
  /** How AI tools start the MCP server bundled with the app. */
  mcp?: { command: string; args: string[]; env: Record<string, string> };
}

/** Ready-to-paste MCP setup for the common AI tools. */
export function mcpSnippets(mcp: NonNullable<DesktopInfo["mcp"]>): { claude: string; codex: string; json: string } {
  const q = (v: string) => JSON.stringify(v);
  const envFlags = Object.entries(mcp.env).map(([k, v]) => `-e ${k}=${v}`).join(" ");
  return {
    claude: `claude mcp add memento-memory -s user ${envFlags} -- ${[mcp.command, ...mcp.args].map(q).join(" ")}`,
    codex: [
      "[mcp_servers.memento-memory]",
      `command = ${q(mcp.command)}`,
      `args = [${mcp.args.map(q).join(", ")}]`,
      `env = { ${Object.entries(mcp.env).map(([k, v]) => `${k} = ${q(v)}`).join(", ")} }`,
    ].join("\n"),
    json: JSON.stringify({ mcpServers: { "memento-memory": { command: mcp.command, args: mcp.args, env: mcp.env } } }, null, 2),
  };
}

export interface ServerInfo {
  current: string;
  webUrl?: string;
  defaultUrl: string;
  /** The company's IT fixed the server on this computer (managed policy): switching is refused */
  locked?: boolean;
}

export interface ServerTestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

/** 单机模式: a personal server on this computer (desktop src/local-server.ts). */
export interface LocalServerStatus {
  docker: "missing" | "stopped" | "ready";
  installed: boolean;
  running: boolean;
  url: string;
  dir: string;
}

export interface LocalServerResult {
  ok: boolean;
  url?: string;
  error?: string;
  code?: string;
}

export interface MementoDesktop {
  isDesktop: true;
  /** v1.0.156+: true when macOS vibrancy or Windows 11 Mica native backdrop is supported by this window. */
  nativeGlass?: boolean;
  info(): Promise<DesktopInfo>;
  setOpenAtLogin(on: boolean): Promise<boolean>;
  /** v1.0.126+: what the system draws (title bar, scroll bars, menus) follows the page's light/dark. */
  setTheme?(theme: "light" | "dark" | "system"): Promise<string>;
  /** v1.0.156+: toggle native window frosted glass material (macOS vibrancy / Windows 11 Mica). */
  setGlass?(on: boolean): Promise<{ enabled: boolean; nativeGlass: boolean }>;
  /** v1.0.128+: an action menu as the system's menu; the chosen item's id, null when closed without one. */
  popupMenu?(items: unknown[], pos?: { x: number; y: number }): Promise<string | null>;
  checkForUpdates(): Promise<void>;
  notify?(options: { title: string; body: string; url?: string }): Promise<boolean>;
  openExternal?(url: string): Promise<void>;
  openPath?(path: string): Promise<string>;
  showItemInFolder?(path: string): Promise<void>;
  readFile?(path: string): Promise<{ content?: string; error?: string }>;
  toMediaUrl?(path: string): string;
  /** v1.0.103+: memento-media:// URLs take ?remote=<server relay URL>, used when the file isn't on this computer. */
  mediaFallback?: boolean;
  server?: {
    get(): Promise<ServerInfo>;
    set(options: { url: string; resetAuth?: boolean }): Promise<{ ok: boolean; error?: string }>;
    test(url: string): Promise<ServerTestResult>;
    onOpenSwitch?(cb: () => void): () => void;
  };
  /** Desktop 1.0.167+ */
  localServer?: {
    status: () => Promise<LocalServerStatus>;
    start: () => Promise<LocalServerResult>;
    stop: () => Promise<{ ok: boolean; error?: string }>;
    onProgress: (cb: (line: unknown) => void) => () => void;
  };
  daemon: {
    status(): Promise<DaemonState>;
    logs(): Promise<string[]>;
    action(name: "resync" | "rediscover" | "sync-profile"): Promise<unknown>;
    onStatus(cb: (s: DaemonStatus) => void): () => void;
    onLog(cb: (line: string) => void): () => void;
    onMode(cb: (m: { mode: DaemonState["mode"]; label: string }) => void): () => void;
  };
}

/** The desktop bridge, or null in a plain browser. */
export function desktop(): MementoDesktop | null {
  if (typeof window === "undefined") return null;
  const d = (window as unknown as { mementoDesktop?: MementoDesktop }).mementoDesktop;
  return d?.isDesktop ? d : null;
}
