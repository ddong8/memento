import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { homeDir } from "./config.js";

/** Keys a GUI-launched daemon doesn't inherit from the login shell but agents need. */
const SHELL_KEYS = new Set([
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
]);

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `export KEY="value"` lines from shell rc files, for the keys agents need. */
export function parseShellExports(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.includes(";")) value = value.slice(0, value.indexOf(";")).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (SHELL_KEYS.has(key) && value && !(key in out)) out[key] = value;
  }
  return out;
}

function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh");
  return new Promise((resolve) => {
    execFile(shell, ["-ilc", 'echo -n "$PATH"'], { timeout: 1500 }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  });
}

let cachedEnv: NodeJS.ProcessEnv | undefined;

/**
 * The environment agent tasks run in. A daemon started by launchd or a desktop
 * app gets a minimal PATH and none of the user's shell exports, so this adds the
 * login shell's PATH, the usual tool directories and the API keys agents read.
 */
export async function executionEnvironment(): Promise<NodeJS.ProcessEnv> {
  if (cachedEnv) return { ...cachedEnv };
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  // Dispatched tasks mustn't look like subagents of a dead Antigravity conversation.
  for (const k of ["ANTIGRAVITY_SOURCE_METADATA", "ANTIGRAVITY_CONVERSATION_ID", "ANTIGRAVITY_AGENT", "ANTIGRAVITY_TRAJECTORY_ID"]) {
    delete env[k];
  }
  const home = homeDir();

  if (process.platform === "darwin" || process.platform === "linux") {
    for (const rc of [".zshrc", ".bash_profile", ".bashrc", ".profile"]) {
      try {
        for (const [k, v] of Object.entries(parseShellExports(await readFile(posix.join(home, rc), "utf8")))) {
          if (env[k] === undefined) env[k] = v;
        }
      } catch {
        // no such rc file
      }
    }
    const parts = (env.PATH ?? "").split(":").filter(Boolean);
    const shellPath = await loginShellPath();
    for (const p of shellPath?.split(":") ?? []) if (p && !parts.includes(p) && isDir(p)) parts.unshift(p);
    const extra = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      `${home}/.local/bin`,
      `${home}/.cargo/bin`,
      `${home}/go/bin`,
      `${home}/.npm-global/bin`,
      `${home}/.volta/bin`,
      `${home}/.fnm/current/bin`,
      `${home}/.asdf/shims`,
      `${home}/.gemini/antigravity/bin`,
      `${home}/.antigravity/antigravity/bin`,
      `${home}/.workbuddy/bin`,
      "/Applications/ChatGPT.app/Contents/Resources",
    ];
    for (const base of [`${home}/.nvm/versions/node`, `${home}/.asdf/installs/nodejs`]) {
      try {
        for (const d of readdirSync(base)) extra.push(`${base}/${d}/bin`);
      } catch {
        // not installed
      }
    }
    for (const d of extra) if (!parts.includes(d) && isDir(d)) parts.unshift(d);
    env.PATH = parts.join(":");
  } else if (process.platform === "win32") {
    const extra = [
      `${home}\\AppData\\Roaming\\npm`,
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
      `${home}\\AppData\\Local\\Programs\\node`,
      `${home}\\AppData\\Local\\agy\\bin`,
      `${home}\\AppData\\Local\\workbuddy\\bin`,
      `${home}\\AppData\\Local\\Programs\\Antigravity`,
      `${home}\\AppData\\Local\\Programs\\WorkBuddy`,
      `${home}\\AppData\\Local\\Programs`,
      `${home}\\.gemini\\antigravity\\bin`,
      `${home}\\.antigravity\\bin`,
      `${home}\\.workbuddy\\bin`,
      `${home}\\.cargo\\bin`,
      `${home}\\go\\bin`,
      `${home}\\.local\\bin`,
      `${home}\\AppData\\Local\\fnm_multishells\\current\\bin`,
    ];
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
    const parts = (env[key] ?? "").split(";");
    for (const d of extra) if (!parts.some((p) => p.toLowerCase() === d.toLowerCase()) && isDir(d)) parts.unshift(d);
    env[key] = parts.join(";");
  }
  cachedEnv = env;
  return { ...env };
}

