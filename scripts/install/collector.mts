// Sets up this machine's collector against the freshly started server.
//
// The collector is the Node daemon in packages/daemon (the one the Memento app runs). On Node.js with
// npm it is built from this checkout and installed as a login service (launchd / systemd / Windows
// Run key); otherwise (the installer running on the Memento app's own runtime) the device is
// configured and the app picks it up.
//
// Also `deepUninstall()` for `./install.sh uninstall --all` and `./install.sh uninstall-collector`:
// stops the daemon service, removes the retired pip collector if present, takes back what the daemon
// wrote into the AI tools (profile block, Stop hook, synced skills, `agy` wrapper, project blueprints
// and their git hooks), then ~/.memento, logs, and MCP server entries from ~/.claude.json, Cursor,
// Codex, etc.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { IS_LINUX, IS_MAC, IS_WINDOWS, REPO_ROOT, errorText, findPython, info, npmPath, ok, onNode, run, warn, which } from "./platform.mts";

const DESKTOP_RELEASES = "https://github.com/ddong8/memento/releases/latest";
export const DAEMON_CLI = join(REPO_ROOT, "packages", "daemon", "dist", "cli.js");
/** This installer's runtime as plain Node, also when it is the Memento app's Electron. */
const nodeEnv = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1", ...extra });

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const exists = (p: string) => existsSync(p);
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isEmptyDir = (p: string) => {
  try {
    return readdirSync(p).length === 0;
  } catch {
    return false;
  }
};

/** Merges server, web URL and token into ~/.memento/collector.json (keeps the device id). */
export function writeDeviceConfig(token: string, serverUrl: string, webUrl: string, home = homedir()): string {
  const path = join(home, ".memento", "collector.json");
  mkdirSync(dirname(path), { recursive: true });
  const prev = loadJson(path);
  const data = { ...(isObject(prev) ? prev : {}), server_url: serverUrl, web_url: webUrl, token };
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows
  }
  return path;
}

function npm(...args: string[]): void {
  const exe = npmPath();
  if (!exe) throw new Error("npm not found");
  // npm.cmd needs the shell on Windows, and the shell needs the path quoted
  if (IS_WINDOWS) run(`"${exe}"`, args, { check: true, cwd: REPO_ROOT, shell: true });
  else run(exe, args, { check: true, cwd: REPO_ROOT });
}

/** Installs the daemon's dependencies and compiles it (idempotent; `update` uses it too). */
export function buildDaemon(): void {
  npm("ci", "--workspace", "@memento/daemon", "--workspace", "@memento/core", "--include-workspace-root");
  npm("run", "build", "-w", "@memento/daemon");
}

/** Whether this installer can build the daemon and run it as a service: Node.js itself, with npm. */
export const canRunDaemon = () => onNode && !!npmPath();

/** Configures this device and, on Node.js, runs the daemon as a login service. */
export function installCollector(token: string, serverUrl = "http://localhost:8001", webUrl = "http://localhost:3001"): void {
  const cfg = writeDeviceConfig(token, serverUrl, webUrl);
  ok(`Device configured → ${serverUrl} (${cfg})`);
  if (!canRunDaemon()) {
    warn("Running on the Memento app's runtime (no Node.js with npm), so the collector wasn't installed as a service.");
    info(`The Memento app reads ${cfg} and signs in on its own (${DESKTOP_RELEASES}).`);
    info("Or install Node.js 22.18+ and run `./install.sh update` to set up the headless collector.");
    return;
  }
  info("Building the collector daemon…");
  buildDaemon();
  // The service it registers runs this same Node (process.execPath in the daemon's install-service)
  run(process.execPath, [DAEMON_CLI, "install-service"], { check: true, cwd: REPO_ROOT });
  ok("Collector daemon installed as a background service.");
  info("If the Memento app is also running, only one of them collects (they share ~/.memento).");
}

export const daemonServiceInstalled = () => exists(DAEMON_CLI);

// ─────────────────────────────────────────────────────────────
// Deep uninstall
// ─────────────────────────────────────────────────────────────

