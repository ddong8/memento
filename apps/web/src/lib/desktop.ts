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
}

export interface DaemonState {
  mode: "starting" | "running" | "external" | "flutter" | "stopped" | "no-token" | "crashed";
  label: string;
  status: DaemonStatus | null;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  openAtLogin: boolean;
  packaged: boolean;
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
}

export interface ServerTestResult {
  ok: boolean;
  latencyMs: number;
  status?: number;
  error?: string;
}

export interface MementoDesktop {
  isDesktop: true;
  info(): Promise<DesktopInfo>;
  setOpenAtLogin(on: boolean): Promise<boolean>;
  checkForUpdates(): Promise<void>;
  notify?(options: { title: string; body: string; url?: string }): Promise<boolean>;
  openExternal?(url: string): Promise<void>;
  openPath?(path: string): Promise<string>;
  showItemInFolder?(path: string): Promise<void>;
  readFile?(path: string): Promise<{ content?: string; error?: string }>;
  toMediaUrl?(path: string): string;
  server?: {
    get(): Promise<ServerInfo>;
    set(options: { url: string; resetAuth?: boolean }): Promise<{ ok: boolean; error?: string }>;
    test(url: string): Promise<ServerTestResult>;
    onOpenSwitch?(cb: () => void): () => void;
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
