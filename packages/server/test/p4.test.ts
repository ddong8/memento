// P4 integration & unit tests: Mind Resonance, Ask prompt/timeline/context, Ask conversations CRUD/ETag/handoff/ensure-by-session,
// followups, runs & capabilities.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { classifyContinuation } from "../src/services/ask-prompt";
import {
  cleanGuardrailOutput,
  detectScenario,
  extractLiveCorrectionRules,
  validateShellCommandAgainstIronRules,
} from "../src/services/mind-resonance-service";
import { termsFor } from "../src/services/guidance-service";
import { buildAiContextStats, isContextOverflowError, trimAiTurns } from "../src/services/orchestrator-context";
import { mergeSession, messagesToTurns } from "../src/services/session-timeline";
import { addUser, setupApp, TEST_DB } from "./helpers";

describe("P4 pure unit checks", () => {
  it("detects mind resonance scenarios, live corrections, guardrail cleanup & iron-rule command checks", () => {
    const scen = detectScenario(termsFor("部署 k8s pod 流水线"), "部署 k8s pod 流水线");
    expect(scen.id).toBe("devops_release");

    const rules = extractLiveCorrectionRules("以后不要用加粗符号，为什么报错？\n回答时必须用中文");
    expect(rules.some((r) => r.includes("以后不要用加粗符号"))).toBe(true);
    expect(rules.some((r) => r.includes("回答时必须用中文"))).toBe(true);
    expect(rules.some((r) => r.includes("为什么"))).toBe(false);

    expect(cleanGuardrailOutput("这里**加粗**和```\n**保留**\n```结尾")).toBe("这里加粗和```\n**保留**\n```结尾");

    const [okDb] = validateShellCommandAgainstIronRules("DROP TABLE users;");
    expect(okDb).toBe(false);
    const [okOs] = validateShellCommandAgainstIronRules("systemctl restart nginx", "my-Mac-mini");
    expect(okOs).toBe(false);
    const [okSafe] = validateShellCommandAgainstIronRules("git status", "my-Mac-mini");
    expect(okSafe).toBe(true);
  });

  it("classifies continuations, folds/merges session timelines and checks context overflow", () => {
    expect(classifyContinuation("继续", [{ role: "user", content: "hi" }])).toBe("continue");
    expect(classifyContinuation("第一个再展开下", [{ role: "user", content: "hi" }])).toBe("followup");
    expect(classifyContinuation("帮我查一下 memento 昨天的提交", [{ role: "user", content: "hi" }])).toBe("none");

    const turns = messagesToTurns(
      [
        { lineNumber: 1, role: "user", messageType: "text", content: "你好", metadata: {}, timestamp: "2026-11-27T01:00:00Z" },
        { lineNumber: 2, role: "tool", messageType: "tool_call", content: "[Bash]", metadata: { tool_name: "Bash", tool_input: "ls" }, timestamp: "2026-11-27T01:00:01Z" },
        { lineNumber: 3, role: "tool", messageType: "tool_result", content: "file.txt", metadata: {}, timestamp: "2026-11-27T01:00:02Z" },
        { lineNumber: 4, role: "assistant", messageType: "PLANNER_RESPONSE", content: "已查看目录", metadata: { thinking: "先列出目录看看文件" }, timestamp: "2026-11-27T01:00:03Z" },
      ],
      "antigravity",
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]!.thinking).toBe("先列出目录看看文件");
    expect(turns[1]!.toolCalls?.length).toBe(1);
    const tcResult = (turns[1]!.toolCalls![0] as { result?: { events?: unknown[] } }).result;
    expect(tcResult?.events?.length).toBe(1);

    const { turns: merged, changed } = mergeSession(turns, [
      ...turns,
      { role: "user", content: "下一步", created_at: "2026-11-27T01:05:00Z", line_number: 5 },
    ]);
    expect(changed).toBe(true);
    expect(merged).toHaveLength(3);

    expect(isContextOverflowError(new Error("HTTP 400: maximum context length exceeded"))).toBe(true);
    expect(isContextOverflowError(new Error("network reset"))).toBe(false);

    const trimmed = trimAiTurns([
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
    ]);
    expect(trimmed).toHaveLength(2);
    const stats = buildAiContextStats("conv-1", [{ role: "user", content: "hello" }]);
    expect(stats.message_count).toBe(1);
    expect(stats.status).toBe("normal");
  });
});

