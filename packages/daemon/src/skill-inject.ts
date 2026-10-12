import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";

/**
 * Skill injection: keeps each published Memento skill as <skills dir>/<name>/SKILL.md
 * in the tools' personal skills folders — ~/.claude/skills for Claude Code,
 * ~/.agents/skills for Codex and Gemini CLI.
 *
 * It owns only what it wrote: a skill directory is ours while the state file
 * records it and its SKILL.md still hashes to what we wrote. A same-named skill
 * the user made is never touched; one we wrote that the user then edited is left
 * alone and handed over to them. State (~/.memento/skill_inject.json) is shared
 * with the Flutter collector.
 */
export const SKILL_SYNC_MS = 5 * 60_000;

export interface SkillDirTarget {
  /** The folder is only used when at least one of these tool homes exists. */
  toolHomes: string[];
  dir: string;
}

export function defaultSkillDirs(home = homeDir(), env: NodeJS.ProcessEnv = process.env): Record<string, SkillDirTarget> {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  return {
    claude: { toolHomes: [join(home, ".claude")], dir: join(home, ".claude", "skills") },
    agents: { toolHomes: [codexHome, join(home, ".gemini"), join(home, ".agents")], dir: join(home, ".agents", "skills") },
    workbuddy: { toolHomes: [join(home, ".workbuddy")], dir: join(home, ".workbuddy", "skills") },
  };
}

export const skillHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isValidSkillName = (name: string) => name.length <= 64 && SLUG.test(name);

type Owned = Record<string, { hash: string; version?: unknown }>;

async function loadState(path: string): Promise<Record<string, Owned>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, Owned>;
  } catch {
    return {};
  }
}

/**
 * Converge the skills folders to what the server publishes. `skills`: each
 * {slug, version, content}; `targets`: folder keys ("claude", "agents") this
 * device carries them in. Returns "<folder>/<slug>" (or "<folder>") -> outcome.
 */
export async function applySkillInjection(options: {
  skills: Record<string, unknown>[];
  targets: string[];
  dirs?: Record<string, SkillDirTarget>;
  statePath?: string;
}): Promise<Record<string, string>> {
  const dirs = options.dirs ?? defaultSkillDirs();
  const statePath = options.statePath ?? join(mementoDir(), "skill_inject.json");
  const state = await loadState(statePath);
  const results: Record<string, string> = {};

  for (const [key, target] of Object.entries(dirs)) {
    const owned: Owned = { ...(state[key] ?? {}) };
    const wanted = options.targets.includes(key) ? options.skills : [];
    if (!wanted.length && !Object.keys(owned).length) continue;
    const installed = target.toolHomes.some((d) => existsSync(d));
    if (wanted.length && !installed) results[key] = "skipped: tool not installed";
    const wantedNames = new Set<string>();

    if (installed) {
      for (const skill of wanted) {
        const name = String(skill.slug ?? "");
        const content = String(skill.content ?? "");
        const label = `${key}/${name}`;
        if (!isValidSkillName(name) || !content) {
          results[label] = "error: invalid skill";
          continue;
        }
        wantedNames.add(name);
        try {
          const file = join(target.dir, name, "SKILL.md");
          const mine = owned[name];
          if (existsSync(file)) {
            const current = await readFile(file, "utf8");
            if (!mine) {
              results[label] = "skipped: a skill with this name already exists";
              continue;
            }
            if (skillHash(current) !== mine.hash) {
              delete owned[name]; // edited by hand after we wrote it: the user's now
              results[label] = "kept: edited locally";
              continue;
            }
            if (current === content) {
              results[label] = "unchanged";
              continue;
            }
          }
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, content);
          owned[name] = { hash: skillHash(content), version: skill.version };
          results[label] = mine ? "updated" : "written";
        } catch (e) {
          results[label] = `error: ${e instanceof Error ? e.message : e}`.slice(0, 200);
        }
      }
    }

    // Anything we wrote that is no longer wanted here comes back out.
    for (const name of Object.keys(owned)) {
      if (wantedNames.has(name)) continue;
      const label = `${key}/${name}`;
      try {
        const file = join(target.dir, name, "SKILL.md");
        if (existsSync(file)) {
          const current = await readFile(file, "utf8");
          if (skillHash(current) === owned[name]!.hash) {
            await rm(file);
            const dir = dirname(file);
            if (existsSync(dir) && !(await readdir(dir)).length) await rmdir(dir);
            results[label] = "removed";
          } else {
            results[label] = "kept: edited locally";
          }
        }
        delete owned[name];
      } catch (e) {
        results[label] = `error: ${e instanceof Error ? e.message : e}`.slice(0, 200);
      }
    }

    if (Object.keys(owned).length) state[key] = owned;
    else delete state[key];
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
  return results;
}