// The pre-rebrand MCP key and the current one: both go on uninstall
const MCP_KEYS = ["memento-memory", "daily-report-memory"];

/** Strips the memento-memory / daily-report-memory entries from a JSON MCP config. */
export function removeMcpEntry(configPath: string): void {
  if (!exists(configPath)) return;
  const data = loadJson(configPath);
  if (!isObject(data) || !isObject(data.mcpServers)) return;
  const servers = data.mcpServers;
  let changed = false;
  for (const key of MCP_KEYS) {
    if (key in servers) {
      delete servers[key];
      changed = true;
      ok(`Removed '${key}' from ${basename(configPath)}`);
    }
  }
  if (changed) writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
}

/** The text without `[mcp_servers.<key>]` sections: header through the next blank line or [section]. */
export function withoutCodexMcp(text: string, key: string): string {
  const header = `[mcp_servers.${key}]`;
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split(/(?<=\n)/)) {
    const stripped = line.trim();
    if (stripped === header) {
      skipping = true;
      continue;
    }
    if (!skipping) {
      out.push(line);
    } else if (stripped.startsWith("[") && stripped.endsWith("]")) {
      skipping = false;
      out.push(line);
    } else if (stripped === "") {
      skipping = false;
    }
  }
  return out.join("");
}

/** Strips [mcp_servers.memento-memory] / [mcp_servers.daily-report-memory] from Codex's TOML. */
export function removeCodexMcp(configPath: string): void {
  if (!exists(configPath)) return;
  let text = readFileSync(configPath, "utf8");
  for (const key of MCP_KEYS) {
    if (!text.includes(`[mcp_servers.${key}]`)) continue;
    text = withoutCodexMcp(text, key);
    ok(`Removed codex mcp entry '${key}' from ${basename(configPath)}`);
  }
  writeFileSync(configPath, text, "utf8");
}

function pipUninstall(py: string | undefined, pkg: string): void {
  if (!py) return;
  const shown = run(py, ["-m", "pip", "show", pkg], { capture: true });
  if (shown.error || shown.status !== 0) return; // not installed
  run(py, ["-m", "pip", "uninstall", "-y", pkg]);
  ok(`pip uninstalled ${pkg}`);
}

// What the daemon writes outside ~/.memento (packages/daemon/src/profile-inject.ts, guard-inject.ts,
// skill-inject.ts, antigravity.ts). Each is taken back only where it is still exactly Memento's: text
// outside the markers, other hooks and skills the user edited stay. Ownership is read from the state
// files in ~/.memento, so this runs before that directory goes.
const PROFILE_BEGIN = "<!-- memento:begin";
const PROFILE_END = "<!-- memento:end -->";
const PROFILE_BLOCK = /<!-- memento:begin[^>]*-->[\s\S]*?<!-- memento:end -->\n?/;

/** The copy of `path` the daemon made before its first write. */
function dropBackup(path: string): void {
  rmSync(`${path}.memento.bak`, { force: true });
}