describe.skipIf(!TEST_DB)("P4 end-to-end Ask routes", () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let ownerAuth: Record<string, string>;

  beforeAll(async () => {
    ctx = await setupApp();
    const owner = await addUser(ctx.db, { email: "p4-owner@example.com", role: "owner" });
    const tok = await createAccessToken(owner.id, owner.role, ctx.settings.secretKey, ctx.settings.accessTokenExpireMinutes);
    ownerAuth = { authorization: `Bearer ${tok}` };
  });

  afterAll(async () => {
    await ctx?.sql.end();
  });

  it("handles warmup, capabilities, runs, followups, ensure-by-session, ETag 304, patch, handoff & delete", async () => {
    const warm = await ctx.app.request("/api/ask/warmup", { method: "POST", headers: ownerAuth });
    expect(warm.status).toBe(200);
    expect(((await warm.json()) as { warmed: boolean }).warmed).toBe(true);

    const caps = await ctx.app.request("/api/ask/capabilities?tool=claude", { headers: ownerAuth });
    expect(caps.status).toBe(200);
    const capsData = (await caps.json()) as { tool: string; models: unknown[] };
    expect(capsData.tool).toBe("claude");
    expect(capsData.models.length).toBeGreaterThan(5);

    const aliasCaps = await ctx.app.request("/api/agent/capabilities?tool=codex", { headers: ownerAuth });
    expect(aliasCaps.status).toBe(200);
    expect(((await aliasCaps.json()) as { tool: string }).tool).toBe("codex");

    const runs = await ctx.app.request("/api/ask/runs", { headers: ownerAuth });
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual([]);

    const recent = await ctx.app.request("/api/ask/conversations/recent-active", { headers: ownerAuth });
    expect(recent.status).toBe(200);
    expect(await recent.json()).toEqual({ id: null, active_run: false });

    // ensure-by-session idempotency (pg_advisory_xact_lock)
    const s1 = await ctx.app.request("/api/ask/conversations/ensure-by-session", {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ session_id: "sess-p4-abc", execution_mode: "claude", cwd: "/Users/test/memento" }),
    });
    expect(s1.status).toBe(200);
    const c1 = (await s1.json()) as { id: string; session_id: string };
    expect(c1.session_id).toBe("sess-p4-abc");

    const s2 = await ctx.app.request("/api/ask/conversations/ensure-by-session", {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ session_id: "sess-p4-abc", execution_mode: "claude" }),
    });
    expect(((await s2.json()) as { id: string }).id).toBe(c1.id);

    // list conversations
    const list = await ctx.app.request("/api/ask/conversations", { headers: ownerAuth });
    expect(list.status).toBe(200);
    const listItems = (await list.json()) as { id: string }[];
    expect(listItems.some((x) => x.id === c1.id)).toBe(true);

    // detail + ETag 304
    const det = await ctx.app.request(`/api/ask/conversations/${c1.id}`, { headers: ownerAuth });
    expect(det.status).toBe(200);
    const etag = det.headers.get("etag");
    expect(etag).toBeTruthy();

    const det304 = await ctx.app.request(`/api/ask/conversations/${c1.id}`, {
      headers: { ...ownerAuth, "if-none-match": etag! },
    });
    expect(det304.status).toBe(304);

    // patch title & pin
    const patch = await ctx.app.request(`/api/ask/conversations/${c1.id}`, {
      method: "PATCH",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ title: "P4测试对话", pinned: true }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { ok: boolean; config: { pinned: boolean } }).config.pinned).toBe(true);

    // followups queue/peek/take
    const fq = await ctx.app.request(`/api/ask/conversations/${c1.id}/followups`, {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ text: "顺便跑一下单测" }),
    });
    expect(((await fq.json()) as { queued: boolean }).queued).toBe(true);
    const fl = await ctx.app.request(`/api/ask/conversations/${c1.id}/followups?take=true`, { headers: ownerAuth });
    expect(((await fl.json()) as { items: { text: string }[] }).items[0]?.text).toBe("顺便跑一下单测");

    // handoff to codex
    const ho = await ctx.app.request(`/api/ask/conversations/${c1.id}/handoff`, {
      method: "POST",
      headers: { ...ownerAuth, "content-type": "application/json" },
      body: JSON.stringify({ target_execution_mode: "codex", instruction: "继续收尾" }),
    });
    expect(ho.status).toBe(200);
    const hoData = (await ho.json()) as { conversation: { id: string; execution_mode: string }; handoff_prompt: string };
    expect(hoData.conversation.execution_mode).toBe("codex");
    expect(hoData.handoff_prompt).toContain("继续收尾");

    // delete conversations
    const del1 = await ctx.app.request(`/api/ask/conversations/${c1.id}`, { method: "DELETE", headers: ownerAuth });
    expect(del1.status).toBe(200);
    const del2 = await ctx.app.request(`/api/ask/conversations/${hoData.conversation.id}`, { method: "DELETE", headers: ownerAuth });
    expect(del2.status).toBe(200);
  });
});
