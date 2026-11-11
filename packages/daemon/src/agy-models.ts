import { execFile } from "node:child_process";

import { modelFamily as familyOf, isModelLimited, nextModel, noteDefaultModel as noteDefault, noteModelLimit, resetModelLimits } from "./model-limits.js";

/**
 * Google's agy CLI keeps a quota per model ("Individual quota reached … Resets in 58h12m23s." for
 * Gemini 4 Argon while Gemini 3.8 Flash and the Claude models still answer). A task whose model ran
 * out goes on with another one; models known to be out are skipped until they reset (model-limits.ts).
 */

export interface AgyModel {
  id: string;
  label: string;
}

// "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58h12m23s."
const QUOTA = /Individual quota reached[^\n"]*/i;

/** The CLI's quota message, from a run's errors; undefined for any other failure (no capacity is not quota). */
export function agyQuotaMessage(errors: string): string | undefined {
  return QUOTA.exec(errors)?.[0].trim();
}

/** "Resets in 58h12m23s" in ms; undefined when the message doesn't say. */
export function quotaResetMs(message: string): number | undefined {
  const m = /Resets in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(message);
  if (!m) return undefined;
  const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let ms = 0;
  for (const [, n, u] of m[1]!.matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(n) * unit[u!.toLowerCase()]!;
  return ms || undefined;
}

/** A model without its thinking level: "gemini-4-argon-medium" → "gemini-4-argon". The levels share one quota. */
export function modelFamily(id: string): string {
  return familyOf("antigravity", id);
}

/** `agy models` output: one "id<TAB>label" per line after "Fetching available models...". */
export function parseAgyModels(text: string): AgyModel[] {
  const models: AgyModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [id, ...rest] = line.split("\t");
    if (!id?.trim() || !rest.length || /\s/.test(id.trim())) continue;
    models.push({ id: id.trim(), label: rest.join("\t").trim() || id.trim() });
  }
  return models;
}

export function noteDefaultModel(id: string | undefined): void {
  noteDefault("antigravity", id);
}

/** Remembers that `model` (or the CLI default when empty) ran out; quota with no reset time is skipped for an hour. */
export function noteQuotaExhausted(model: string, message: string, now = Date.now()): void {
  const reset = quotaResetMs(message);
  noteModelLimit("antigravity", model, message, reset ? now + reset : undefined, now);
}

export function isExhausted(model: string, now = Date.now()): boolean {
  return isModelLimited("antigravity", model, now);
}

/** For tests. */
export function resetAgyQuotaState(): void {
  resetModelLimits();
}

/**
 * The model to go on with when `failed` ran out: the first family in the CLI's own order that isn't
 * out of quota, at the requested thinking level when it has one (else medium, else its first).
 */
export function nextAgyModel(models: AgyModel[], failed: string, effort = "", now = Date.now()): AgyModel | undefined {
  return nextModel("antigravity", models, failed, effort, now);
}

let listed: { at: number; models: AgyModel[] } | undefined;

/** The models this account can use, from `agy models` (cached ten minutes; empty when it fails). */
export async function listAgyModels(cli: string, env: NodeJS.ProcessEnv): Promise<AgyModel[]> {
  if (listed && Date.now() - listed.at < 600_000 && listed.models.length) return listed.models;
  const text = await new Promise<string>((resolve) => {
    execFile(cli, ["models"], { env, timeout: 30_000, windowsHide: true, maxBuffer: 1 << 20 }, (_e, stdout) => resolve(String(stdout ?? "")));
  });
  const models = parseAgyModels(text);
  if (models.length) listed = { at: Date.now(), models };
  return models;
}