function profileFiles(home: string): Record<string, string> {
  const codex = process.env.CODEX_HOME || join(home, ".codex");
  let gemini = join(home, ".gemini");
  const appdata = process.env.APPDATA;
  if (IS_WINDOWS && appdata && exists(join(appdata, ".gemini"))) gemini = join(appdata, ".gemini");
  return {
    claude_code: join(home, ".claude", "CLAUDE.md"),
    codex: join(codex, "AGENTS.md"),
    antigravity: join(gemini, "GEMINI.md"),
    workbuddy: join(home, ".workbuddy", "MEMORY.md"),
    openclaw: join(home, ".openclaw", "workspace", "USER.md"),
    hermes: join(home, ".hermes", "SOUL.md"),
  };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

function removeProfileBlocks(home: string): void {
  const state = loadJson(join(home, ".memento", "profile_inject.json"));
  for (const [tool, path] of Object.entries(profileFiles(home))) {
    if (!exists(path)) continue;
    const text = readFileSync(path, "utf8");
    const begins = count(text, PROFILE_BEGIN);
    const ends = count(text, PROFILE_END);
    if (begins === 0 && ends === 0) {
      dropBackup(path);
      continue;
    }
    if (begins !== 1 || ends !== 1 || !PROFILE_BLOCK.test(text)) {
      warn(`The Memento block in ${path} is damaged; remove it by hand (backup: ${basename(path)}.memento.bak).`);
      continue;
    }
    const rest = text.replace(PROFILE_BLOCK, "");
    const entry = isObject(state) ? state[tool] : undefined;
    if (!rest.trim() && isObject(entry) && entry.created) unlinkSync(path);
    else writeFileSync(path, rest.trim() ? `${rest.replace(/\n+$/, "")}\n` : "", "utf8");
    dropBackup(path);
    ok(`Removed the Memento profile block from ${path}`);
  }
}

/** `settings` without the Stop hooks that run `script`; undefined when there are none. */
export function withoutStopHook(settings: Json, script: string): Json | undefined {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks.Stop) ? (hooks.Stop as unknown[]) : [];
  const ours = (h: unknown) => isObject(h) && typeof h.command === "string" && h.command.includes(script);
  const kept: unknown[] = [];
  let found = false;
  for (const g of groups) {
    const entries = isObject(g) ? g.hooks : undefined;
    if (!Array.isArray(entries) || !entries.some(ours)) {
      kept.push(g);
      continue;
    }
    found = true;
    const rest = entries.filter((h) => !ours(h));
    if (rest.length) kept.push({ ...(g as Json), hooks: rest });
  }
  if (!found) return undefined;
  const { Stop: _stop, ...otherHooks } = hooks;
  const nextHooks: Json = kept.length ? { ...otherHooks, Stop: kept } : otherHooks;
  const { hooks: _hooks, ...out } = settings;
  return Object.keys(nextHooks).length ? { ...out, hooks: nextHooks } : out;
}

