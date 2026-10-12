import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { homeDir } from "./config.js";

/** A project found inside an AI tool's data directory. */
export interface DiscoveredProject {
  name: string;
  path: string;
  sessionCount?: number;
  metadata?: Record<string, unknown>;
}

/** An installed AI tool (Claude Code, Codex, Antigravity, Obsidian, ...). */
export interface DiscoveredTool {
  id: string;
  name: string;
  root: string;
  projects: DiscoveredProject[];
  metadata?: Record<string, unknown>;
}

/** The shape the server's discovery report takes. */
export function toolReport(tool: DiscoveredTool): Record<string, unknown> {
  return {
    root: tool.root,
    projects: tool.projects.map((p) => ({ name: p.name, path: p.path, session_count: p.sessionCount ?? 0, ...p.metadata })),
    ...tool.metadata,
  };
}

export interface DiscoveryEnv {
  home: string;
  platform: NodeJS.Platform;
  appData?: string;
  xdgConfig?: string;
}

const defaultEnv = (): DiscoveryEnv => ({
  home: homeDir(),
  platform: process.platform,
  appData: process.env.APPDATA,
  xdgConfig: process.env.XDG_CONFIG_HOME,
});

/** Where an Electron / VS Code style app keeps its settings on this OS. */
function appSettingsDir(env: DiscoveryEnv, app: string): string | undefined {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", app);
  if (env.platform === "win32") return join(env.appData ?? join(env.home, "AppData", "Roaming"), app);
  if (env.platform === "linux") return join(env.xdgConfig ?? join(env.home, ".config"), app);
  return undefined;
}

function stripQuotes(s: string): string {
  let str = s.trim();
  while (str && /^["'`]/.test(str)) str = str.slice(1).trim();
  while (str && /["'`]$/.test(str)) str = str.slice(0, -1).trim();
  return str;
}

export function cleanPath(path: string, platform: NodeJS.Platform = process.platform): string {
  let cleaned = stripQuotes(path);
  if (cleaned.startsWith("\\\\?\\")) cleaned = cleaned.slice(4);
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = fileURLToPath(cleaned);
    } catch {
      cleaned = cleaned.replace(/^file:\/+/, "");
      if (platform !== "win32") cleaned = `/${cleaned}`;
    }
  }
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch {
    // keep as is
  }
  return stripQuotes(cleaned);
}

const INVALID_NAMES = new Set([
  "", "-", "--", "...", "none", "null", "file:", "file", "untitled", "unknown", "tmp", "temp", "dev", "desktop", "workspace",
]);

export function isInvalidProjectName(name: string): boolean {
  const lower = stripQuotes(name).toLowerCase().replace(/^[_\-./\\]+|[_\-./\\]+$/g, "");
  return INVALID_NAMES.has(lower);
}

/** On macOS, touching /Volumes/<name> that isn't mounted triggers a network-volume prompt; skip those. */
export function isVolumeMounted(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "darwin" || !path.startsWith("/Volumes/")) return true;
  const vol = path.split("/")[2];
  if (!vol) return false;
  try {
    return readdirSync("/Volumes").includes(vol);
  } catch {
    return false;
  }
}

const prettify = (name: string) => stripQuotes(stripQuotes(name).replace(/^\d{4}-?\d{2,4}-?/, ""));

/** Claude Code names project folders after the path with "/" as "-": recover name and path. */
export function decodeClaudeDir(dirName: string, exists: (p: string) => boolean = existsSync): [string, string] {
  let raw = dirName.trim();
  if (raw === "-" || !raw.replace(/^[_-]+|[_-]+$/g, "")) return ["", ""];
  if (raw.startsWith("-") || raw.startsWith("Users-") || raw.startsWith("home-")) {
    if (raw.startsWith("-")) raw = raw.slice(1);
    const decoded = `/${raw.replace(/-/g, "/")}`;
    const name = prettify(basename(decoded));
    return name === "-" || isInvalidProjectName(name) ? ["", ""] : [name, decoded];
  }
  const win = /^([a-zA-Z])--?(.+)$/.exec(raw);
  if (win) {
    const drive = win[1]!.toUpperCase();
    const rest = win[2]!;
    let decoded = `${drive}:/${rest.replace(/-/g, "/")}`;
    let name: string;
    const dev = /^dev-(\d{4})-(\d{2,4})-(.+)$/.exec(rest);
    if (dev) {
      const [, year, date, proj] = dev as unknown as [string, string, string, string];
      const underscore = `${drive}:/dev/${year}/${date}/${proj.replace(/-/g, "_")}`;
      const hyphen = `${drive}:/dev/${year}/${date}/${proj}`;
      if (exists(underscore)) {
        decoded = underscore;
        name = proj.replace(/-/g, "_");
      } else {
        decoded = hyphen;
        name = proj;
      }
    } else {
      const parts = rest.split("/");
      name = parts[parts.length - 1] ?? raw;
    }
    name = prettify(name);
    return name === "-" || isInvalidProjectName(name) ? ["", ""] : [name, decoded];
  }
  return [raw, raw];
}

async function firstCwd(dir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const rl = createInterface({ input: createReadStream(join(dir, f), { encoding: "utf8" }) });
    let n = 0;
    try {
      for await (const line of rl) {
        if (++n > 10) break;
        if (!line.includes('"cwd"') && !line.includes('"type":"init"')) continue;
        try {
          const obj = JSON.parse(line) as { cwd?: unknown };
          if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd.replace(/\\/g, "/");
        } catch {
          // not JSON
        }
      }
    } finally {
      rl.close();
    }
  }
  return undefined;
}

