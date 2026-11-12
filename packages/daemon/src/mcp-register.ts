import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { homeDir, mementoDir } from "./config.js";

/**
 * Keeps the memento-memory MCP entry in each AI tool pointing at the MCP server
 * bundled with the desktop app, with no token in it: the server reads the
 * device's sign-in (~/.memento/collector.json) itself, so a new sign-in or a
 * rotated token never breaks the tools.
 *
 * Entries were set up by hand once and then left alone: on 2026-11-09 the
 * Windows machine's Claude Code still ran the long-removed Python server with a
 * --token from months ago, which the server no longer accepted ("Invalid
 * token"), and Codex and Cursor pointed at a sidecar .exe that no longer
 * existed. So every sync converges them:
 *
 * - An entry of ours (named memento-memory, or an old Memento launcher under an
 *   old name like daily-report-memory) is rewritten to the bundled launcher;
 *   several of ours in one place become one memento-memory. The user's own
 *   settings on it (disabled, timeouts, approvals) stay.
 * - A tool chosen for the resident profile on this device gets the entry added
 *   when it has none, since the profile tells the AI to use these tools.
 * - Nothing else is touched or removed; a file is only written when something
 *   changes, after a timestamped copy in ~/.memento/backups/mcp.
 *
 * The desktop app passes its launcher (its own binary run as Node plus mcp.mjs,
 * see daemon-host.ts). A standalone daemon (executor.sh on a Linux server, no
 * desktop app) runs from a source checkout that also builds packages/mcp, and
 * starts that with its own Node. Before 2026-11-12 it had no launcher and left
 * the entries alone, so the AI tools on those machines had no memory at all.
 */

export const MCP_SERVER_NAME = "memento-memory";
/** Tools Memento can add the entry to (resident-profile targets). Cursor's entries are only repaired. */
export const MCP_ADD_TOOLS = ["claude_code", "codex", "antigravity"] as const;
const BACKUPS_KEPT = 5;