function removeStopHooks(home: string): void {
  const script = join(home, ".memento", "hooks", "stop-check.sh");
  const guard = loadJson(join(home, ".memento", "guard_inject.json"));
  const created = isObject(guard) && Array.isArray(guard.created) ? (guard.created as unknown[]) : [];
  for (const path of [
    join(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
    join(process.env.CODEX_HOME || join(home, ".codex"), "hooks.json"),
  ]) {
    const settings = exists(path) ? loadJson(path) : undefined;
    if (!isObject(settings)) continue;
    const cleaned = withoutStopHook(settings, script);
    if (cleaned !== undefined) {
      if (!Object.keys(cleaned).length && created.includes(path)) unlinkSync(path);
      else writeFileSync(path, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
      ok(`Removed the Memento Stop hook from ${path}`);
    }
    dropBackup(path);
  }
}

function removeSyncedSkills(home: string): void {
  const state = loadJson(join(home, ".memento", "skill_inject.json"));
  if (!isObject(state)) return;
  const dirs: Record<string, string> = {
    claude: join(home, ".claude", "skills"),
    agents: join(home, ".agents", "skills"),
    workbuddy: join(home, ".workbuddy", "skills"),
  };
  for (const [key, owned] of Object.entries(state)) {
    const root = dirs[key];
    if (!root || !isObject(owned)) continue;
    for (const [name, mine] of Object.entries(owned)) {
      const skill = join(root, name, "SKILL.md");
      if (!exists(skill) || !isObject(mine)) continue;
      if (createHash("sha256").update(readFileSync(skill)).digest("hex") !== mine.hash) {
        info(`Kept ${skill}: edited after Memento wrote it.`);
        continue;
      }
      unlinkSync(skill);
      if (isEmptyDir(dirname(skill))) rmdirSync(dirname(skill));
      ok(`Removed synced skill ${dirname(skill)}`);
    }
  }
}

function removeAgyWrapper(home: string): void {
  const binDir = join(home, ".gemini", "antigravity", "bin");
  // The runner: agy_cli.mjs since v1.0.99, agy_cli.py before
  const scripts = ["agy_cli.mjs", "agy_cli.py"].map((n) => join(binDir, n));
  const wrapper = IS_WINDOWS ? join(home, "AppData", "Local", "agy", "bin", "agy.cmd") : join(home, ".local", "bin", "agy");
  const older = IS_WINDOWS ? `@echo off\r\npython "${scripts[1]}" %*\r\n` : `#!/bin/sh\nexec python3 "${scripts[1]}" "$@"\n`;
  // Older apps also wrote one beside the runner, which links on PATH point at
  const removed: string[] = [];
  for (const w of [wrapper, join(binDir, IS_WINDOWS ? "agy.cmd" : "agy")]) {
    if (!isFile(w)) continue;
    const text = readFileSync(w, "utf8");
    // Ours: the Python runner's exact wrapper, or the one marked as Memento's (Google's CLI may own `agy`)
    if (text === older || (text.includes("rewritten by Memento") && text.includes(scripts[0]!))) {
      unlinkSync(w);
      removed.push(w);
      ok(`Removed ${w}`);
    }
  }
  // Links to them (agy, even antigravity) would be left dangling
  if (!IS_WINDOWS && removed.length) {
    const linkDirs = new Set([...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".antigravity", "antigravity", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
    for (const d of linkDirs) {
      for (const name of ["agy", "antigravity"]) {
        const link = join(d, name);
        try {
          if (lstatSync(link).isSymbolicLink() && removed.includes(resolve(d, readlinkSync(link)))) {
            unlinkSync(link);
            ok(`Removed ${link}`);
          }
        } catch {
          // none there, or not ours to remove
        }
      }
    }
  }
  for (const f of scripts.flatMap((s) => [s, `${s}.tmp`])) {
    if (exists(f)) {
      unlinkSync(f);
      ok(`Removed ${f}`);
    }
  }
  // What Python left of the runner it compiled
  const pycache = join(binDir, "__pycache__");
  if (exists(pycache)) {
    for (const f of readdirSync(pycache)) if (/^agy_cli\..*\.pyc$/.test(f)) unlinkSync(join(pycache, f));
  }
  for (const d of IS_WINDOWS ? [pycache, binDir, dirname(wrapper), dirname(dirname(wrapper))] : [pycache, binDir]) {
    if (isEmptyDir(d)) rmdirSync(d);
  }
}

/** BLUEPRINT_SCRIPT_VERSION of a generator copy; -1 when unreadable, 0 when it has none. */
export function blueprintScriptVersion(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return -1;
  }
  const m = /^(?:(?:export\s+)?(?:const|let|var)\s+)?BLUEPRINT_SCRIPT_VERSION\s*=\s*(\d+)/m.exec(text);
  return m ? Number(m[1]) : 0;
}

/**
 * The git hooks, HEAD markers, exclude lines, anchors and untracked PROJECT_BLUEPRINT.md the daemon
 * set up in local repos (recorded in ~/.memento/blueprint_repos): the generator's own --uninstall-all,
 * from whichever copy is newer (the daemon may have an OTA one). It runs on this installer's runtime.
 */
function removeBlueprints(home: string): void {
  const candidates = [join(home, ".memento", "scripts", "project_blueprint.mjs"), join(REPO_ROOT, "scripts", "project_blueprint.mjs")].filter(isFile);
  if (!candidates.length) return;
  const script = candidates.reduce((a, b) => (blueprintScriptVersion(b) > blueprintScriptVersion(a) ? b : a));
  const res = run(process.execPath, [script, "--uninstall-all"], {
    env: nodeEnv({ HOME: home, USERPROFILE: home }),
    cwd: home,
    capture: true,
    timeoutMs: 300_000,
  });
  for (const line of res.stdout.split(/\r?\n/)) if (line.trim()) ok(line.trim());
  if (res.error || res.status !== 0) warn(`Project blueprints not fully removed: ${(res.stderr || errorText(res.error)).trim().slice(-300)}`);
}

/** Takes back what the daemon wrote into the AI tools' own files and the local repos. */
export function removeInjected(home = homedir()): void {
  for (const remove of [removeProfileBlocks, removeStopHooks, removeSyncedSkills, removeAgyWrapper, removeBlueprints]) {
    try {
      remove(home);
    } catch (e) {
      // one unreadable file must not stop the rest
      warn(`${remove.name}: ${errorText(e)}`);
    }
  }
}

/** Removes the Node daemon's login service, if this checkout installed one. */
export function uninstallDaemonService(): void {
  if (!exists(DAEMON_CLI)) return;
  info("Removing the collector daemon service…");
  run(process.execPath, [DAEMON_CLI, "uninstall-service"], { cwd: REPO_ROOT, env: nodeEnv() });
}

/** The MCP config files AI tools keep, in every location a version has used. */
export function mcpConfigPaths(home = homedir()): string[] {
  const appConfig = IS_MAC ? join(home, "Library", "Application Support") : IS_WINDOWS ? process.env.APPDATA || home : join(home, ".config");
  return [
    join(home, ".claude.json"),
    join(home, ".cursor", "mcp.json"),
    join(home, ".codeium", "windsurf", "mcp_config.json"),
    join(home, ".config", "windsurf", "mcp.json"), // older Windsurf
    // Antigravity has kept it in each of these, depending on the version
    join(home, ".gemini", "antigravity", "mcp_config.json"),
    join(home, ".gemini", "config", "mcp_config.json"),
    join(appConfig, "antigravity", "mcp.json"),
    join(home, ".gemini", "settings.json"), // Gemini CLI
  ];
}

/** Everything collector-side: services, retired pip packages, what the daemon wrote into AI tools, config, logs, MCP entries. */
export function deepUninstall(): void {
  const home = homedir();
  uninstallDaemonService();
  // The retired Python collector, if an older install left it behind
  for (const cmd of ["memento-collector", "daily-report-collector"]) {
    const exe = which(cmd);
    if (exe) {
      info(`Stopping collector service (${cmd})…`);
      run(exe, ["uninstall"]);
    }
  }

  // pip uninstall all name variants (new brand + transitional + legacy)
  info("Uninstalling pip packages…");
  let py: string | undefined;
  try {
    py = findPython();
  } catch {
    py = undefined;
  }
  for (const pkg of [
    "memento-brain-collector",
    "memento-brain-memory",
    "memento-brain",
    "memento-collector",
    "memento-memory",
    "daily-report-collector",
    "daily-report-memory",
  ]) {
    pipUninstall(py, pkg);
  }

  // Before ~/.memento goes: its state files say which of these are ours
  info("Removing what Memento wrote into AI tools and repos (profile blocks, Stop hooks, skills, blueprints)…");
  removeInjected(home);

  // Data dirs (new + legacy)
  for (const d of [join(home, ".memento"), join(home, ".daily-report")]) {
    if (exists(d)) {
      rmSync(d, { recursive: true, force: true });
      ok(`Removed ${d}/`);
    }
  }

  // Collector logs (new + legacy paths)
  const local = process.env.LOCALAPPDATA || home;
  const logs = IS_MAC
    ? [join(home, "Library", "Logs", "memento"), join(home, "Library", "Logs", "daily_report")]
    : IS_LINUX
      ? [join(home, ".local", "share", "memento", "logs"), join(home, ".local", "share", "daily_report", "logs")]
      : IS_WINDOWS
        ? [join(local, "memento", "logs"), join(local, "daily_report", "logs")]
        : [];
  for (const dir of logs) {
    if (exists(dir)) {
      rmSync(dir, { recursive: true, force: true });
      ok(`Removed logs ${dir}/`);
    }
  }

  // MCP server entries in the AI tools' configs; Codex uses TOML
  info("Cleaning MCP configs in AI tool configs…");
  for (const p of mcpConfigPaths(home)) removeMcpEntry(p);
  removeCodexMcp(join(home, ".codex", "config.toml"));
}