export async function discoverClaudeCode(env = defaultEnv()): Promise<DiscoveredTool | null> {
  const root = join(env.home, ".claude");
  if (!existsSync(root)) return null;
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  const projectsDir = join(root, "projects");
  let dirs: string[] = [];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // no projects yet
  }
  for (const dirName of dirs) {
    let name = "";
    let realPath = (await firstCwd(join(projectsDir, dirName))) ?? "";
    if (realPath) name = prettify(basename(realPath));
    if (!name || !realPath) [name, realPath] = decodeClaudeDir(dirName);
    const clean = cleanPath(realPath, env.platform);
    if (clean && isVolumeMounted(clean, env.platform) && !seen.has(clean)) {
      seen.add(clean);
      if (!isInvalidProjectName(name)) projects.push({ name, path: clean, metadata: { hash: dirName } });
    }
  }
  return { id: "claude_code", name: "Claude Code", root, projects };
}

export async function discoverCodex(env = defaultEnv()): Promise<DiscoveredTool | null> {
  const root = join(env.home, ".codex");
  if (!existsSync(root)) return null;
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  const add = (raw: string, name?: string) => {
    const path = cleanPath(raw, env.platform);
    if (!path || !isVolumeMounted(path, env.platform) || seen.has(path)) return;
    seen.add(path);
    const projName = name || basename(path);
    if (!isInvalidProjectName(projName)) projects.push({ name: projName, path });
  };
  try {
    const data = JSON.parse(await readFile(join(root, ".codex-global-state.json"), "utf8")) as Record<string, unknown>;
    const local = data["local-projects"];
    if (local && typeof local === "object") {
      for (const entry of Object.values(local as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as { name?: unknown; rootPaths?: unknown };
        const name = String(e.name ?? "").trim();
        for (const r of Array.isArray(e.rootPaths) ? e.rootPaths : []) add(String(r), name);
      }
    }
    for (const key of ["electron-saved-workspace-roots", "active-workspace-roots"]) {
      const roots = data[key];
      if (Array.isArray(roots)) for (const r of roots) add(String(r));
    }
  } catch {
    // no global state
  }
  let sessions = 0;
  try {
    sessions = (await readdir(join(root, "sessions"))).length;
  } catch {
    // none
  }
  return { id: "codex", name: "OpenAI Codex", root, projects, metadata: { total_sessions: sessions } };
}

/** Workspace folders a VS Code style app (Antigravity, Cursor, Windsurf) remembers. */
export async function extractVscWorkspaces(globalStorage: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (rawUri: string) => {
    const cleaned = cleanPath(rawUri, platform);
    if (!cleaned || !isVolumeMounted(cleaned, platform) || isInvalidProjectName(basename(cleaned))) return;
    const lower = cleaned.toLowerCase();
    if (
      lower.includes("/.gemini/antigravity/playground/") ||
      lower.includes("\\.gemini\\antigravity\\playground\\") ||
      /\.(json|ya?ml|py|md)$/.test(lower)
    ) {
      return;
    }
    try {
      if (!statSync(cleaned).isDirectory()) return;
    } catch {
      return;
    }
    if (!seen.has(cleaned)) {
      seen.add(cleaned);
      paths.push(cleaned);
    }
  };

  try {
    const raw = await readFile(join(globalStorage, "storage.json"), "utf8");
    const data = JSON.parse(raw) as Record<string, any>;
    for (const f of data.backupWorkspaces?.folders ?? []) if (f?.folderUri) add(String(f.folderUri));
    for (const k of Object.keys(data.profileAssociations?.workspaces ?? {})) add(k);
    for (const m of raw.matchAll(/"(?:folderUri|path)"\s*:\s*"([^"]+)"/g)) if (m[1]) add(m[1]);
  } catch {
    // no storage.json
  }
  try {
    const content = (await readFile(join(globalStorage, "state.vscdb"))).toString("utf8");
    for (const m of content.matchAll(/"folderUri"\s*:\s*"([^"]+)"/g)) if (m[1]) add(m[1]);
    for (const m of content.matchAll(/file:\/\/\/[a-zA-Z0-9_%/.-]+/g)) add(m[0]);
  } catch {
    // no state db
  }
  return paths;
}

async function vscTool(
  env: DiscoveryEnv,
  id: string,
  name: string,
  app: string,
  homeRoot: string,
): Promise<DiscoveredTool | null> {
  const settings = appSettingsDir(env, app);
  const storage = settings ? join(settings, "User", "globalStorage") : undefined;
  const hasRoot = existsSync(homeRoot);
  const hasStorage = storage !== undefined && existsSync(storage);
  if (!hasRoot && !hasStorage) return null;
  const projects: DiscoveredProject[] = [];
  if (hasStorage) {
    for (const path of await extractVscWorkspaces(storage!, env.platform)) {
      const projName = basename(path);
      if (!isInvalidProjectName(projName)) projects.push({ name: projName, path });
    }
  }
  return { id, name, root: hasRoot ? homeRoot : dirname(storage!), projects };
}

export const discoverAntigravity = (env = defaultEnv()) => {
  const gemini = join(env.home, ".gemini", "antigravity");
  return vscTool(env, "antigravity", "Google Antigravity", "Antigravity", existsSync(gemini) ? gemini : join(env.home, ".antigravity"));
};
export const discoverCursor = (env = defaultEnv()) => vscTool(env, "cursor", "Cursor", "Cursor", join(env.home, ".cursor"));
export const discoverWindsurf = (env = defaultEnv()) =>
  vscTool(env, "windsurf", "Windsurf", "Windsurf", join(env.home, ".codeium", "windsurf"));

export async function discoverCline(env = defaultEnv()): Promise<DiscoveredTool | null> {
  const code = appSettingsDir(env, "Code");
  if (!code) return null;
  for (const ext of ["saoudrizwan.claude-dev", "rooveterinaryinc.roo-cline"]) {
    const dir = join(code, "User", "globalStorage", ext);
    if (existsSync(dir)) return { id: "cline", name: "Cline", root: dir, projects: [] };
  }
  return null;
}

export async function discoverObsidian(env = defaultEnv()): Promise<DiscoveredTool | null> {
  const dir = appSettingsDir(env, "obsidian");
  if (!dir) return null;
  const file = join(dir, "obsidian.json");
  if (!existsSync(file)) return null;
  const projects: DiscoveredProject[] = [];
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as { vaults?: Record<string, { path?: unknown; ts?: unknown }> };
    for (const v of Object.values(data.vaults ?? {})) {
      if (typeof v?.path !== "string") continue;
      const path = cleanPath(v.path, env.platform);
      const name = basename(path);
      if (!isInvalidProjectName(name)) projects.push({ name, path, metadata: { ts: v.ts } });
    }
  } catch {
    // unreadable
  }
  return { id: "obsidian", name: "Obsidian", root: dir, projects };
}

