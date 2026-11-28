// Regression & unit tests for the 7 self-evolution upgrades.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compactToolCallForStorage } from "../src/services/ask-store";
import { CLI_GUARD_TOOLS, evaluateAskCompletionGuard, GUARD_TOOLS } from "../src/services/guard-service";
import { feedbackMultiplier, getRecentlyInjectedMemoryIds, termsFor, trackInjectedMemories } from "../src/services/guidance-service";
import {
  cosineSimilarity,
  DEFAULT_DOMAIN_SCENARIOS,
  detectScenario,
  enrichCheckRulesResult,
  getAllScenarios,
  registerScenario,
  renderMindResonanceMarkdown,
  unregisterScenario,
  type ResonancePayload,
} from "../src/services/mind-resonance-service";
import { capText, profileSaturation } from "../src/services/profile-read";
import { autoPublishEnabled } from "../src/services/skills";

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("self-evolution upgrades", () => {
  it("guards against single-backslash \\s escapes in SQL template literals across server/src", () => {
    const srcDir = join(import.meta.dirname, "../src");
    const evalSrc = readFileSync(join(srcDir, "services/eval-service.ts"), "utf8");
    const learningSrc = readFileSync(join(srcDir, "services/learning-eval-service.ts"), "utf8");

    expect(evalSrc).toContain("'\\\\s+'");
    expect(evalSrc).not.toContain("'\\s+'");
    expect(learningSrc).toContain("'^\\\\s*<'");
    expect(learningSrc).not.toContain("'^\\s*<'");

    // Global scan: no SQL tagged template literal may contain a single-backslash '\s'
    const broken: string[] = [];
    for (const file of walkTs(srcDir)) {
      const content = readFileSync(file, "utf8");
      const sqlBlocks = content.matchAll(/sql`([\s\S]*?)`/g);
      for (const m of sqlBlocks) {
        const body = m[1] ?? "";
        if (/(?<!\\)\\[sdwbDSWB]/.test(body)) {
          broken.push(`${file}: ${body.slice(0, 120)}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("computes profile saturation accurately and protects newly appended rules during capText", () => {
    const base = [
      "### 铁律",
      `- ${"这是一条非常冗长且包含大量历史细节说明的旧规则条目用于占用字符空间".repeat(4)}`,
      "- 新采纳的关键短规则必须保留",
    ].join("\n");
    const sat = profileSaturation(base);
    expect(sat.general_limit).toBe(1800);
    expect(sat.general_chars).toBe(base.length);
    expect(sat.saturated).toBe(false);

    const capped = capText(base, 80);
    expect(capped.length).toBeLessThanOrEqual(80);
    expect(capped).toContain("新采纳的关键短规则必须保留");
  });

  it("isolates dynamic Mind Resonance scenarios per user and removes hardcoded personal projects from defaults", () => {
    for (const s of DEFAULT_DOMAIN_SCENARIOS) {
      expect(s.target_project).toBeNull();
      expect(s.keywords).not.toContain("pubchem");
      expect(s.keywords).not.toContain("workbuddy");
    }

    registerScenario(
      {
        id: "user_a_secret_proj",
        name: "用户 A 专属领域",
        keywords: ["secret_alpha_token"],
        mindset: "仅属于用户 A 的心智模型",
        target_project: "alpha",
      },
      { userId: "user-a" },
    );

    try {
      const listA = getAllScenarios("user-a");
      const listB = getAllScenarios("user-b");
      expect(listA.some((s) => s.id === "user_a_secret_proj")).toBe(true);
      expect(listB.some((s) => s.id === "user_a_secret_proj")).toBe(false);

      const detA = detectScenario(termsFor("secret_alpha_token"), "处理 secret_alpha_token 任务", undefined, "user-a");
      const detB = detectScenario(termsFor("secret_alpha_token"), "处理 secret_alpha_token 任务", undefined, "user-b");
      expect(detA.id).toBe("user_a_secret_proj");
      expect(detB.id).toBe("general_engineering");
    } finally {
      unregisterScenario("user_a_secret_proj", "user-a");
    }

    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it("escalates stubborn rules prominently in both Mind Resonance markdown and check_rules output", () => {
    const payload: ResonancePayload = {
      scenario: DEFAULT_DOMAIN_SCENARIOS[0]!,
      mindset: "测试心智",
      scoped_rules: [],
      general_rules: ["始终用中文回复"],
      entities: [],
      pitfalls: [],
      durable_corrections: [],
      stubborn_rules: [{ statement: "不要输出 Markdown 加粗符号", times: 3 }],
      blueprint_summary: "",
      user_blueprint_summary: "",
    };
    const md = renderMindResonanceMarkdown(payload);
    expect(md).toContain("高频顽固红线");
    expect(md).toContain("近期重申 3 次");
    expect(md).toContain("不要输出 Markdown 加粗符号");

    const checked = enrichCheckRulesResult("# 检查结果", payload);
    expect(checked).toContain("高频顽固红线");
    expect(checked).toContain("不要输出 Markdown 加粗符号");
  });

  it("applies bounded feedback multiplier and tracks recently injected memories without Redis", async () => {
    expect(feedbackMultiplier(0, 0)).toBe(1);
    expect(feedbackMultiplier(3, 0)).toBeGreaterThan(1);
    expect(feedbackMultiplier(0, 3)).toBeLessThan(1);
    expect(feedbackMultiplier(100, 0)).toBe(1.45);
    expect(feedbackMultiplier(0, 100)).toBe(0.55);

    await trackInjectedMemories(null, "u-local-1", ["m1", "m2"]);
    await trackInjectedMemories(null, "u-local-1", ["m2", "m3"]);
    expect(await getRecentlyInjectedMemoryIds(null, "u-local-1")).toEqual(["m1", "m2", "m3"]);
  });

  it("evaluates Ask Orchestrator completion guard accurately and includes memento_ask/antigravity in GUARD_TOOLS", () => {
    expect(GUARD_TOOLS).toContain("memento_ask");
    expect(GUARD_TOOLS).toContain("antigravity");
    expect(CLI_GUARD_TOOLS).toEqual(["claude_code", "codex"]);

    // Unverified completion claim after mutating command -> blocked no_evidence
    const noEvidence = evaluateAskCompletionGuard("已经全部修复完成并上线生效！", [
      { name: "run_on_device", args: { action: "shell", command: "sed -i 's/a/b/g' app.ts" }, status: "executed", result: { exit_code: 0 } },
    ]);
    expect(noEvidence?.outcome).toBe("no_evidence");
    expect(noEvidence?.blocked).toBe(true);
    expect(noEvidence?.deploy).toBe(true);

    // Failed command without subsequent verification -> blocked failed_check
    const failed = evaluateAskCompletionGuard("已完成修复", [
      { name: "run_on_device", args: { action: "shell", command: "npm test" }, status: "failed", result: { exit_code: 1 } },
    ]);
    expect(failed?.outcome).toBe("failed_check");
    expect(failed?.blocked).toBe(true);

    // Honest disclosure when check failed -> disclosed, not blocked
    const disclosed = evaluateAskCompletionGuard("修改已完成，但测试执行失败报错，尚未验证通过。", [
      { name: "run_on_device", args: { action: "shell", command: "npm test" }, status: "failed", result: { exit_code: 1 } },
    ]);
    expect(disclosed?.outcome).toBe("disclosed");
    expect(disclosed?.blocked).toBe(false);

    // Verified with passing check command -> verified, not blocked
    const verified = evaluateAskCompletionGuard("已修复完成，测试全部通过。", [
      { name: "run_on_device", args: { action: "shell", command: "sed -i 's/a/b/g' app.ts" }, status: "executed", result: { exit_code: 0 } },
      { name: "run_on_device", args: { action: "shell", command: "npm test" }, status: "executed", result: { exit_code: 0 } },
    ]);
    expect(verified?.outcome).toBe("verified");
    expect(verified?.blocked).toBe(false);
  });

  it("checks autoPublishEnabled toggle cleanly", () => {
    expect(autoPublishEnabled({ proactiveSettings: null })).toBe(true);
    expect(autoPublishEnabled({ proactiveSettings: {} })).toBe(true);
    expect(autoPublishEnabled({ proactiveSettings: { auto_publish_skills: false } })).toBe(false);
  });

  it("forbids session-level pg_try_advisory_lock / pg_advisory_unlock on pooled connections", () => {
    const srcDir = join(import.meta.dirname, "../src");
    const bad: string[] = [];
    for (const file of walkTs(srcDir)) {
      const content = readFileSync(file, "utf8");
      if (/pg_try_advisory_lock\(|pg_advisory_unlock\(|(?<!xact_)pg_advisory_lock\(/.test(content)) {
        bad.push(file);
      }
    }
    expect(bad).toEqual([]);
  });

  it("compacts oversized toolCall outputs and events before storing in ask_conversations", () => {
    const bigEvents = Array.from({ length: 500 }, (_, i) => ({
      kind: "tool_result",
      index: i,
      text: "x".repeat(8000),
    }));
    const compacted = compactToolCallForStorage({
      name: "run_on_device",
      result: {
        stdout: "a".repeat(100_000),
        stderr: "b".repeat(100_000),
        events: bigEvents,
      },
    });
    const res = compacted.result as { stdout: string; stderr: string; events: { index: number; text: string }[] };
    expect(res.stdout.length).toBeLessThanOrEqual(40_000);
    expect(res.stderr.length).toBeLessThanOrEqual(40_000);
    expect(res.events.length).toBe(200);
    expect(res.events[0]!.index).toBe(300);
    expect(res.events[0]!.text.length).toBeLessThanOrEqual(4020);
  });
});
