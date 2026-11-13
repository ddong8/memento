import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";

/**
 * Keeps an executor's daemon (deploy/bootstrap/executor.sh: a shallow clone in ~/.memento/src/memento run
 * by a systemd user service) on the released version, as the desktop app keeps its own: no one has to
 * log in to each server and re-run the installer after a release.
 *
 * A new version is built beside the running one (…/memento.next) and swapped in only once it built and
 * loads, and only while no task runs; the daemon then exits non-zero so systemd starts the new build
 * (Restart=on-failure). A failed build leaves the running one as it was.
 */

const CHECK_MS = 30 * 60_000;
const FIRST_CHECK_MS = 3 * 60_000;
const IDLE_POLL_MS = 30_000;
/** The exit status that asks systemd to start the daemon again on the new build. */
export const RESTART_EXIT_CODE = 75;

export type Run = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<string>;

const defaultRun: Run = (cmd, args, opts) =>
  new Promise((res, rej) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts?.cwd,
        timeout: opts?.timeout ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        // npm and git from this daemon's own Node, which a service's PATH may lack
        env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, npm_config_update_notifier: "false" },
      },
      (err, stdout, stderr) => (err ? rej(new Error(`${cmd} ${args.join(" ")}: ${String(stderr || err.message).trim().slice(-800)}`)) : res(String(stdout))),
    );
  });

/** How executor.sh builds the daemon. */
export async function buildDaemon(dir: string, run: Run = defaultRun): Promise<void> {
  await run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error", "-w", "@memento/daemon", "-w", "@memento/core", "-w", "@memento/mcp", "--include-workspace-root"], { cwd: dir, timeout: 15 * 60_000 });
  await run("npm", ["run", "build", "-w", "@memento/daemon", "-w", "@memento/mcp"], { cwd: dir, timeout: 10 * 60_000 });
}

/** The executor clone this daemon runs from, or undefined when it isn't one (the desktop app, a dev checkout, no systemd). */
export function executorSourceRoot(env: NodeJS.ProcessEnv = process.env, self = fileURLToPath(import.meta.url), home = homeDir()): string | undefined {
  if (process.platform !== "linux" || env.MEMENTO_AUTO_UPDATE === "0" || env.MEMENTO_DAEMON_EMBEDDED) return undefined;
  // systemd sets INVOCATION_ID for the service's processes; only it starts the new build after the exit
  if (!env.INVOCATION_ID) return undefined;
  try {
    const root = realpathSync(resolve(dirname(self), "..", "..", ".."));
    const expected = realpathSync(join(home, ".memento", "src", "memento"));
    return root === expected && existsSync(join(root, ".git")) ? root : undefined;
  } catch {
    return undefined;
  }
}

async function versionIn(text: string): Promise<string | undefined> {
  try {
    const v = JSON.parse(text)?.version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface SelfUpdateOptions {
  root: string;
  log: (line: string) => void;
  /** Whether a task is running; the swap waits for none. */
  busy: () => boolean;
  run?: Run;
  build?: (dir: string) => Promise<void>;
  idlePollMs?: number;
}

export type UpdateResult = { status: "current" } | { status: "updated"; from?: string; to: string } | { status: "failed"; error: string };

/**
 * One check: the released version on the clone's branch, built and swapped in when it differs from the
 * running one. "updated" means the caller should exit with RESTART_EXIT_CODE.
 */
export async function updateOnce(opts: SelfUpdateOptions): Promise<UpdateResult> {
  const run = opts.run ?? defaultRun;
  const build = opts.build ?? ((dir: string) => buildDaemon(dir, run));
  const { root, log } = opts;
  const next = `${root}.next`;
  try {
    let branch = (await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (!branch || branch === "HEAD") branch = process.env.MEMENTO_REF || "main";
    const url = (await run("git", ["-C", root, "remote", "get-url", "origin"])).trim();
    await run("git", ["-C", root, "fetch", "--depth", "1", "--quiet", "origin", branch], { timeout: 180_000 });
    const remote = await versionIn(await run("git", ["-C", root, "show", "FETCH_HEAD:apps/desktop/package.json"]));
    const current = await versionIn(await readFile(join(root, "apps", "desktop", "package.json"), "utf8").catch(() => ""));
    // Only a release: main moves many times a day and each restart waits for the tasks to end
    if (!remote || remote === current) return { status: "current" };

    log(`自动升级：发现新版本 v${remote}（当前 v${current ?? "?"}），在旁边构建`);
    await rm(next, { recursive: true, force: true });
    await run("git", ["clone", "--depth", "1", "--quiet", "--branch", branch, url, next], { timeout: 300_000 });
    await build(next);
    const cli = join(next, "packages", "daemon", "dist", "cli.js");
    if (!existsSync(cli)) throw new Error("构建后没有 packages/daemon/dist/cli.js");
    // Loads every module the daemon starts with
    await run(process.execPath, [cli, "help"], { timeout: 60_000 });

    let waited = false;
    while (opts.busy()) {
      if (!waited) log(`自动升级：v${remote} 已构建好，等正在运行的任务结束后切换`);
      waited = true;
      await new Promise((r) => setTimeout(r, opts.idlePollMs ?? IDLE_POLL_MS));
    }
    await rm(`${root}.prev`, { recursive: true, force: true });
    await rename(root, `${root}.prev`);
    try {
      await rename(next, root);
    } catch (e) {
      await rename(`${root}.prev`, root);
      throw e;
    }
    log(`自动升级：已切换到 v${remote}，重启守护进程`);
    return { status: "updated", from: current, to: remote };
  } catch (e) {
    await rm(next, { recursive: true, force: true }).catch(() => {});
    const error = e instanceof Error ? e.message : String(e);
    log(`自动升级失败（继续运行当前版本）：${error}`);
    return { status: "failed", error };
  }
}

/** Checks now and then while the daemon runs; calls `restart` after a swap. Returns a stop function. */
export function startSelfUpdate(opts: Omit<SelfUpdateOptions, "root"> & { restart: () => void; root?: string }): () => void {
  const root = opts.root ?? executorSourceRoot();
  if (!root) return () => {};
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    const result = await updateOnce({ ...opts, root });
    if (stopped) return;
    if (result.status === "updated") opts.restart();
    else timer = setTimeout(() => void tick(), CHECK_MS);
  };
  timer = setTimeout(() => void tick(), FIRST_CHECK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