export async function discoverWorkbuddy(env = defaultEnv()): Promise<DiscoveredTool | null> {
  const root = join(env.home, ".workbuddy");
  if (!existsSync(root)) return null;
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  const projectsDir = join(root, "projects");
  let dirs: string[] = [];
  try {
    dirs = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    // no projects yet
  }
  for (const dirName of dirs) {
    let name = "";
    let realPath = (await firstCwd(join(projectsDir, dirName))) ?? "";
    if (realPath) name = prettify(basename(realPath));
    if (!name || !realPath) [name, realPath] = decodeClaudeDir(dirName);
    let clean = cleanPath(realPath, env.platform);
    if (/[/\\]WorkBuddy[/\\]\d{4}[-_]?\d{2}/i.test(clean)) {
      clean = dirname(clean);
      name = "WorkBuddy";
    }
    if (clean && isVolumeMounted(clean, env.platform) && !seen.has(clean)) {
      seen.add(clean);
      if (!isInvalidProjectName(name)) projects.push({ name, path: clean, metadata: { hash: dirName } });
    }
  }
  return { id: "workbuddy", name: "WorkBuddy", root, projects };
}

/** Every supported tool installed on this machine, by id. */
export async function discoverAll(env = defaultEnv()): Promise<Record<string, DiscoveredTool>> {
  const found = await Promise.all([
    discoverClaudeCode(env),
    discoverCodex(env),
    discoverAntigravity(env),
    discoverWorkbuddy(env),
    discoverCursor(env),
    discoverWindsurf(env),
    discoverCline(env),
    discoverObsidian(env),
  ]);
  return Object.fromEntries(found.filter((t): t is DiscoveredTool => t !== null).map((t) => [t.id, t]));
}

/** Newest modification time of a file or directory, for sorting. */
export async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}
