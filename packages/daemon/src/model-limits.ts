import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { homeDir, mementoDir } from "./config.js";

/**
 * Models out of quota while the agent's other models still answer: Antigravity counts each model on its
 * own, Claude Code has a weekly limit of its own for Opus, Sonnet and Fable on some plans (and per-model
 * team budgets), and Codex a usage limit for one model ("…for X. Switch to another model now"). A task
 * whose model ran out goes on with another, and later tasks skip it until it resets. Kept on disk, so a
 * restart doesn't spend another failing run to learn it again. Limits of the whole account (Claude's
 * session and weekly limit, Codex's plain usage limit) aren't here: no other model helps with those.
 */

export type LimitAgent = "antigravity" | "claude" | "codex";

export interface ModelChoice {
  id: string;
  label: string;
}

interface Entry {
  until: number;
  model: string;
  message: string;
  /** When it ran out; a quota read after this outranks it. */
  since?: number;
}

export interface LimitedModel {
  family: string;
  model: string;
  until: string;
  message: string;
  since?: string;
}

/** A model limit reported without a time it resets: tried again after an hour. */
export const DEFAULT_LIMIT_MS = 3_600_000;

let state: Map<string, Entry> | undefined;
/** The model each agent picks when given none, as its last run named it. */
const defaults = new Map<LimitAgent, string>();

function stateFile(): string | undefined {
  if (process.env.MEMENTO_MODEL_LIMITS_FILE) return process.env.MEMENTO_MODEL_LIMITS_FILE;
  // Tests don't leave state in the real home
  return process.env.VITEST ? undefined : join(mementoDir(), "model-limits.json");
}

function load(): Map<string, Entry> {
  if (state) return state;
  state = new Map();
  const file = stateFile();
  if (!file) return state;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>;
    for (const [k, v] of Object.entries(saved)) if (v && typeof v.until === "number" && v.until > Date.now()) state.set(k, v);
  } catch {
    // none yet, or unreadable: start empty
  }
  return state;
}

function save(): void {
  const file = stateFile();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(load())));
    renameSync(`${file}.tmp`, file);
  } catch {
    // kept in memory
  }
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** What one quota covers: Antigravity's thinking levels share one, Claude's covers every Opus (Sonnet, …) version. */
export function modelFamily(agent: LimitAgent, id: string): string {
  const m = id.trim().toLowerCase();
  if (agent === "claude") return ["fable", "opus", "sonnet", "haiku"].find((f) => m.includes(f)) ?? m;
  if (agent === "antigravity") {
    const parts = m.split("-");
    return parts.length > 1 && EFFORTS.includes(parts.at(-1)!) ? parts.slice(0, -1).join("-") : m;
  }
  return m;
}

export function noteDefaultModel(agent: LimitAgent, id: string | undefined): void {
  if (id?.trim()) defaults.set(agent, id.trim());
}

export function defaultModel(agent: LimitAgent): string {
  return defaults.get(agent) ?? "";
}

/** Remembers that `model` (the agent's default when empty) ran out, until `until` (an hour when unknown). */
export function noteModelLimit(agent: LimitAgent, model: string, message: string, until?: number, now = Date.now()): void {
  const id = model || defaultModel(agent);
  if (!id) return;
  load().set(`${agent}:${modelFamily(agent, id)}`, { until: until && until > now ? until : now + DEFAULT_LIMIT_MS, model: id, message, since: now });
  save();
}

export function isModelLimited(agent: LimitAgent, model: string, now = Date.now()): boolean {
  const id = model || defaultModel(agent);
  if (!id) return false;
  const key = `${agent}:${modelFamily(agent, id)}`;
  const entry = load().get(key);
  if (!entry) return false;
  if (entry.until > now) return true;
  load().delete(key);
  save();
  return false;
}

/** Forgets a limit a fresh quota read shows is over (reset early, or the plan was upgraded). */
export function clearModelLimit(agent: LimitAgent, family: string): boolean {
  if (!load().delete(`${agent}:${family}`)) return false;
  save();
  return true;
}

/** The agent's models still out of quota, for the model picker. */
export function limitedModels(agent: LimitAgent, now = Date.now()): LimitedModel[] {
  const out: LimitedModel[] = [];
  for (const [key, e] of load()) {
    const [a, family] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (a === agent && e.until > now) out.push({
      family, model: e.model, until: new Date(e.until).toISOString(), message: e.message,
      ...(e.since ? { since: new Date(e.since).toISOString() } : {}),
    });
  }
  return out;
}

/** For tests: forgets what's in memory (read again from the file, when there is one). */
export function resetModelLimits(): void {
  state = undefined;
  defaults.clear();
}

/**
 * The model to go on with when `failed` ran out: the first family in `models` (the agent's own order)
 * that isn't out of quota, at the asked thinking level when the agent lists levels as models.
 */
