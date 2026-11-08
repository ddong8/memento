// Cross-platform helpers for the installer: output, subprocesses, executable lookup, port probes,
// prompts, Python and GPU detection.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { connect } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";
export const IS_WINDOWS = process.platform === "win32";
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// ── output ────────────────────────────────────────────────────
const color = !process.env.NO_COLOR && !!process.stdout.isTTY;
const sgr = (code: string) => (color ? `\x1b[${code}m` : "");
export const C = {
  reset: sgr("0"),
  bold: sgr("1"),
  dim: sgr("2"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  cyan: sgr("36"),
};

export const ok = (msg: string) => console.log(`${C.green}✓${C.reset} ${msg}`);
export const info = (msg: string) => console.log(`${C.cyan}·${C.reset} ${msg}`);
export const warn = (msg: string) => console.log(`${C.yellow}!${C.reset} ${msg}`);
export const fail = (msg: string) => console.error(`${C.red}✗${C.reset} ${msg}`);

export function heading(msg: string): void {
  console.log();
  console.log(`${C.bold}${msg}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(Math.min([...msg].length, 60))}${C.reset}`);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs a step; on failure prints the hint and rethrows. */
export async function step<T>(name: string, fn: () => T | Promise<T>, hint?: string): Promise<T> {
  info(`${name}…`);
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Interrupted) throw e;
    fail(`${name} failed: ${errorText(e)}`);
    if (hint) console.log(`  ${C.dim}hint:${C.reset} ${hint}`);
    throw e;
  }
}

// ── subprocesses ──────────────────────────────────────────────
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Throw when the command can't start or exits non-zero. */
  check?: boolean;
  /** Collect stdout/stderr instead of passing them through to the terminal. */
  capture?: boolean;
  timeoutMs?: number;
  /** Through the shell: what Windows needs to start npm.cmd. */
  shell?: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): RunResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: opts.capture ? ["inherit", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    timeout: opts.timeoutMs,
    shell: opts.shell,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Ctrl-C reaches the child first (same process group): treat it as interrupting the installer
  if (r.signal === "SIGINT") throw new Interrupted();
  const res: RunResult = { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  if (opts.check && (r.error || r.status !== 0)) {
    const shown = [cmd, ...args].join(" ");
    throw new Error(r.error ? `${shown}: ${r.error.message}` : `Command '${shown}' returned non-zero exit status ${r.status ?? r.signal}.`);
  }
  return res;
}

const isExecutable = (p: string) => {
  try {
    if (!statSync(p).isFile()) return false;
    if (!IS_WINDOWS) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The executable `cmd` resolves to on PATH (PATHEXT on Windows), like shutil.which. */
export function which(cmd: string): string | undefined {
  const exts = IS_WINDOWS ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const forms = (base: string) =>
    IS_WINDOWS && !exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase())) ? exts.map((e) => base + e) : [base];
  if (cmd.includes("/") || (IS_WINDOWS && cmd.includes("\\"))) return forms(cmd).find(isExecutable);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = forms(join(dir, cmd)).find(isExecutable);
    if (hit) return hit;
  }
  return undefined;
}

// ── prompts ───────────────────────────────────────────────────
/** Ctrl-C at a prompt. */
export class Interrupted extends Error {}

/** One line from the terminal; rejects on end of input like Python's EOFError. */
export function ask(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    let settled = false;
    rl.on("SIGINT", () => {
      settled = true;
      rl.close();
      process.stdout.write("\n");
      reject(new Interrupted());
    });
    rl.once("close", () => {
      if (!settled) reject(new Error("EOF when reading a line"));
    });
    rl.question(prompt, (answer) => {
      settled = true;
      rl.close();
      resolve(answer);
    });
  });
}

