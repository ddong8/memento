import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { limitedModels, noteModelLimit, resetModelLimits } from "../src/model-limits.js";
import { codexQuotaFromLimits, probeAllQuotas, probeCodexQuota, readCodexRateLimits, resetCodexRateLimits } from "../src/quotas.js";

// What codex-cli 0.163's app-server answered on a real ChatGPT account, plus a limit of one model's own
const LIMITS = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 4, windowDurationMins: 43200, resetsAt: 1795400703 },
    secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1795000000 },
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", primary: { usedPercent: 4, resetsAt: 1795400703 }, secondary: null },
    luna: { limitId: "luna", normalModelSlug: "gpt-6-luna", primary: { usedPercent: 100, resetsAt: 1794500000 }, rateLimitReachedType: "primary" },
    nova: { limitId: "nova", normalModelSlug: "gpt-6-nova", primary: { usedPercent: 20, resetsAt: 1794500000 } },
  },
};

let dir = "";
afterEach(() => {
  delete process.env.MEMENTO_CODEX_BIN;
  delete process.env.MEMENTO_MODEL_LIMITS_FILE;
  resetCodexRateLimits();
  resetModelLimits();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A stand-in for `codex app-server`: answers initialize and account/rateLimits/read as the real one does. */
function fakeCodex(result: unknown): void {
  dir = mkdtempSync(join(tmpdir(), "memento-codex-limits-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\\n");
    if (m.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: ${JSON.stringify(result)} }) + "\\n");
  }
});
`);
  chmodSync(bin, 0o755);
  process.env.MEMENTO_CODEX_BIN = bin;
}

function codexHome(): string {
  const home = mkdtempSync(join(dir || tmpdir(), "home-"));
  mkdirSync(join(home, ".codex"));
  const claims = Buffer.from(JSON.stringify({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url");
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: `x.${claims}.y`, refresh_token: "r" } }));
  writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-luna" }, { slug: "gpt-6-nova" }, { slug: "gpt-5.5" }] }));
  return home;
}

it("takes the quota left from the window used the most, and a model's own limit by its slug", () => {
  const q = codexQuotaFromLimits(LIMITS);
  expect(q.percent).toBe(63);
  expect(q.reset).toBe(new Date(1795000000 * 1000).toISOString());
  expect(q.models.get("gpt-6-luna")?.percent).toBe(0);
  expect(q.models.get("gpt-6-nova")?.percent).toBe(80);
  expect(q.models.has("gpt-5.5")).toBe(false);
  expect(codexQuotaFromLimits({ rateLimits: { primary: { usedPercent: 50 }, rateLimitReachedType: "primary" } }).percent).toBe(0);
  expect(codexQuotaFromLimits({}).percent).toBeNull();
});

it("reads the rate limits from Codex's app-server", async () => {
  fakeCodex(LIMITS);
  expect((await readCodexRateLimits())?.rateLimits?.secondary?.usedPercent).toBe(37);
});

it("gives up on a Codex that doesn't answer", async () => {
  process.env.MEMENTO_CODEX_BIN = join(tmpdir(), "no-such-codex-binary");
  expect(await readCodexRateLimits(2000)).toBeUndefined();
});

it("reports Codex's real quota left, the account's and each limited model's", async () => {
  fakeCodex(LIMITS);
  const q = await probeCodexQuota(codexHome());
  expect(q.remaining_percent).toBe(63);
  expect(q.models?.find((m) => m.model_id === "gpt-6-luna")?.remaining_percent).toBe(0);
  expect(q.models?.find((m) => m.model_id === "gpt-6-nova")?.remaining_percent).toBe(80);
  // No limit of its own: the account's quota is all there is, not a made-up number
  expect(q.models?.find((m) => m.model_id === "gpt-5.5")?.remaining_percent).toBeNull();
});

it("lets a model go once a fresh quota read shows it has quota again, but not one the account can't use", async () => {
  fakeCodex(LIMITS);
  process.env.MEMENTO_MODEL_LIMITS_FILE = join(dir, "limits.json");
  noteModelLimit("codex", "gpt-6-nova", "You've hit your usage limit for GPT-6-Nova. Switch to another model now");
  noteModelLimit("codex", "gpt-6-luna", "You've hit your usage limit for GPT-6-Luna. Switch to another model now");
  noteModelLimit("codex", "gpt-5.5", "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.");
  expect(limitedModels("codex")[0]?.since).toBeTruthy();
  const report = await probeAllQuotas(codexHome(), { force: true });
  expect(report.tools.codex?.limited_models?.map((l) => l.family).sort()).toEqual(["gpt-5.5", "gpt-6-luna"]);
});