export function nextModel(agent: LimitAgent, models: ModelChoice[], failed: string, effort = "", now = Date.now()): ModelChoice | undefined {
  const skip = modelFamily(agent, failed || defaultModel(agent));
  const want = ["xhigh", "max"].includes(effort) ? "high" : EFFORTS.includes(effort) ? effort : "medium";
  const families = new Map<string, ModelChoice[]>();
  for (const m of models) {
    const f = modelFamily(agent, m.id);
    if (f === skip || isModelLimited(agent, m.id, now)) continue;
    families.set(f, [...(families.get(f) ?? []), m]);
  }
  for (const variants of families.values()) {
    return variants.find((m) => m.id.toLowerCase().endsWith(`-${want}`)) ?? variants.find((m) => m.id.toLowerCase().endsWith("-medium")) ?? variants[0];
  }
  return undefined;
}

// ── Claude Code ──────────────────────────────────────────────────────────────────────────────────────

/** Claude Code's aliases, always its latest version of each; Fable draws on usage credits, so it's never a fallback. */
export const CLAUDE_MODELS: ModelChoice[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];

/** rate_limit_event's rateLimitType for the limits of one model (Claude Code: seven_day_opus → "Opus limit", …). */
const CLAUDE_LIMIT_FAMILY: Record<string, string> = {
  seven_day_opus: "opus",
  seven_day_sonnet: "sonnet",
  seven_day_overage_included: "fable",
};

export interface ModelLimitHit {
  /** The model that ran out; empty for the agent's default. */
  model: string;
  message: string;
  until?: number;
  /** The account can't use the model at all, rather than having used it up. */
  unsupported?: boolean;
}

/**
 * A Claude Code run stopped by a limit of its model, not of the account: "You've hit your Opus limit · resets …"
 * (or Sonnet, Fable), the rate_limit_event that came with it, or a team's budget for the model ("Switch to
 * another model to continue"). `current` is the model the run used.
 */
export function claudeModelLimit(errors: string, current: string, rejected?: { type?: string; resetsAt?: number }): ModelLimitHit | undefined {
  const family = rejected?.type ? CLAUDE_LIMIT_FAMILY[rejected.type] : undefined;
  const until = rejected?.resetsAt ? rejected.resetsAt * 1000 : undefined;
  const named = /You(?:'|’)ve hit your (Opus|Sonnet|Fable|Haiku) limit[^\n"]*/i.exec(errors);
  if (named) return { model: named[1]!.toLowerCase(), message: named[0].trim(), until };
  if (family) return { model: family, message: `You've hit your ${family} limit`, until };
  const team = /You(?:'|’)ve hit your team(?:'|’)s shared budget[^\n"]*Switch to another model[^\n"]*/i.exec(errors);
  if (team) return { model: current, message: team[0].trim(), until };
  return undefined;
}

// ── Codex ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A Codex run stopped by a usage limit of one model: "You've hit your usage limit for GPT-6-Luna. Switch to
 * another model now, or try again at 3:05 PM." The name is the limit's, matched to a model when one has
 * it, else the model the run used.
 */
export function codexModelLimit(errors: string, current: string, models: ModelChoice[], now = Date.now()): ModelLimitHit | undefined {
  // A model the account can't use at all (config.toml names one the plan doesn't have): "The 'gpt-6-astra'
  // model is not supported when using Codex with a ChatGPT account." Skipped for a day, the plan may change.
  const unsupported = /The '([^']+)' model is not supported[^\n"]*/i.exec(errors);
  if (unsupported) return { model: unsupported[1]!, message: unsupported[0].trim(), until: now + UNSUPPORTED_MS, unsupported: true };
  const m = /You(?:'|’)ve hit your usage limit for (.+?)\. Switch to another model[^\n"]*/i.exec(errors);
  if (!m) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const name = norm(m[1]!);
  const model = models.find((x) => norm(x.id) === name || norm(x.label) === name)?.id ?? current;
  return { model, message: m[0].trim() };
}

/** How long a model the account doesn't support is skipped. */
export const UNSUPPORTED_MS = 24 * 3_600_000;

/** The models Codex lists for this account (models_cache.json, its own order), the hidden ones left out. */
export async function codexModels(home = homeDir()): Promise<ModelChoice[]> {
  const codexHome = process.env.CODEX_HOME || join(home, ".codex");
  try {
    const cache = JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8")) as { models?: Record<string, unknown>[] };
    return (cache.models ?? [])
      .filter((m) => m && typeof m.slug === "string" && m.visibility !== "hide")
      .sort((a, b) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
      .map((m) => ({ id: String(m.slug), label: String(m.display_name ?? m.slug) }));
  } catch {
    return [];
  }
}
