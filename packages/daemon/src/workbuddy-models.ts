import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkbuddyModel {
  id: string;
  name: string;
  desc: string;
  /** Credits per use relative to the base rate, as WorkBuddy shows it ("x0.69") */
  credits?: string;
  /** WorkBuddy's own default model */
  is_workbuddy_default?: boolean;
}

const CONFIG_RE = /^acc-product-config(?:-v(\d+))?\.json$/;

/** The newest product config WorkBuddy cached in ~/.workbuddy/cache (acc-product-config-v3.json in 5.8). */
async function productConfigPath(home: string): Promise<string | undefined> {
  const dir = join(home, ".workbuddy", "cache");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const found = names
    .map((n) => ({ n, v: CONFIG_RE.exec(n) }))
    .filter((x): x is { n: string; v: RegExpExecArray } => x.v !== null)
    .sort((a, b) => Number(b.v[1] ?? 0) - Number(a.v[1] ?? 0));
  return found[0] ? join(dir, found[0].n) : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The models WorkBuddy's CLI agent offers right now. WorkBuddy's server hands out a product config that
 * its CLI (codebuddy-lite-wb.mjs) caches in ~/.workbuddy/cache: `agents` names the "cli" agent's model
 * ids, `models` describes each. null when there's no such cache (WorkBuddy never ran here).
 */
export async function workbuddyProductModels(home: string): Promise<WorkbuddyModel[] | null> {
  const path = await productConfigPath(home);
  if (!path) return null;
  let cfg: unknown;
  try {
    cfg = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(cfg) || !Array.isArray(cfg.models) || !Array.isArray(cfg.agents)) return null;
  const cli = cfg.agents.find((a) => isObject(a) && a.name === "cli");
  const ids = isObject(cli) && Array.isArray(cli.models) ? cli.models.filter((x): x is string => typeof x === "string") : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const m of cfg.models) if (isObject(m) && typeof m.id === "string") byId.set(m.id, m);
  const models: WorkbuddyModel[] = [];
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    const credits = typeof m.credits === "string" && m.credits ? m.credits : undefined;
    const desc = String(m.descriptionZh || m.descriptionEn || "").trim();
    models.push({
      id,
      name: String(m.name || id),
      desc: credits ? `${desc}${desc ? " · " : ""}积分 ${credits.replace(/^x/, "×")}` : desc,
      ...(credits ? { credits } : {}),
      ...(m.isDefault === true ? { is_workbuddy_default: true } : {}),
    });
  }
  return models.length ? models : null;
}
