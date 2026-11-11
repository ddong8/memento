import { execFile } from "node:child_process";

/**
 * Google's agy CLI keeps a quota per model ("Individual quota reached … Resets in 58h12m23s." for
 * Gemini 4 Argon while Gemini 3.8 Flash and the Claude models still answer). A task whose model ran
 * out goes on with another one; models known to be out are skipped until they reset.
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

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** A model without its thinking level: "gemini-4-argon-medium" → "gemini-4-argon". The levels share one quota. */
export function modelFamily(id: string): string {
  const parts = id.trim().toLowerCase().split("-");
  return parts.length > 1 && EFFORTS.includes(parts.at(-1)!) ? parts.slice(0, -1).join("-") : id.trim().toLowerCase();
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

/** Model families out of quota, until when (ms since epoch). Per daemon process. */
const exhausted = new Map<string, number>();
/** The model the CLI picks when given none, as its last run reported it. */
let cliDefault = "";

export function noteDefaultModel(id: string | undefined): void {
  if (id?.trim()) cliDefault = id.trim();
}

/** Remembers that `model` (or the CLI default when empty) ran out; quota with no reset time is skipped for an hour. */
export function noteQuotaExhausted(model: string, message: string, now = Date.now()): void {
  const id = model || cliDefault;
  if (id) exhausted.set(modelFamily(id), now + (quotaResetMs(message) ?? 3_600_000));
}

export function isExhausted(model: string, now = Date.now()): boolean {
  const id = model || cliDefault;
  if (!id) return false;
  const until = exhausted.get(modelFamily(id));
  if (until === undefined) return false;
  if (until > now) return true;
  exhausted.delete(modelFamily(id));
  return false;
}

/** For tests. */
export function resetAgyQuotaState(): void {
  exhausted.clear();
  cliDefault = "";
}

/**
 * The model to go on with when `failed` ran out: the first family in the CLI's own order that isn't
 * out of quota, at the requested thinking level when it has one (else medium, else its first).
 */
export function nextAgyModel(models: AgyModel[], failed: string, effort = "", now = Date.now()): AgyModel | undefined {
  const skip = modelFamily(failed || cliDefault);
  const want = ["xhigh", "max"].includes(effort) ? "high" : EFFORTS.includes(effort) ? effort : "medium";
  const families = new Map<string, AgyModel[]>();
  for (const m of models) {
    const f = modelFamily(m.id);
    if (f === skip || isExhausted(m.id, now)) continue;
    families.set(f, [...(families.get(f) ?? []), m]);
  }
  for (const variants of families.values()) {
    return variants.find((m) => m.id.toLowerCase().endsWith(`-${want}`)) ?? variants.find((m) => m.id.toLowerCase().endsWith("-medium")) ?? variants[0];
  }
  return undefined;
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
