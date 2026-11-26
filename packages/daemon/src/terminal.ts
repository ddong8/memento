// Terminals the web app opens on this device (the conversation's terminal panel): a real pty running the user's
// shell in the project folder. Output goes up as task_chunk frames under the terminal's id (the server relays
// those to whoever watches, on any replica); input, resize and close come down as term_* frames.
// node-pty is a native module loaded lazily: without it (a build that didn't ship it) terminals just aren't
// offered (the "terminal" feature), everything else works as before.
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The part of node-pty this file uses. */
interface Pty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pid: number;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; useConpty?: boolean }): Pty;
}

let ptyModule: PtyModule | null | undefined;

const PTY_PACKAGES = ["node-pty", "@lydell/node-pty"] as const;

/** node-pty, or null when this build can't load it. */
export function loadPty(): PtyModule | null {
  if (ptyModule !== undefined) return ptyModule;
  const req = createRequire(import.meta.url);
  ptyModule = null;
  // Microsoft's node-pty has prebuilt binaries for macOS and Windows only; on Linux it has to compile, which a
  // server without g++ can't do (vps3, 2026-11-26). @lydell/node-pty ships every platform's binary as its own
  // npm package (Linux x64/arm64 too), so it's the fallback.
  for (const name of PTY_PACKAGES) {
    try {
      if (name === "node-pty") ensureSpawnHelperExecutable(req);
      ptyModule = req(name) as PtyModule;
      break;
    } catch {
      // next
    }
  }
  return ptyModule;
}

/**
 * node-pty 1.1's macOS prebuilds lose the execute bit of their spawn-helper when npm unpacks them, and every
 * spawn then fails with "posix_spawnp failed". Put it back where we can (the packaged app sets it at build time).
 */
function ensureSpawnHelperExecutable(req: NodeJS.Require): void {
  if (process.platform === "win32") return;
  try {
    const root = dirname(req.resolve("node-pty/package.json"));
    for (const dir of [join(root, "prebuilds", `${process.platform}-${process.arch}`), join(root, "build", "Release")]) {
      const helper = join(dir, "spawn-helper");
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch {
    // read-only install: the build already set it, or spawning reports the problem
  }
}

/** The user's login shell, the way their own terminal starts it. */
export function defaultShell(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (platform === "win32") {
    const pwsh = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"].find((p) => existsSync(p));
    return { file: pwsh ?? "powershell.exe", args: ["-NoLogo"] };
  }
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : platform === "darwin" ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return { file: shell, args: ["-l"] };
}

const MAX_TERMINALS = 6;
/** A terminal nobody typed into or watched for this long is closed (its shell too). */
const IDLE_MS = 45 * 60_000;
/** Output is sent in small batches: a burst (cat of a big file) becomes a few frames, not thousands. */
const FLUSH_MS = 16;
const FLUSH_BYTES = 32 * 1024;
const TERM_ID_RE = /^term-[A-Za-z0-9_-]{6,64}$/;

interface Session {
  pty: Pty;
  buf: string;
  timer?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  seq: number;
}

export type TermSend = (msg: Record<string, unknown>) => void;

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly send: TermSend,
    private readonly pty: () => PtyModule | null = loadPty,
    private readonly shell: () => { file: string; args: string[] } = () => defaultShell(),
  ) {}

  get available(): boolean {
    return this.pty() !== null;
  }

  /** Opens (or re-attaches to) a terminal. Returns an error message, or null when it runs. */
  open(id: string, cwd: string, cols: number, rows: number): string | null {
    if (!TERM_ID_RE.test(id)) return "终端编号不合法";
    if (this.sessions.has(id)) {
      this.resize(id, cols, rows);
      this.touch(id);
      return null;
    }
    const mod = this.pty();
    if (!mod) return "这台设备的 Memento 没带终端组件（node-pty），升级到最新版后再试";
    if (this.sessions.size >= MAX_TERMINALS) return `同时最多开 ${MAX_TERMINALS} 个终端，先关掉一个`;
    const dir = cwd && existsSync(cwd) ? cwd : homedir();
    const { file, args } = this.shell();
    let pty: Pty;
    try {
      pty = mod.spawn(file, args, {
        name: "xterm-256color",
        cols: clampSize(cols, 80),
        rows: clampSize(rows, 24),
        cwd: dir,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Memento" },
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      });
    } catch (e) {
      return `启动终端失败：${e instanceof Error ? e.message : String(e)}`;
    }
    const s: Session = { pty, buf: "", seq: 0 };
    this.sessions.set(id, s);
    pty.onData((data) => {
      s.buf += data;
      if (s.buf.length >= FLUSH_BYTES) this.flush(id);
      else if (!s.timer) s.timer = setTimeout(() => this.flush(id), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.flush(id);
      this.drop(id);
      this.send({ type: "term_exit", term_id: id, exit_code: exitCode });
    });
    this.touch(id);
    return null;
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s || typeof data !== "string") return;
    s.pty.write(data);
    this.touch(id);
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.resize(clampSize(cols, 80), clampSize(rows, 24));
    } catch {
      // the shell just exited
    }
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.drop(id);
    try {
      s.pty.kill();
    } catch {
      // already gone
    }
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  get count(): number {
    return this.sessions.size;
  }

  private flush(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    if (!s.buf) return;
    const text = s.buf;
    s.buf = "";
    s.seq += 1;
    this.send({ type: "task_chunk", task_id: id, stream: "stdout", text, seq: s.seq });
  }

  private touch(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.idle) clearTimeout(s.idle);
    s.idle = setTimeout(() => this.close(id), IDLE_MS);
    s.idle.unref?.();
  }

  private drop(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.idle) clearTimeout(s.idle);
    this.sessions.delete(id);
  }
}

function clampSize(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.max(2, Math.min(500, v));
}
