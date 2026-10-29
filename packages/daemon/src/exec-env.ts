import { execFile, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { homeDir } from "./config.js";
import { workbuddyBundledNode } from "./workbuddy.js";

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

/** What Claude Code sets for the commands it runs (2.1.311), naming its own session. */
export const CLAUDE_HOST_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "AI_AGENT",
];

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
  // Nor like children of the Claude Code session whose shell started memento (it exports these to its tools):
  // a run would count as that session's child and take its client name.
  for (const k of CLAUDE_HOST_KEYS) delete env[k];
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
    // Last resort for `node` (e.g. the WorkBuddy runner): the runtime WorkBuddy installs for its own CLI.
    const wbNode = workbuddyBundledNode(home);
    if (wbNode && !parts.includes(posix.dirname(wbNode))) parts.push(posix.dirname(wbNode));
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
    // Last resort for `node` (e.g. the WorkBuddy runner): the runtime WorkBuddy installs for its own CLI.
    const wbNode = workbuddyBundledNode(home);
    const wbNodeDir = wbNode ? win32.dirname(wbNode) : undefined;
    if (wbNodeDir && !parts.some((p) => p.toLowerCase() === wbNodeDir.toLowerCase())) parts.push(wbNodeDir);
    env[key] = parts.join(";");
  }
  cachedEnv = env;
  return { ...env };
}

/** The first of `names` found on the execution PATH (and not refused by `skip`). */
export async function findExecutable(
  names: string[],
  env?: NodeJS.ProcessEnv,
  skip?: (file: string) => boolean,
): Promise<string | undefined> {
  const e = env ?? (await executionEnvironment());
  const isWin = process.platform === "win32";
  const pathKey = Object.keys(e).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (e[pathKey] ?? "").split(isWin ? ";" : ":").filter(Boolean);
  const exts = isWin ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const sep = isWin ? "\\" : "/";
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const target = name.toLowerCase().endsWith(ext.toLowerCase()) ? name : `${name}${ext}`;
        const file = `${dir}${sep}${target}`;
        try {
          if (statSync(file).isFile() && !skip?.(file)) {
            // Guard: WorkBuddy.exe is Tencent's Electron desktop GUI app, not a task CLI runner.
            const lowerFile = file.toLowerCase();
            if (
              target.toLowerCase() === "workbuddy.exe" ||
              lowerFile.endsWith("\\workbuddy.exe") ||
              lowerFile.endsWith("/workbuddy.exe")
            ) {
              continue;
            }
            return file;
          }
        } catch {
          // not here
        }
      }
    }
  }
  return undefined;
}

/**
 * A Python 3 for our .py runners: python3 off Windows; on Windows python or
 * the py launcher, passing over the Microsoft Store's python.exe placeholder
 * (it only opens the Store) unless Python from the Store is installed.
 */
export async function findPython(env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform !== "win32") return findExecutable(["python3", "python"], env);
  const inWindowsApps = (f: string) => /\\microsoft\\windowsapps\\[^\\]+$/i.test(f);
  const found = await findExecutable(["python", "py", "python3"], env, inWindowsApps);
  if (found) return found;
  const alias = await findExecutable(["python", "python3"], env);
  if (!alias) return undefined;
  try {
    if (readdirSync(win32.dirname(alias)).some((n) => n.startsWith("PythonSoftwareFoundation.Python."))) return alias;
  } catch {
    // no Store Python
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
    python?: string;
  } = {},
): Promise<ResolvedExecution> {
  const isWindows = options.isWindows ?? process.platform === "win32";
  const python = async () => options.python ?? (await findPython()) ?? (isWindows ? "python" : "python3");
  const lower = exe.toLowerCase();
  // Not left to the shebang: the script may have lost its exec bit, and Windows has none.
  if (lower.endsWith(".py")) return { executable: await python(), args: [exe, ...args] };
  if (!isWindows) return { executable: exe, args };
  if (lower.endsWith(".mjs") || lower.endsWith(".js")) {
    return { executable: "node", args: [exe, ...args] };
  }
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
      if (py && exists(py[1]!)) return { executable: await python(), args: [py[1]!, ...args] };
      const mjs = /node(?:\.exe)?\s+["']?([^"\r\n']+\.m?js)["']?/.exec(content);
      if (mjs && exists(mjs[1]!)) return { executable: "node", args: [mjs[1]!, ...args] };
    }
  } catch {
    // fall through to cmd
  }
  const comSpec = options.comSpec ?? process.env.COMSPEC ?? "cmd.exe";
  return { executable: comSpec, args: ["/d", "/c", "call", exe, ...args] };
}

/** Recursively collect all descendant PIDs of a process on Unix/macOS. */
export function getUnixDescendantPids(rootPid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(rootPid)], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }
      const directChildren = stdout
        .trim()
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n > 0);
      if (directChildren.length === 0) {
        resolve([]);
        return;
      }
      Promise.all(directChildren.map((p) => getUnixDescendantPids(p))).then((nested) => {
        const all = new Set<number>(directChildren);
        for (const sub of nested) {
          for (const sp of sub) all.add(sp);
        }
        resolve(Array.from(all));
      });
    });
  });
}

/** Stops a task and everything it started (shells, test runners, dev servers, agent sub-processes). */
export function killProcessTree(proc: ChildProcess | undefined): void {
  if (!proc?.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  const pid = proc.pid;
  if (process.platform === "win32") {
    execFile("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }, (err) => {
      if (err) proc.kill("SIGKILL");
    });
    return;
  }

  // Unix / macOS: First try graceful SIGTERM, then hard SIGKILL to the entire process tree
  getUnixDescendantPids(pid)
    .then((descendants) => {
      // 1. Send SIGTERM to descendants and process group for graceful shutdown
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
      try {
        proc.kill("SIGTERM");
      } catch {}
      for (const d of descendants) {
        try {
          process.kill(d, "SIGTERM");
        } catch {}
      }

      // 2. Schedule hard SIGKILL after 800ms to clean up any stubborn agents (Claude, Codex, Antigravity, build tools)
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        try {
          proc.kill("SIGKILL");
        } catch {}
        for (const d of descendants) {
          try {
            process.kill(d, "SIGKILL");
          } catch {}
        }
        try {
          execFile("pkill", ["-9", "-P", String(pid)], () => {});
        } catch {}
      }, 800);
    })
    .catch(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      try {
        proc.kill("SIGKILL");
      } catch {}
      try {
        execFile("pkill", ["-9", "-P", String(pid)], () => {});
      } catch {}
    });
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