/** A line typed without echo (passwords). */
export function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(prompt);
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(new Interrupted());
        if (ch === "\u0004") return value ? finish() : finish(new Error("EOF when reading a line"));
        if (ch === "\u007f" || ch === "\b") {
          value = [...value].slice(0, -1).join("");
        } else if (ch >= " ") {
          value += ch;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

// ── port + service probes ─────────────────────────────────────
export function portInUse(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (inUse: boolean) => {
      sock.destroy();
      resolve(inUse);
    };
    sock.setTimeout(500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export function dockerAvailable(): boolean {
  if (!which("docker")) return false;
  const r = run("docker", ["info"], { capture: true, timeoutMs: 8000 });
  return !r.error && r.status === 0;
}

export function dockerStartHint(): string {
  if (IS_MAC) return "Open Docker Desktop (Applications → Docker).";
  if (IS_WINDOWS) return "Open Docker Desktop from the Start Menu.";
  return "Run: sudo systemctl start docker";
}

/** Whether this installer runs on a full Node.js (with npm next to it), not the Memento app's runtime. */
export const onNode = !process.versions.electron;

/** npm for the Node running this installer, else the one on PATH. */
export function npmPath(): string | undefined {
  if (!onNode) return which("npm");
  const beside = join(dirname(process.execPath), IS_WINDOWS ? "npm.cmd" : "npm");
  return existsSync(beside) ? beside : which("npm");
}

// ── Python (only the native embedding install and the retired pip collector need it) ──
/**
 * A usable Python 3.11+ for the embedding venv. Beyond the version, `ctypes` and `venv` must import:
 * a Python built without libffi-dev (common with pyenv on minimal Linux images) starts fine but fails
 * the moment torch imports ctypes, 1.3GB into the model download.
 */
export function findPython(): string {
  const candidates = [
    process.env.MEMENTO_EMBEDDING_PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "/opt/homebrew/opt/python@3.11/bin/python3.11",
    "/usr/local/opt/python@3.11/bin/python3.11",
    "python3",
    "python",
  ];
  let sawBrokenCtypes = false;
  for (const c of candidates) {
    if (!c) continue;
    const exe = which(c) ?? (existsSync(c) ? c : undefined);
    if (!exe) continue;
    const r = run(exe, ["-c", "import sys, ctypes, venv; print(sys.version_info[:2])"], { capture: true, timeoutMs: 5000 });
    if (r.error) continue;
    if (r.status !== 0) {
      if (`${r.stdout}${r.stderr}`.includes("_ctypes")) sawBrokenCtypes = true;
      continue;
    }
    const m = /\((\d+),\s*(\d+)\)/.exec(r.stdout);
    if (m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 11))) return exe;
  }
  if (sawBrokenCtypes) {
    throw new Error(
      "Found Python 3.11+ but it was built without _ctypes — torch/numpy won't work. " +
        "This typically means the pyenv build skipped libffi-dev.\n" +
        "Fix on Ubuntu/Debian:\n" +
        "  sudo apt install -y libffi-dev libssl-dev libbz2-dev \\\n" +
        "                       libreadline-dev libsqlite3-dev zlib1g-dev\n" +
        "  pyenv install --force 3.11.15   # rebuild against new libs\n" +
        "Or use the system Python instead:\n" +
        "  sudo apt install -y python3.12 python3.12-venv\n" +
        "  MEMENTO_EMBEDDING_PYTHON=$(which python3.12) ./install.sh embedding",
    );
  }
  throw new Error(
    "Python 3.11+ not found. Install it first:\n" +
      "  macOS:   brew install python@3.11\n" +
      "  Linux:   sudo apt install python3.11 python3.11-venv\n" +
      "  Windows: winget install Python.Python.3.11",
  );
}

/** 'mps' | 'cuda' | 'cpu'. */
export function detectAccelerator(): "mps" | "cuda" | "cpu" {
  if (IS_MAC && process.arch === "arm64") return "mps";
  if (which("nvidia-smi")) {
    const r = run("nvidia-smi", [], { capture: true, timeoutMs: 5000 });
    if (!r.error && r.status === 0) return "cuda";
  }
  return "cpu";
}