/** The first of `names` found on the execution PATH. */
export async function findExecutable(names: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  const e = env ?? (await executionEnvironment());
  const isWin = process.platform === "win32";
  const pathKey = Object.keys(e).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (e[pathKey] ?? "").split(isWin ? ";" : ":").filter(Boolean);
  const exts = isWin ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const sep = isWin ? "\\" : "/";
  for (const name of names) {
    for (const ext of exts) {
      const target = name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`;
      for (const dir of dirs) {
        const file = `${dir}${sep}${target}`;
        try {
          if (statSync(file).isFile()) return file;
        } catch {
          // not here
        }
      }
    }
  }
  return undefined;
}

export interface ResolvedExecution {
  executable: string;
  args: string[];
}

/**
 * How to start `exe` on this OS. On Windows a batch wrapper can't be spawned
 * directly, so an npm (node) or python wrapper is resolved to the script it
 * runs, and any other batch file goes through `%COMSPEC% /d /c call`.
 */
export async function prepareCommand(
  exe: string,
  args: string[],
  options: {
    isWindows?: boolean;
    comSpec?: string;
    readText?: (path: string) => Promise<string | undefined>;
    exists?: (path: string) => boolean;
  } = {},
): Promise<ResolvedExecution> {
  const isWindows = options.isWindows ?? process.platform === "win32";
  if (!isWindows) return { executable: exe, args };
  const lower = exe.toLowerCase();
  if (!lower.endsWith(".cmd") && !lower.endsWith(".bat")) return { executable: exe, args };

  const exists = options.exists ?? existsSync;
  const readText = options.readText ?? ((p: string) => readFile(p, "utf8").catch(() => undefined));
  try {
    if (exists(exe)) {
      const content = (await readText(exe)) ?? "";
      const dir = win32.dirname(exe);
      const node = /["']?%(?:~)?dp0%?\\([^"\r\n']+\.js)["']?/.exec(content);
      if (node) {
        const js = win32.normalize(win32.join(dir, node[1]!.replaceAll("/", "\\")));
        if (exists(js)) {
          const localNode = win32.join(dir, "node.exe");
          return { executable: exists(localNode) ? localNode : "node", args: [js, ...args] };
        }
      }
      const py = /python(?:\.exe)?\s+["']?([^"\r\n']+\.py)["']?/.exec(content);
      if (py && exists(py[1]!)) return { executable: "python", args: [py[1]!, ...args] };
      const mjs = /node(?:\.exe)?\s+["']?([^"\r\n']+\.m?js)["']?/.exec(content);
      if (mjs && exists(mjs[1]!)) return { executable: "node", args: [mjs[1]!, ...args] };
    }
  } catch {
    // fall through to cmd
  }
  const comSpec = options.comSpec ?? process.env.COMSPEC ?? "cmd.exe";
  return { executable: comSpec, args: ["/d", "/c", "call", exe, ...args] };
}

/** Stops a task and everything it started (shells, test runners, dev servers). */
export function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { windowsHide: true }, (err) => {
      if (err) proc.kill("SIGKILL");
    });
    return;
  }
  try {
    // Tasks start in their own process group (spawned detached), so this reaches the children too.
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Puts the executable's own directory first on PATH, so `#!/usr/bin/env node` shebangs resolve. */
export function withExeDirOnPath(env: NodeJS.ProcessEnv, exe: string): NodeJS.ProcessEnv {
  const isWin = process.platform === "win32";
  const dir = (isWin ? win32 : posix).dirname(exe);
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = isWin ? ";" : ":";
  const parts = (env[key] ?? "").split(sep).filter(Boolean);
  if (dir && dir !== "." && !parts.includes(dir) && isDir(dir)) env[key] = [dir, ...parts].join(sep);
  return env;
}
