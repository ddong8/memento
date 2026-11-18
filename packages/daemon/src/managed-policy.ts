import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * A policy the company's IT puts on the computer (pushed by MDM / group policy), above what the
 * user can change in the app. One JSON file, readable by everyone, writable only by administrators:
 *
 *   macOS    /Library/Application Support/Memento/managed.json
 *   Windows  %ProgramData%\Memento\managed.json
 *   Linux    /etc/memento/managed.json
 *   (MEMENTO_MANAGED_CONFIG points somewhere else, for testing)
 *
 *   {
 *     "server_url": "https://memento.corp.example.com",  // connect here; the app can't switch away
 *     "remote_tasks": "agent",                           // all | agent | none (see below)
 *     "allowed_roots": ["~/work", "/srv/repos"]          // the only directories the server may reach
 *   }
 *
 * remote_tasks: what the server may start on this computer. "all" (default) runs agents and shell
 * commands; "agent" runs coding agents but no bare shell commands; "none" runs nothing.
 * allowed_roots: tasks run, and files are read, written or packed up for another device, only inside
 * these directories (and below). Empty / absent: anywhere the user can reach, as before.
 */
export interface ManagedPolicy {
  serverUrl?: string;
  remoteTasks: "all" | "agent" | "none";
  allowedRoots: string[];
  /** The file it came from, when there is one */
  source?: string;
}

const NONE: ManagedPolicy = { remoteTasks: "all", allowedRoots: [] };

export function managedPolicyPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MEMENTO_MANAGED_CONFIG) return env.MEMENTO_MANAGED_CONFIG;
  if (platform === "darwin") return "/Library/Application Support/Memento/managed.json";
  if (platform === "win32") return join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "Memento", "managed.json");
  return "/etc/memento/managed.json";
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Parse the file's text; anything malformed is ignored field by field (a broken file must not lock the user out). */
export function parseManagedPolicy(text: string, home: string = homedir(), source?: string): ManagedPolicy {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...NONE, ...(source ? { source } : {}) };
  }
  const url = typeof raw.server_url === "string" ? raw.server_url.trim().replace(/\/+$/, "") : "";
  const tasks = raw.remote_tasks === "agent" || raw.remote_tasks === "none" ? raw.remote_tasks : "all";
  const roots = Array.isArray(raw.allowed_roots)
    ? raw.allowed_roots
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .map((r) => resolve(expandHome(r.trim(), home)))
        .filter((r) => isAbsolute(r))
    : [];
  return {
    ...(/^https?:\/\/[^/]/.test(url) ? { serverUrl: url } : {}),
    remoteTasks: tasks,
    allowedRoots: roots,
    ...(source ? { source } : {}),
  };
}

let cached: ManagedPolicy | undefined;

/** The policy in effect (read once per process; a changed file takes effect when the app restarts). */
export function managedPolicy(env: NodeJS.ProcessEnv = process.env): ManagedPolicy {
  if (cached) return cached;
  const path = managedPolicyPath(env);
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  cached = text === undefined ? NONE : parseManagedPolicy(text, homedir(), path);
  return cached;
}

/** For tests: forget the cached policy. */
export function resetManagedPolicy(policy?: ManagedPolicy): void {
  cached = policy;
}

/** Why the server may not start this task here, or null when it may. */
export function taskRefusal(action: string, policy: ManagedPolicy = managedPolicy()): string | null {
  if (policy.remoteTasks === "none") return "这台电脑的管理员策略不允许接收远程任务";
  if (policy.remoteTasks === "agent" && action !== "agent") return "这台电脑的管理员策略只允许运行智能体任务，不允许直接执行命令";
  return null;
}

/** Whether a path is inside one of the allowed directories (always, when none are set). */
export function pathAllowed(path: string, policy: ManagedPolicy = managedPolicy(), platform: NodeJS.Platform = process.platform): boolean {
  if (!policy.allowedRoots.length) return true;
  const norm = (p: string) => {
    const r = resolve(p);
    return platform === "win32" || platform === "darwin" ? r.toLowerCase() : r;
  };
  const target = norm(path);
  return policy.allowedRoots.some((root) => {
    const r = norm(root);
    return target === r || target.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

/** Throws when the path is outside the allowed directories. */
export function assertPathAllowed(path: string, policy: ManagedPolicy = managedPolicy()): string {
  if (!pathAllowed(path, policy)) {
    throw new Error(`这台电脑的管理员策略不允许访问 ${path}（只允许 ${policy.allowedRoots.join("、")}）`);
  }
  return path;
}