export interface McpLauncher {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The MCP server this daemon registers: the desktop app's bundled one when it
 * passes it in, otherwise the one built next to this daemon in the same source
 * checkout (standaloneMcpLauncher); null when neither is there.
 */
export function bundledMcpLauncher(env: NodeJS.ProcessEnv = process.env): McpLauncher | null {
  const command = env.MEMENTO_MCP_COMMAND;
  const entry = env.MEMENTO_MCP_ENTRY;
  if (command || entry) {
    if (!command || !entry || !existsSync(command) || !existsSync(entry)) return null;
    return { command, args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
  }
  if (process.versions.electron) return null;
  return standaloneMcpLauncher();
}

/**
 * packages/mcp/dist/cli.js of the checkout this daemon runs from, started with
 * this daemon's Node. Only when it was built and its SDK installed, or the tools
 * would get an entry that fails to start.
 */
export function standaloneMcpLauncher(
  daemonDist: string = dirname(fileURLToPath(import.meta.url)),
  node: string = process.execPath,
): McpLauncher | null {
  const mcpPackage = resolve(daemonDist, "..", "..", "mcp");
  const entry = join(mcpPackage, "dist", "cli.js");
  if (!existsSync(entry)) return null;
  const sdk = join("node_modules", "@modelcontextprotocol", "sdk", "package.json");
  if (!existsSync(join(mcpPackage, sdk)) && !existsSync(resolve(mcpPackage, "..", "..", sdk))) return null;
  return { command: node, args: [entry], env: {} };
}

export type McpFormat = "claude" | "json" | "codex";

export interface McpTarget {
  /** The tool's own directory; nothing is written when it's absent. */
  toolHome: string;
  file: string;
  format: McpFormat;
}

/**
 * The file Antigravity reads its MCP servers from. Since it moved its settings
 * to ~/.gemini/config (marked by config/.migrated) the app, the IDE and the agy
 * CLI read config/mcp_config.json and no longer the old
 * antigravity/mcp_config.json, which an older Antigravity may have left behind
 * (the Windows machine had both on 2026-11-09). Only an install that hasn't
 * moved yet still reads the old one, and carries it over when it moves.
 */
export function antigravityMcpFile(geminiRoot: string): string {
  const config = join(geminiRoot, "config");
  const legacy = join(geminiRoot, "antigravity", "mcp_config.json");
  if (!existsSync(join(config, ".migrated")) && !existsSync(join(config, "mcp_config.json")) && existsSync(legacy)) return legacy;
  return join(config, "mcp_config.json");
}

export function defaultMcpTargets(home = homeDir(), env: NodeJS.ProcessEnv = process.env): Record<string, McpTarget> {
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  // Same choice as the resident profile (profile-inject.ts)
  let geminiRoot = join(home, ".gemini");
  if (process.platform === "win32" && env.APPDATA && existsSync(join(env.APPDATA, ".gemini"))) geminiRoot = join(env.APPDATA, ".gemini");
  // The app's data dir, or the CLI's when only agy is installed
  const agHome = [join(geminiRoot, "antigravity"), join(geminiRoot, "antigravity-cli")].find((d) => existsSync(d)) ?? join(geminiRoot, "antigravity");
  return {
    claude_code: {
      toolHome: claudeDir || join(home, ".claude"),
      file: claudeDir ? join(claudeDir, ".claude.json") : join(home, ".claude.json"),
      format: "claude",
    },
    codex: { toolHome: codexHome, file: join(codexHome, "config.toml"), format: "codex" },
    antigravity: { toolHome: agHome, file: antigravityMcpFile(geminiRoot), format: "json" },
    cursor: { toolHome: join(home, ".cursor"), file: join(home, ".cursor", "mcp.json"), format: "json" },
  };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** Names our entries went by. */
const LEGACY_NAME = /^(memento|daily[-_]?report)([-_]?memory)?$/i;
/** Launchers of ours, past and present: the Python server, the sidecar .exe, the npm package, the bundled mcp.mjs, a checkout's packages/mcp. */
const LEGACY_LAUNCHER = /memento-mcp-sidecar|memento[-_]mcp|@memento[\\/]mcp|(^|\s)-m\s+mcp_server(\s|$)/i;
const BUNDLED_LAUNCHER = /app\.asar\.unpacked[\\/]dist[\\/]mcp\.mjs|[\\/]packages[\\/]mcp[\\/]dist[\\/]cli\.js/i;
/** How an entry is started or reached; the rest (disabled, timeouts, approvals) is the user's and stays. */
const LAUNCH_KEYS = new Set(["command", "args", "env", "type", "url", "serverUrl", "httpUrl", "headers", "cwd", "transport"]);

function launchText(command: unknown, args: unknown): string {
  return [command, ...(Array.isArray(args) ? args : [])].filter((v) => typeof v === "string").join(" ");
}

export function isOurEntry(name: string, command: unknown, args: unknown): boolean {
  if (name.toLowerCase() === MCP_SERVER_NAME) return true;
  const text = launchText(command, args);
  if (BUNDLED_LAUNCHER.test(text) || /memento-mcp-sidecar/i.test(text)) return true;
  return LEGACY_NAME.test(name) && LEGACY_LAUNCHER.test(text);
}

function canonicalEntry(launcher: McpLauncher, format: McpFormat): Json {
  const base: Json = { command: launcher.command, args: [...launcher.args] };
  if (Object.keys(launcher.env).length) base.env = { ...launcher.env };
  return format === "claude" ? { type: "stdio", ...base } : base;
}

/** `prev` started the canonical way, keeping its key order and the user's own keys. */
function mergeEntry(prev: Json, canonical: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(prev)) {
    if (k in canonical) out[k] = canonical[k];
    else if (!LAUNCH_KEYS.has(k)) out[k] = v;
  }
  for (const [k, v] of Object.entries(canonical)) if (!(k in out)) out[k] = v;
  return out;
}

export type Change = "unchanged" | "added" | "repaired" | "none";

/**
 * One `mcpServers` map converged: ours collapsed into one canonical memento-memory
 * (where the first of ours was), or added at the end when `add` and none is there.
 */
export function convergeServers(servers: Json, canonical: Json, add: boolean): { next: Json; change: Change } {
  const ours = Object.keys(servers).filter((k) => isOurEntry(k, obj(servers[k]).command, obj(servers[k]).args));
  if (!ours.length) {
    if (!add) return { next: servers, change: "none" };
    return { next: { ...servers, [MCP_SERVER_NAME]: canonical }, change: "added" };
  }
  const keep = ours.find((k) => k === MCP_SERVER_NAME) ?? ours.find((k) => k.toLowerCase() === MCP_SERVER_NAME) ?? ours[0]!;
  const merged = mergeEntry(obj(servers[keep]), canonical);
  const next: Json = {};
  for (const [k, v] of Object.entries(servers)) {
    if (k === ours[0]) next[MCP_SERVER_NAME] = merged;
    else if (!ours.includes(k)) next[k] = v;
  }
  return JSON.stringify(next) === JSON.stringify(servers) ? { next: servers, change: "unchanged" } : { next, change: "repaired" };
}

/** Claude Code's ~/.claude.json: the user-level entry, plus the per-project (local scope) ones, which win over it. */
export function convergeClaude(config: Json, launcher: McpLauncher, add: boolean): { next: Json; change: Change } {
  const canonical = canonicalEntry(launcher, "claude");
  const user = convergeServers(obj(config.mcpServers), canonical, add);
  let changed = user.change === "added" || user.change === "repaired";
  let projects = config.projects;
  let localChanged = false;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    const nextProjects: Json = {};
    for (const [path, p] of Object.entries(projects as Json)) {
      const servers = obj(p).mcpServers;
      if (!servers || typeof servers !== "object") {
        nextProjects[path] = p;
        continue;
      }
      const local = convergeServers(obj(servers), canonical, false);
      if (local.change === "repaired") {
        nextProjects[path] = { ...obj(p), mcpServers: local.next };
        localChanged = true;
      } else nextProjects[path] = p;
    }
    if (localChanged) projects = nextProjects;
  }
  changed ||= localChanged;
  if (!changed) return { next: config, change: user.change === "none" ? "none" : "unchanged" };
  const next: Json = { ...config, ...(user.change === "added" || user.change === "repaired" ? { mcpServers: user.next } : {}) };
  if (localChanged) next.projects = projects;
  return { next, change: user.change === "added" ? "added" : "repaired" };
}

// --- Codex config.toml: just enough TOML to read and replace [mcp_servers.*] tables ---

type TomlValue = string | TomlValue[] | { [k: string]: TomlValue } | { raw: string };

class TomlReader {
  i = 0;
  constructor(private readonly s: string) {}
  private ws(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.i++;
      else if (c === "#") while (this.i < this.s.length && this.s[this.i] !== "\n") this.i++;
      else break;
    }
  }
  value(): TomlValue {
    this.ws();
    const c = this.s[this.i];
    if (c === '"') {
      if (this.s.startsWith('"""', this.i)) throw new Error("multi-line string");
      const start = this.i++;
      while (this.i < this.s.length && this.s[this.i] !== '"') this.i += this.s[this.i] === "\\" ? 2 : 1;
      this.i++;
      // TOML's escapes are JSON's plus \UXXXXXXXX; a raw tab is allowed in TOML, not in JSON
      const body = this.s
        .slice(start, this.i)
        .replace(/\t/g, "\\t")
        .replace(/(?<!\\)((?:\\\\)*)\\U([0-9a-fA-F]{8})/g, (_, pre: string, h: string) => pre + JSON.stringify(String.fromCodePoint(parseInt(h, 16))).slice(1, -1));
      return JSON.parse(body) as string;
    }
    if (c === "'") {
      if (this.s.startsWith("'''", this.i)) throw new Error("multi-line string");
      const end = this.s.indexOf("'", this.i + 1);
      if (end < 0) throw new Error("unterminated string");
      const v = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return v;
    }
    if (c === "[") {
      this.i++;
      const out: TomlValue[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === "]") {
          this.i++;
          return out;
        }
        out.push(this.value());
        this.ws();
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] !== "]") throw new Error("bad array");
      }
    }
    if (c === "{") {
      this.i++;
      const out: { [k: string]: TomlValue } = {};
      for (;;) {
        this.ws();
        if (this.s[this.i] === "}") {
          this.i++;
          return out;
        }
        const key = this.key();
        this.ws();
        if (this.s[this.i++] !== "=") throw new Error("bad inline table");
        out[key] = this.value();
        this.ws();
        if (this.s[this.i] === ",") this.i++;
        else if (this.s[this.i] !== "}") throw new Error("bad inline table");
      }
    }
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.i));
    if (!m) throw new Error("bad value");
    this.i += m[0].length;
    return { raw: m[0] };
  }
  key(): string {
    this.ws();
    const parts: string[] = [];
    for (;;) {
      const c = this.s[this.i];
      if (c === '"' || c === "'") parts.push(this.value() as string);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) throw new Error("bad key");
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.ws();
      if (this.s[this.i] !== ".") return parts.join(".");
      this.i++;
      this.ws();
    }
  }
  /** A dotted table name split into its parts. */
  path(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === '"' || c === "'") parts.push(this.value() as string);
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i));
        if (!m) throw new Error("bad table name");
        parts.push(m[0]);
        this.i += m[0].length;
      }
      this.ws();
      if (this.s[this.i] !== ".") return parts;
      this.i++;
    }
  }
}

