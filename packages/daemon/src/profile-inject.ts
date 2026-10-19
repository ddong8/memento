import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";

/**
 * Resident-profile injection: keeps the user's published "about me" block in
 * each enabled AI tool's global instruction file (CLAUDE.md, AGENTS.md, ...).
 *
 * Which tools get it is chosen per device in the app; this only converges files
 * to what the server says. It owns nothing outside its markers: existing text is
 * left alone, a file it created is deleted again when the block goes, and a
 * damaged marker pair is reported rather than guessed at.
 *
 * Markers must match server/server/services/profile_service.py. The state file
 * (~/.memento/profile_inject.json) is shared with the Flutter collector.
 */
export const PROFILE_BEGIN = "<!-- memento:begin";
export const PROFILE_END = "<!-- memento:end -->";
const BLOCK_RE = /<!-- memento:begin[^>]*-->[\s\S]*?<!-- memento:end -->\n?/;

export const PROFILE_SYNC_MS = 5 * 60_000;

export interface ProfileTarget {
  /** The tool's own directory; injection never creates it, so an absent tool is skipped. */
  toolHome: string;
  file: string;
}

export function defaultProfileTargets(home = homeDir(), env: NodeJS.ProcessEnv = process.env): Record<string, ProfileTarget> {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  let geminiRoot = join(home, ".gemini");
  if (process.platform === "win32" && env.APPDATA && existsSync(join(env.APPDATA, ".gemini"))) {
    geminiRoot = join(env.APPDATA, ".gemini");
  }
  const openclaw = join(home, ".openclaw", "workspace");
  return {
    claude_code: { toolHome: join(home, ".claude"), file: join(home, ".claude", "CLAUDE.md") },
    codex: { toolHome: codexHome, file: join(codexHome, "AGENTS.md") },
    antigravity: { toolHome: geminiRoot, file: join(geminiRoot, "GEMINI.md") },
    workbuddy: { toolHome: join(home, ".workbuddy"), file: join(home, ".workbuddy", "MEMORY.md") },
    openclaw: { toolHome: openclaw, file: join(openclaw, "USER.md") },
    hermes: { toolHome: join(home, ".hermes"), file: join(home, ".hermes", "SOUL.md") },
  };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;
const trimNewlines = (text: string) => text.replace(/\n+$/, "");

export function isValidProfileBlock(block: string | null | undefined): block is string {
  return (
    typeof block === "string" &&
    block.startsWith(PROFILE_BEGIN) &&
    trimNewlines(block).endsWith(PROFILE_END) &&
    count(block, PROFILE_BEGIN) === 1 &&
    count(block, PROFILE_END) === 1
  );
}

/** `text` with our block replaced, or appended if absent; null when the markers are damaged. */
export function upsertProfileBlock(text: string, block: string): string | null {
  const begins = count(text, PROFILE_BEGIN);
  const ends = count(text, PROFILE_END);
  if (begins === 0 && ends === 0) return text.trim() ? `${trimNewlines(text)}\n\n${block}` : block;
  if (begins === 1 && ends === 1 && BLOCK_RE.test(text)) return text.replace(BLOCK_RE, () => block);
  return null;
}

/** `text` with our block removed; null when the markers are damaged. */
export function removeProfileBlock(text: string): string | null {
  const begins = count(text, PROFILE_BEGIN);
  const ends = count(text, PROFILE_END);
  if (begins === 0 && ends === 0) return text;
  if (begins === 1 && ends === 1 && BLOCK_RE.test(text)) {
    const rest = text.replace(BLOCK_RE, "");
    return rest.trim() ? `${trimNewlines(rest)}\n` : "";
  }
  return null;
}

type State = Record<string, { version?: number | null; created?: boolean }>;

async function loadState(path: string): Promise<State> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as State;
  } catch {
    return {};
  }
}

const DAMAGED = "error: memento markers damaged, fix the file by hand";

/**
 * Converge instruction files to the server's wishes. Returns tool -> outcome for
 * every tool touched or wanted; tools never enabled here are left out.
 */
export async function applyProfileInjection(options: {
  version: number | null | undefined;
  block: string | null | undefined;
  targets: string[];
  files?: Record<string, ProfileTarget>;
  statePath?: string;
}): Promise<Record<string, string>> {
  const files = options.files ?? defaultProfileTargets();
  const statePath = options.statePath ?? join(mementoDir(), "profile_inject.json");
  const state = await loadState(statePath);
  const block = options.block;
  const hasBlock = isValidProfileBlock(block);
  const wanted = new Set(hasBlock ? options.targets : []);
  const results: Record<string, string> = {};

  for (const [tool, target] of Object.entries(files)) {
    const entry = state[tool];
    try {
      if (wanted.has(tool) && hasBlock) {
        const existed = existsSync(target.file);
        const text = existed ? await readFile(target.file, "utf8") : "";
        if (entry && entry.version === options.version && text.includes(block)) {
          results[tool] = "unchanged";
          continue;
        }
        if (!existsSync(target.toolHome)) {
          results[tool] = "skipped: tool not installed";
          continue;
        }
        const updated = upsertProfileBlock(text, block);
        if (updated === null) {
          results[tool] = DAMAGED;
          continue;
        }
        const backup = `${target.file}.memento.bak`;
        if (existed && !existsSync(backup)) await copyFile(target.file, backup);
        await writeFile(target.file, updated);
        state[tool] = { version: options.version ?? null, created: entry ? entry.created : !existed };
        results[tool] = "written";
      } else if (entry) {
        if (existsSync(target.file)) {
          const text = await readFile(target.file, "utf8");
          const updated = removeProfileBlock(text);
          if (updated === null) {
            results[tool] = DAMAGED;
            continue;
          }
          if (!updated.trim() && entry.created) await rm(target.file);
          else if (updated !== text) await writeFile(target.file, updated);
        }
        delete state[tool];
        results[tool] = "removed";
      } else if (options.targets.includes(tool) && !hasBlock) {
        results[tool] = "waiting: no published profile yet";
      }
    } catch (e) {
      // One broken file must not stop the others.
      results[tool] = `error: ${e instanceof Error ? e.message : e}`.slice(0, 200);
    }
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));

  if (hasBlock && block) {
    try {
      const snapshotPath = join(mementoDir(), "mind_snapshot.json");
      await writeFile(
        snapshotPath,
        JSON.stringify({ version: options.version ?? null, block, updatedAt: new Date().toISOString() }, null, 2),
      );
    } catch {
      // Best-effort offline snapshot
    }
  }

  return results;
}

/** Retrieve the cached mind snapshot for offline subagent execution. */
export async function getOfflineMindSnapshot(): Promise<string | null> {
  try {
    const snapshotPath = join(mementoDir(), "mind_snapshot.json");
    if (!existsSync(snapshotPath)) return null;
    const raw = await readFile(snapshotPath, "utf8");
    const parsed = JSON.parse(raw) as { block?: string };
    return parsed.block || null;
  } catch {
    return null;
  }
}
