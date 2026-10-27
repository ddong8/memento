import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";
import { executionEnvironment, findExecutable, prepareCommand } from "./exec-env.js";
import type { GuardTool } from "./guard.js";

/**
 * Installs the completion-evidence check (guard.ts) as a Stop hook in Claude
 * Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json).
 *
 * The hook is one small shell script that hands the hook input to the daemon's
 * local API; the daemon decides. When the daemon isn't running the script
 * finds no address and lets the turn end, so a stopped Memento never blocks.
 * Like profile injection it owns only its own entry: other hooks are left
 * alone, a file it created goes again when the guard is turned off, and the
 * first write backs the file up as <file>.memento.bak.
 *
 * Codex runs a user hook only once it is trusted (/hooks in the TUI). The guard
 * is the user's own choice in Memento, so after writing it Memento trusts this
 * one entry through `codex app-server` (hooks/list + config/batchWrite), the way
 * /hooks does; other hooks keep whatever trust they had.
 */

export const GUARD_TIMEOUT_SEC = 20;

export const hooksDir = (home = homeDir()) => join(mementoDir(home), "hooks");
export const stopScriptPath = (home = homeDir()) => join(hooksDir(home), "stop-check.sh");
/** Where the local API listens and its token, as a curl config (written by LocalApi, readable only by the user). */
export const curlConfigPath = (home = homeDir()) => join(hooksDir(home), "local-api.curl");

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const hookCommand = (script: string, tool: GuardTool) => `sh ${shq(script)} ${tool}`;

export function stopScriptText(curlConfig: string): string {
  return `#!/bin/sh
# Written by Memento; edits are overwritten. Stop hook of Claude Code and Codex:
# hands the hook input to the local Memento daemon, which checks that a "done"
# claim comes with a passing check. Daemon not running or slow: the turn ends.
cfg=${shq(curlConfig)}
[ -r "$cfg" ] || exit 0
curl -sf -m 15 -K "$cfg" -H "Content-Type: application/json" -H "X-Memento-Tool: \${1:-claude_code}" --data-binary @- 2>/dev/null || exit 0
`;
}

export function curlConfigText(port: number, token: string): string {
  return `url = "http://127.0.0.1:${port}/hooks/stop"\nheader = "Authorization: Bearer ${token}"\n`;
}

export interface GuardTarget {
  /** The tool's own directory; nothing is installed when it's absent. */
  toolHome: string;
  /** The JSON file holding its hooks. */
  file: string;
}

export function defaultGuardTargets(home = homeDir(), env: NodeJS.ProcessEnv = process.env): Record<GuardTool, GuardTarget> {
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return {
    claude_code: { toolHome: claudeHome, file: join(claudeHome, "settings.json") },
    codex: { toolHome: codexHome, file: join(codexHome, "hooks.json") },
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/**
 * `settings` with our Stop entry in place (enable) or taken out; null when it's
 * already that way. An entry is ours when its command runs `script`.
 */
export function withStopHook(settings: Json, script: string, command: string, enable: boolean): Json | null {
  const hooks = obj(settings.hooks);
  const groups: unknown[] = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const ours = (h: unknown) => typeof obj(h).command === "string" && (obj(h).command as string).includes(script);
  let found = 0;
  let exact = 0;
  for (const g of groups) {
    const list = obj(g).hooks;
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      if (!ours(h)) continue;
      found++;
      const e = obj(h);
      if (e.type === "command" && e.command === command && e.timeout === GUARD_TIMEOUT_SEC) exact++;
    }
  }
  if (enable ? found === 1 && exact === 1 : found === 0) return null;

  const kept: unknown[] = [];
  for (const g of groups) {
    const list = obj(g).hooks;
    if (!Array.isArray(list)) {
      kept.push(g);
      continue;
    }
    const rest = list.filter((h) => !ours(h));
    if (rest.length) kept.push({ ...obj(g), hooks: rest });
    else if (!list.some(ours)) kept.push(g);
  }
  if (enable) kept.push({ hooks: [{ type: "command", command, timeout: GUARD_TIMEOUT_SEC }] });

  const nextHooks: Json = { ...hooks };
  if (kept.length) nextHooks.Stop = kept;
  else delete nextHooks.Stop;
  const next: Json = { ...settings };
  if (Object.keys(nextHooks).length) next.hooks = nextHooks;
  else delete next.hooks;
  return next;
}

interface GuardState {
  /** Files the guard created (deleted again when it leaves them empty). */
  created: string[];
  /** Codex hooks.json content hash that was last trusted. */
  trusted: Record<string, string>;
}

async function readState(path: string): Promise<GuardState> {
  try {
    const s = JSON.parse(await readFile(path, "utf8")) as Partial<GuardState>;
    return { created: Array.isArray(s.created) ? s.created : [], trusted: obj(s.trusted) as Record<string, string> };
  } catch {
    return { created: [], trusted: {} };
  }
}

async function writeAtomic(file: string, text: string, mode?: number): Promise<void> {
  const tmp = `${file}.memento-tmp`;
  await writeFile(tmp, text, mode === undefined ? undefined : { mode });
  await rename(tmp, file);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Make Codex trust our Stop entry in `hooksFile`; returns "trusted", "disabled" or throws. */
export type CodexTrust = (hooksFile: string, command: string) => Promise<string>;

export async function trustCodexHook(hooksFile: string, command: string, home = homeDir()): Promise<string> {
  const env = await executionEnvironment();
  const codex = await findExecutable(["codex"], env);
  if (!codex) throw new Error("找不到 codex 命令");
  const { executable, args } = await prepareCommand(codex, ["app-server"]);
  const server = spawn(executable, args, { cwd: home, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  let nextId = 1;
  const pending = new Map<number, (msg: Json) => void>();
  server.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const msg = obj(JSON.parse(line));
        const resolve = pending.get(Number(msg.id));
        if (resolve) {
          pending.delete(Number(msg.id));
          resolve(msg);
        }
      } catch {
        // a notification or log line
      }
    }
  });
  const request = (method: string, params: unknown) =>
    new Promise<Json>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (msg) => (msg.error ? reject(new Error(String(obj(msg.error).message ?? "error"))) : resolve(obj(msg.result))));
      server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("codex app-server 没有响应")), 20_000).unref());
  const exited = new Promise<never>((_, reject) => {
    server.once("error", (e) => reject(e));
    server.once("exit", (code) => reject(new Error(`codex app-server 退出（${code ?? "signal"}）`)));
  });
  const work = (async () => {
    await request("initialize", { clientInfo: { name: "memento", title: "Memento", version: process.env.MEMENTO_DESKTOP_VERSION || "0.0.0" }, capabilities: null });
    server.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const listed = await request("hooks/list", { cwds: [home] });
    const entries = (Array.isArray(listed.data) ? listed.data : []).flatMap((d) => (Array.isArray(obj(d).hooks) ? (obj(d).hooks as unknown[]) : []));
    const hook = entries.map(obj).find((h) => h.command === command && h.source === "user");
    if (!hook) throw new Error("Codex 没有加载这个钩子（可能关掉了 [features].hooks）");
    if (hook.trustStatus === "trusted" || hook.trustStatus === "managed") return "trusted";
    if (hook.enabled === false) return "disabled";
    await request("config/batchWrite", {
      edits: [{ keyPath: `hooks.state.${JSON.stringify(String(hook.key))}.trusted_hash`, value: hook.currentHash, mergeStrategy: "replace" }],
    });
    return "trusted";
  })();
  try {
    return await Promise.race([work, timeout, exited]);
  } finally {
    server.removeAllListeners("exit");
    try {
      server.stdin.end();
      server.kill();
    } catch {
      // already gone
    }
  }
}