interface TomlSection {
  path: string[];
  /** Line range [start, end): the header and everything up to the next header. */
  start: number;
  end: number;
}

interface TomlKeyLines {
  key: string;
  value: TomlValue | undefined;
  lines: string[];
}

const HEADER = /^\s*\[(?!\[)(.+)\]\s*(#.*)?$/;

function tomlSections(lines: string[]): TomlSection[] {
  const out: TomlSection[] = [];
  for (let n = 0; n < lines.length; n++) {
    const m = HEADER.exec(lines[n]!);
    const arrayTable = /^\s*\[\[/.test(lines[n]!);
    if (!m && !arrayTable) continue;
    if (out.length) out[out.length - 1]!.end = n;
    let path: string[] = [];
    if (m) {
      try {
        path = new TomlReader(m[1]!).path();
      } catch {
        path = [];
      }
    }
    out.push({ path, start: n, end: lines.length });
  }
  return out;
}

/** The key = value entries of a table body (a value may span lines). */
function tomlKeys(body: string[]): TomlKeyLines[] {
  const out: TomlKeyLines[] = [];
  for (let n = 0; n < body.length; n++) {
    const line = body[n]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let key: string;
    try {
      key = new TomlReader(line.slice(0, eq)).key();
    } catch {
      continue;
    }
    // Gather lines until the value parses (arrays and inline tables may span lines)
    let text = line.slice(eq + 1);
    const lines = [line];
    let value: TomlValue | undefined;
    for (;;) {
      try {
        value = new TomlReader(text).value();
        break;
      } catch {
        if (n + 1 >= body.length || HEADER.test(body[n + 1]!)) break;
        n++;
        lines.push(body[n]!);
        text += `\n${body[n]}`;
      }
    }
    out.push({ key, value, lines });
  }
  return out;
}

const tomlStr = (s: string) => JSON.stringify(s);
const asStrings = (v: TomlValue | undefined): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
const sameStrings = (a: string[] | null, b: string[]) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
function sameEnv(v: unknown, env: Record<string, string>): boolean {
  if (v === undefined && !Object.keys(env).length) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return Object.keys(e).length === Object.keys(env).length && Object.entries(env).every(([k, x]) => e[k] === x);
}

/** Codex's config.toml converged; `text` itself when nothing changes. */
export function convergeCodex(text: string, launcher: McpLauncher, add: boolean): { next: string; change: Change } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const sections = tomlSections(lines);
  const servers = new Map<string, TomlSection[]>();
  for (const s of sections) {
    if (s.path.length >= 2 && s.path[0] === "mcp_servers") {
      const list = servers.get(s.path[1]!) ?? [];
      list.push(s);
      servers.set(s.path[1]!, list);
    }
  }
  const mainKeys = (name: string): TomlKeyLines[] => {
    const main = servers.get(name)?.find((s) => s.path.length === 2);
    return main ? tomlKeys(lines.slice(main.start + 1, main.end)) : [];
  };
  const ours = [...servers.keys()].filter((name) => {
    const keys = mainKeys(name);
    return isOurEntry(name, keys.find((k) => k.key === "command")?.value, keys.find((k) => k.key === "args")?.value);
  });

  if (!ours.length && !add) return { next: text, change: "none" };
  // Servers written as keys of [mcp_servers] or as root-level dotted keys: rewriting those
  // tables (or adding one next to them) could leave a duplicate key, so leave the file alone.
  // An empty [mcp_servers] header is fine (Codex writes one above its [mcp_servers.*] tables).
  const parentKeys = sections.some((s) => s.path.length === 1 && s.path[0] === "mcp_servers" && tomlKeys(lines.slice(s.start + 1, s.end)).length > 0);
  if (parentKeys || lines.slice(0, sections[0]?.start ?? lines.length).some((l) => /^\s*["']?mcp_servers["']?\s*\./.test(l))) {
    throw new Error("mcp_servers 的写法不是 [mcp_servers.名字] 表");
  }

  if (ours.length === 1 && ours[0] === MCP_SERVER_NAME) {
    const keys = mainKeys(MCP_SERVER_NAME);
    const get = (k: string) => keys.find((x) => x.key === k)?.value;
    const envTable = servers.get(MCP_SERVER_NAME)!.find((s) => s.path.length === 3 && s.path[2] === "env");
    const env = envTable ? Object.fromEntries(tomlKeys(lines.slice(envTable.start + 1, envTable.end)).map((k) => [k.key, k.value])) : get("env");
    const stray = keys.some((k) => ["url", "bearer_token_env_var", "type", "cwd"].includes(k.key)) || (envTable && get("env") !== undefined);
    if (get("command") === launcher.command && sameStrings(asStrings(get("args")), launcher.args) && sameEnv(env, launcher.env) && !stray) {
      return { next: text, change: "unchanged" };
    }
  }

  // The user's own keys and sub-tables (tool approvals) on the entry we keep
  const keepName = ours.includes(MCP_SERVER_NAME) ? MCP_SERVER_NAME : ours[0];
  const extraLines = keepName
    ? mainKeys(keepName)
        .filter((k) => !["command", "args", "env", "url", "bearer_token_env_var", "type", "cwd"].includes(k.key))
        .flatMap((k) => k.lines)
    : [];
  // A section's trailing comments and blank lines may belong to what follows: they stay
  const contentEnd = (sec: TomlSection) => {
    let e = sec.end;
    while (e > sec.start + 1 && (!lines[e - 1]!.trim() || lines[e - 1]!.trim().startsWith("#"))) e--;
    return e;
  };
  const extraTables =
    keepName === MCP_SERVER_NAME
      ? servers
          .get(MCP_SERVER_NAME)!
          .filter((sec) => sec.path.length > 2 && sec.path[2] !== "env")
          .flatMap((sec) => ["", ...lines.slice(sec.start, contentEnd(sec))])
      : [];
  const block = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlStr(launcher.command)}`,
    `args = [${launcher.args.map(tomlStr).join(", ")}]`,
    ...extraLines,
    // The standalone launcher (plain Node) needs no env table
    ...(Object.keys(launcher.env).length
      ? ["", `[mcp_servers.${MCP_SERVER_NAME}.env]`, ...Object.entries(launcher.env).map(([k, v]) => `${k} = ${tomlStr(v)}`)]
      : []),
    ...extraTables,
  ];

  const drop = new Set<number>();
  let insertAt = -1;
  for (const name of ours) {
    for (const sec of servers.get(name)!) {
      if (insertAt < 0 || sec.start < insertAt) insertAt = sec.start;
      for (let n = sec.start; n < contentEnd(sec); n++) drop.add(n);
    }
  }
  const out: string[] = [];
  // Right after a removed or inserted block: one blank line between it and what follows, never two
  let seam = false;
  for (let n = 0; n < lines.length; n++) {
    if (n === insertAt) {
      out.push(...block);
      seam = true;
    }
    if (drop.has(n)) {
      seam = true;
      continue;
    }
    const line = lines[n]!;
    if (seam) {
      const prevBlank = !out.length || !out[out.length - 1]!.trim();
      if (!line.trim()) {
        if (prevBlank) continue;
      } else if (!prevBlank) out.push("");
      seam = false;
    }
    out.push(line);
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  if (insertAt < 0) {
    if (out.length) out.push("");
    out.push(...block);
  }
  return { next: out.join(eol) + eol, change: ours.length ? "repaired" : "added" };
}

// --- files ---

/** 20261109-110318123: sorts by time, distinct to the millisecond */
const stamp = () => new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "").replace("T", "-");

async function backup(tool: string, file: string, home: string): Promise<void> {
  const dir = join(mementoDir(home), "backups", "mcp");
  await mkdir(dir, { recursive: true });
  const prefix = `${tool}-`;
  const dest = join(dir, `${prefix}${stamp()}-${basename(file)}`);
  await copyFile(file, dest);
  await chmod(dest, 0o600).catch(() => {});
  const old = (await readdir(dir)).filter((f) => f.startsWith(prefix)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) await rm(join(dir, f), { force: true });
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const mode = await stat(file).then((s) => s.mode & 0o777, () => undefined);
  const tmp = `${file}.memento-tmp`;
  await writeFile(tmp, text, mode === undefined ? undefined : { mode });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      // Windows: briefly locked by the tool or an antivirus scan
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
}

function converge(format: McpFormat, raw: string | null, launcher: McpLauncher, add: boolean): { next: string | null; change: Change } {
  if (format === "codex") {
    const r = convergeCodex(raw ?? "", launcher, add);
    return { next: r.change === "added" || r.change === "repaired" ? r.next : null, change: r.change };
  }
  let config: Json = {};
  if (raw !== null && raw.trim()) {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    config = parsed as Json;
  }
  if (format === "claude") {
    const r = convergeClaude(config, launcher, add);
    return { next: r.change === "added" || r.change === "repaired" ? `${JSON.stringify(r.next, null, 2)}\n` : null, change: r.change };
  }
  const r = convergeServers(obj(config.mcpServers), canonicalEntry(launcher, "json"), add);
  if (r.change !== "added" && r.change !== "repaired") return { next: null, change: r.change };
  return { next: `${JSON.stringify({ ...config, mcpServers: r.next }, null, 2)}\n`, change: r.change };
}

export interface ApplyMcpOptions {
  launcher: McpLauncher | null;
  /** Tools to add the entry to when they have none (the device's resident-profile targets). */
  add: string[];
  home?: string;
  targets?: Record<string, McpTarget>;
}

/**
 * Converge each tool's MCP config. Per tool: unchanged / added / repaired /
 * off (installed, no entry of ours, not a profile target) / absent (not
 * installed) / "error: ...". Empty without a launcher.
 */
export async function applyMcpRegistration(o: ApplyMcpOptions): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  if (!o.launcher) return results;
  const home = o.home ?? homeDir();
  const targets = o.targets ?? defaultMcpTargets(home);
  for (const [tool, t] of Object.entries(targets)) {
    const add = o.add.includes(tool);
    try {
      if (!existsSync(t.toolHome)) {
        if (add) results[tool] = "absent";
        continue;
      }
      // Claude Code's file is its whole state: never created by us
      if (t.format === "claude" && !existsSync(t.file)) {
        if (add) results[tool] = "absent";
        continue;
      }
      let outcome: string | undefined;
      for (let attempt = 0; attempt < 2 && outcome === undefined; attempt++) {
        const raw = await readFile(t.file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
        let r: { next: string | null; change: Change };
        try {
          r = converge(t.format, raw, o.launcher, add);
        } catch (e) {
          outcome = `error: ${t.file} 解析失败（${e instanceof Error ? e.message : e}），没有改动`;
          break;
        }
        if (r.next === null) {
          outcome = r.change === "none" ? "off" : "unchanged";
          break;
        }
        // The tool may have rewritten its file meanwhile: write only over what was read
        const now = await readFile(t.file, "utf8").catch(() => null);
        if (now !== raw) continue;
        if (raw !== null) await backup(tool, t.file, home);
        else await mkdir(dirname(t.file), { recursive: true });
        await writeAtomic(t.file, r.next);
        outcome = r.change;
      }
      results[tool] = outcome ?? "error: 文件一直在被改写，下次再试";
    } catch (e) {
      results[tool] = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
    }
  }
  return results;
}
