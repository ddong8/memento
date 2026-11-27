// P5 tests: learning routes, health overview, guard, pitfalls, eval/outcome math & 21-job scheduler.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { correctionTopics, machines } from "../src/db/pulled/schema";
import { parseEntries, ruleCovered, uncoveredRules } from "../src/services/business-blueprint";
import { addProfileLine, cleanStatement, profileCovers } from "../src/services/correction-service";
import { scoreRanks } from "../src/services/eval-service";
import { assess } from "../src/services/health-service";
import { ruleMetrics } from "../src/services/learning-eval-service";
import { replaceProfileLine } from "../src/services/memory-lifecycle";
import { isHarnessPitfall, isMachinePitfall } from "../src/services/retrospective-service";
import { SCHEDULED_JOBS } from "../src/services/scheduler";
import { addUser, json, setupApp, TEST_DB } from "./helpers";

describe.skipIf(!TEST_DB)("P5 learning, health & 21 scheduled jobs", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let userId: string;
  let token: string;
  let collectorToken: string;
  let deviceHash: string;

  beforeAll(async () => {
    ctx = await setupApp();
    collectorToken = `col-${randomUUID()}`;
    deviceHash = `dev-${randomUUID().slice(0, 8)}`;
    const user = await addUser(ctx.db, {
      email: "p5@example.com",
      name: "P5 Tester",
      role: "owner",
      collectorToken,
      proactiveSettings: {},
    });
    userId = user.id;
    await ctx.db.insert(machines).values({
      id: randomUUID(),
      userId,
      name: "mac-p5 (Darwin)",
      collectorTokenHash: deviceHash,
    });
    token = await createAccessToken(userId, "owner", ctx.settings.secretKey, 60);
  });

  afterAll(async () => {
    await ctx?.sql.end();
  });

  it("registers all 21 Celery-equivalent cron jobs with Asia/Shanghai schedules", () => {
    expect(SCHEDULED_JOBS.length).toBe(21);
    const names = new Set(SCHEDULED_JOBS.map((j) => j.name));
    for (const expected of [
      "daily-digest",
      "daily-digest-late",
      "nightly-dreaming",
      "embedding-retry",
      "merge-staged-deltas",
      "message-audit",
      "knowledge-retry",
      "weekly-db-backup",
      "title-backfill",
      "health-check",
      "audit-retention",
      "close-stale-tasks",
      "learn-corrections",
      "learn-todos",
      "review-sessions",
      "memory-lifecycle",
      "memory-vectors",
      "remind-todos",
      "tsvector-backfill",
      "evaluate-retrieval",
      "evaluate-learning",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("handles learning corrections, check, reviews, evals, outcomes, pitfalls, guard & health overview", async () => {
    const auth = { authorization: `Bearer ${token}` };

    const topicId = randomUUID();
    await ctx.db.insert(correctionTopics).values({
      id: topicId,
      userId,
      statement: "始终用中文回复",
      category: "communication",
      status: "pending",
      scope: "global",
      times: 2,
    });

    const listResp = await ctx.app.request("/api/learning/corrections", { headers: auth });
    expect(listResp.status).toBe(200);
    const listBody = (await listResp.json()) as { pending: { id: string; statement: string }[]; stats: { pending: number } };
    expect(listBody.pending.length).toBe(1);
    expect(listBody.stats.pending).toBe(1);

    const accResp = await ctx.app.request(`/api/learning/corrections/${topicId}/accept`, json({ statement: "始终用中文回复" }, auth));
    expect(accResp.status).toBe(200);
    const accBody = (await accResp.json()) as { topic: { status: string } };
    expect(accBody.topic.status).toBe("accepted");

    const checkResp = await ctx.app.request("/api/learning/check?format=markdown&query=deploy", { headers: auth });
    expect(checkResp.status).toBe(200);
    const checkBody = (await checkResp.json()) as { markdown: string };
    expect(typeof checkBody.markdown).toBe("string");

    const pitResp = await ctx.app.request(
      "/api/learning/pitfalls",
      json(
        {
          title: "macOS 无 timeout 命令",
          symptom: "command not found: timeout",
          cause: "macOS 默认不含 GNU coreutils",
          fix: "直接用 python 或 gtimeout",
          project: "memento",
        },
        auth,
      ),
    );
    expect(pitResp.status).toBe(200);
    const pitBody = (await pitResp.json()) as { saved: boolean; id?: string };
    expect(pitBody.saved).toBe(true);
    expect(pitBody.id).toBeTruthy();

    const guardEvResp = await ctx.app.request(
      "/api/learning/guard/events",
      json(
        { events: [{ tool: "claude_code", outcome: "verified", blocked: false, followup: false, deploy: true, claim: "已部署", check: "curl 200" }] },
        { "x-collector-token": collectorToken, "x-device-id": deviceHash },
      ),
    );
    expect(guardEvResp.status).toBe(200);
    expect(((await guardEvResp.json()) as { saved: number }).saved).toBe(1);

    const guardStResp = await ctx.app.request(
      "/api/learning/guard/status",
      json({ results: { claude_code: "ok", codex: "ok" } }, { "x-collector-token": collectorToken, "x-device-id": deviceHash }),
    );
    expect(guardStResp.status).toBe(200);

    const guardResp = await ctx.app.request("/api/learning/guard", { headers: auth });
    expect(guardResp.status).toBe(200);
    const guardBody = (await guardResp.json()) as { enabled: boolean; stats: { claims: number } };
    expect(guardBody.enabled).toBe(true);
    expect(guardBody.stats.claims).toBe(1);

    const revResp = await ctx.app.request("/api/learning/reviews", { headers: auth });
    expect(revResp.status).toBe(200);

    const evalResp = await ctx.app.request("/api/learning/evals", { headers: auth });
    expect(evalResp.status).toBe(200);

    const outResp = await ctx.app.request("/api/learning/outcomes", { headers: auth });
    expect(outResp.status).toBe(200);

    const healthResp = await ctx.app.request("/api/health/overview", { headers: auth });
    expect(healthResp.status).toBe(200);
    const healthBody = (await healthResp.json()) as { level: string; issues: unknown[]; evolution: Record<string, unknown> };
    expect(["ok", "warn", "error"]).toContain(healthBody.level);
    expect(Array.isArray(healthBody.issues)).toBe(true);
    expect(healthBody.evolution).toBeTruthy();
  });

  it("verifies pure logic helpers (profile lines, pitfall filters, blueprint parsing, eval scoring, health assess)", () => {
    expect(cleanStatement("- 1. 始终用中文回复 <!-- x -->")).toBe("始终用中文回复  x");
    const updated = addProfileLine("### 沟通\n- 直接给结论", "沟通", "始终用中文回复");
    expect(profileCovers(updated, "沟通", "始终用中文回复")).toBe(true);
    expect(replaceProfileLine(updated, "直接给结论", "先给结论")).toContain("- 先给结论");

    expect(isHarnessPitfall({ kind: "slip", title: "x", symptom: "y", fix: "z" })).toBe(true);
    expect(isHarnessPitfall({ kind: "env", title: "缺少 ruff", symptom: "command not found", fix: "uv run --with ruff" })).toBe(false);
    expect(isMachinePitfall("【memento】macOS 无 timeout。现象：command not found；原因：无 coreutils；解决：不用 timeout")).toBe(true);

    const bp = "# Business Blueprint: demo\n## 3. 业务规则\n### R-ONE 后台任务跟踪到结束\n- 来源: 用户 2026-10-01「后台任务要跟踪到结束，不要提前结束」\n";
    const entries = parseEntries(bp);
    expect(entries.length).toBe(1);
    expect(ruleCovered("后台任务要跟踪到结束，不要提前结束", entries)).toBe(true);
    expect(uncoveredRules(bp, ["- 后台任务要跟踪到结束；新建规则未覆盖条款"])).toEqual(["新建规则未覆盖条款"]);

    expect(scoreRanks([1, 2, null])).toEqual({ hit1: 0.3333, hit5: 0.6667, hit10: 0.6667, mrr: 0.5 });

    const rm = ruleMetrics(
      [{ topicId: "t1", statement: "用中文", status: "accepted", acceptedAt: "2026-10-01T00:00:00Z", saidAt: "2026-10-15T00:00:00Z" }],
      Date.parse("2026-10-12T00:00:00Z"),
      Date.parse("2026-10-19T00:00:00Z"),
    );
    expect(rm.week_on_accepted).toBe(1);

    const issues = assess(
      { available: true, window_hours: 24, calls: { total: 10, ok: 5, fallback: 0, failed: 5 }, by_kind: {}, models: [], reasons: [], hourly: [] },
      { available: true, window_hours: 1, calls: { total: 5, ok: 1, fallback: 0, failed: 4 }, by_kind: {}, models: [], reasons: [], hourly: [] },
      { journals: [], last_run: null },
      { published: null, draft: null, last_run: null, devices: [] },
      { embedding_failed: 25, knowledge_failed: 0 },
      Date.now(),
    );
    expect(issues[0]?.level).toBe("error");
    expect(issues.some((i) => i.area === "pipeline")).toBe(true);
  });
});