export interface ApplyGuardsOptions {
  /** Tools the guard should be on for; the rest have it taken out. */
  tools: GuardTool[];
  home?: string;
  targets?: Record<GuardTool, GuardTarget>;
  statePath?: string;
  platform?: NodeJS.Platform;
  trustCodex?: CodexTrust;
}

/**
 * Converge each tool's hook file to the server's choice. Results per tool:
 * written / unchanged / removed / absent (tool not installed) / unsupported /
 * "error: ...", plus codex_trust when Codex had to be asked to trust it.
 */
export async function applyGuards(o: ApplyGuardsOptions): Promise<Record<string, string>> {
  const home = o.home ?? homeDir();
  const targets = o.targets ?? defaultGuardTargets(home);
  const statePath = o.statePath ?? join(mementoDir(home), "guard_inject.json");
  const script = stopScriptPath(home);
  const results: Record<string, string> = {};
  const want = new Set(o.tools);

  if ((o.platform ?? process.platform) === "win32") {
    for (const tool of want) results[tool] = "unsupported";
    return results;
  }

  const state = await readState(statePath);
  let stateChanged = false;
  if (want.size) {
    const text = stopScriptText(curlConfigPath(home));
    if ((await readFile(script, "utf8").catch(() => "")) !== text) {
      await mkdir(dirname(script), { recursive: true });
      await writeAtomic(script, text, 0o700);
    }
    await chmod(script, 0o700).catch(() => {});
  }

  for (const tool of Object.keys(targets) as GuardTool[]) {
    const { toolHome, file } = targets[tool];
    const enable = want.has(tool);
    try {
      if (!existsSync(toolHome)) {
        if (enable) results[tool] = "absent";
        continue;
      }
      const raw = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
      if (raw === null && !enable) continue;
      let settings: Json = {};
      if (raw !== null && raw.trim()) {
        try {
          settings = obj(JSON.parse(raw));
        } catch {
          if (enable) results[tool] = `error: ${file} 不是合法的 JSON，没有改动`;
          continue;
        }
      }
      const command = hookCommand(script, tool);
      const next = withStopHook(settings, script, command, enable);
      let current = raw ?? "";
      if (next === null) {
        if (enable) results[tool] = "unchanged";
      } else if (!enable && raw !== null && state.created.includes(file) && !Object.keys(next).length) {
        await rm(file, { force: true });
        state.created = state.created.filter((f) => f !== file);
        delete state.trusted[file];
        stateChanged = true;
        results[tool] = "removed";
        continue;
      } else {
        if (raw !== null && !existsSync(`${file}.memento.bak`)) await copyFile(file, `${file}.memento.bak`);
        if (raw === null) {
          state.created.push(file);
          stateChanged = true;
        }
        current = `${JSON.stringify(next, null, 2)}\n`;
        await writeAtomic(file, current);
        results[tool] = enable ? "written" : "removed";
      }

      if (tool === "codex" && enable && state.trusted[file] !== sha(current)) {
        try {
          const trust = await (o.trustCodex ?? ((f, c) => trustCodexHook(f, c, home)))(file, command);
          results.codex_trust = trust;
          if (trust === "trusted") {
            state.trusted[file] = sha(current);
            stateChanged = true;
          }
        } catch (e) {
          results.codex_trust = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        }
      }
    } catch (e) {
      results[tool] = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  }

  if (!want.size) await rm(script, { force: true }).catch(() => {});
  if (stateChanged) {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  return results;
}
