// Tests for P1 batch 2: tokenize, notify, sse, llm, daily, life, proactive, data-io export/import.
import { unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { conversationMessages, dailySummaries, documents, machines, tools } from "../src/db/pulled/schema";
import { splitThinking } from "../src/services/ai-provider";
import { maskPushUrl, parsePushUrl, sanitizeLiveActivityStep } from "../src/services/notify";
import { eveningSummaryText } from "../src/services/pulse";
import { publishEvent } from "../src/services/sse";
import { queryTerms, tokenizeForIndex, tokenizeForQuery } from "../src/services/tokenize";
import { addUser, json, setupApp, TEST_DB } from "./helpers";

describe("P1 batch 2 pure helpers", () => {
  it("tokenizes Chinese + English identically for index and query", () => {
    const idx = tokenizeForIndex("给 memento 搭建 Docker/PVC 自动备份");
    expect(idx).toContain("memento");
    expect(idx).toContain("docker");
    expect(idx).toContain("pvc");
    expect(idx).toContain("备份");
    expect(queryTerms("如何给 memento 的 Docker 配置备份")).not.toContain("如何");
    expect(tokenizeForQuery("Docker/PVC 备份")).toContain("&");
  });

  it("parses Bark/ntfy URLs, sanitizes Live Activity non-terminal steps, splits thinking", () => {
    expect(parsePushUrl("https://api.day.app/MyKey123/extra")).toEqual(["bark", "https://api.day.app", "MyKey123"]);
    expect(maskPushUrl("https://api.day.app/MyKey123")).toBe("https://api.day.app/MyKe…");
    expect(parsePushUrl("http://api.day.app/MyKey123")).toBeNull();
    expect(parsePushUrl("https://ntfy.sh/memento-topic")).toEqual(["ntfy", "https://ntfy.sh/memento-topic", "memento-topic"]);

    // R-ISLAND-CLEANUP: non-terminal steps must never contain 完成 / 已结束 / 已停止
    expect(sanitizeLiveActivityStep("正在完成任务构建", "running", "update")).toBe("正在就绪任务构建");
    expect(sanitizeLiveActivityStep("已完成", "done", "end")).toBe("已完成");

    expect(splitThinking("<think>step 1</think>final answer")).toEqual(["step 1", "final answer"]);
    expect(eveningSummaryText({ chats: 0, memories: 0, corrections: 0, repeats: 0, todos_done: 0, todos_open: 2 })).toBeNull();
    expect(eveningSummaryText({ chats: 2, memories: 1, corrections: 0, repeats: 0, todos_done: 1, todos_open: 0 })).toContain("今天在 2 个会话里工作");
  });
});

describe.skipIf(!TEST_DB)("P1 batch 2 routes (against Postgres)", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it("notify, llm, proactive & SSE stream", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const u = await addUser(db, { role: "owner" });
    const tok = await createAccessToken(u.id, u.role, settings.secretKey, 60, settings.algorithm);
    const auth = { authorization: `Bearer ${tok}` };

    // Notify settings + device token + feed
    const ns = await app.request("/api/notify/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ bark_url: "https://api.day.app/TestKey999", notify_risky: false }),
    });
    expect(ns.status).toBe(200);
    expect(await ns.json()).toMatchObject({ bark_configured: true, bark_masked: "https://api.day.app/Test…", notify_risky: false });

    const dt = await app.request("/api/notify/device-token", json({ token: "ExponentPushToken[abc]" }, auth));
    expect(dt.status).toBe(200);
    expect(await dt.json()).toMatchObject({ registered: true, device_tokens_count: 1 });

    // LLM settings (sealed in DB, masked in response) + agent settings
    const llmPut = await app.request("/api/profile/llm", {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ custom_enabled: true, base_url: "https://api.openai.com/v1/", api_key: "sk-1234567890abcd", model: "gpt-4o" }),
    });
    expect(llmPut.status).toBe(200);
    expect(await llmPut.json()).toMatchObject({ has_api_key: true, api_key_masked: "sk-1****abcd", base_url: "https://api.openai.com/v1" });

    const agentPut = await app.request("/api/profile/llm/agent", {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ claude_memento_client: false }),
    });
    expect(await agentPut.json()).toEqual({ claude_memento_client: false });

    // Proactive settings + evening reflection
    const proPut = await app.request("/api/proactive/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ morning_brief_time: "09:00", enabled: true }),
    });
    expect(proPut.status).toBe(200);
    expect(((await proPut.json()) as { settings: { morning_brief_time: string } }).settings.morning_brief_time).toBe("09:00");

    const refl = await app.request("/api/proactive/test-evening-reflection", { method: "POST", headers: auth });
    expect(await refl.json()).toMatchObject({ status: "empty" });

    // SSE stream yields keepalive and published event
    const ac = new AbortController();
    const sseRes = await app.request(`/api/events/stream?token=${encodeURIComponent(tok)}`, { signal: ac.signal });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    const reader = sseRes.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: keepalive");
    publishEvent("ping_test", { ok: true }, u.id);
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain("event: ping_test");
    ac.abort();
    await reader.cancel();
  });

  it("daily, life rhythm & data export/import round-trip", async () => {
    const { app, sql, db, settings } = await setupApp();
    cleanups.push(() => sql.end());

    const u = await addUser(db, { role: "viewer" });
    const tok = await createAccessToken(u.id, u.role, settings.secretKey, 60, settings.algorithm);
    const auth = { authorization: `Bearer ${tok}` };

    await db.insert(tools).values({ id: "claude_code", displayName: "Claude Code", totalFiles: 1, totalSizeBytes: 100 });
    const mId = crypto.randomUUID();
    await db.insert(machines).values({ id: mId, name: "mac-mini", collectorTokenHash: "h-mac", userId: u.id });
    const dId = crypto.randomUUID();
    await db.insert(documents).values({
      id: dId, toolId: "claude_code", machineId: mId, relativePath: "conv/1.jsonl", category: "conversation",
      contentType: "jsonl", title: "TS 迁移测试", content: "测试中文全文检索导出导入", contentHash: "h1",
      fileSizeBytes: 42, metadata: {}, visibility: "private", needsReview: false,
      embeddingStatus: "done", embeddingAttempts: 0, knowledgeStatus: "done", knowledgeAttempts: 0,
    });
    await db.insert(conversationMessages).values([
      { documentId: dId, lineNumber: 1, role: "user", content: "帮我测试日报接口", metadata: {}, timestamp: "2026-11-27 04:00:00+00" },
      { documentId: dId, lineNumber: 2, role: "assistant", content: "好的，已完成测试", metadata: {}, timestamp: "2026-11-27 04:05:00+00" },
    ]);
    await db.insert(dailySummaries).values({
      id: crypto.randomUUID(), userId: u.id, summaryDate: "2026-11-27", toolId: null,
      title: "AI 日报 - 2026-11-27", summary: "今日完成迁移",
    });

    // Daily endpoints
    const dates = (await (await app.request("/api/daily?days=30&tz_offset=-480", { headers: auth })).json()) as { date: string; message_count: number }[];
    expect(dates).toMatchObject([{ date: "2026-11-27", message_count: 2 }]);

    const dayDetail = (await (await app.request("/api/daily/2026-11-27?tz_offset=-480", { headers: auth })).json()) as { total_messages: number; summaries: { title: string }[] };
    expect(dayDetail.total_messages).toBe(2);
    expect(dayDetail.summaries).toHaveLength(1);

    const dayMsgs = (await (await app.request("/api/daily/2026-11-27/messages?tz_offset=-480", { headers: auth })).json()) as { total: number; messages: { role: string }[] };
    expect(dayMsgs.total).toBe(2);

    const daySum = await app.request("/api/daily/2026-11-27/summary", { headers: auth });
    expect(daySum.status).toBe(200);

    // Life rhythm record + get + clear
    const rec = await app.request(
      "/api/life/rhythm",
      json({ log_date: "2026-11-27", wakeup_time: "07:30", bedtime: "23:30", app_usages: [{ name: "Cursor", minutes: 120 }, { name: "抖音", minutes: 30 }] }, auth),
    );
    expect(rec.status).toBe(200);
    expect(await rec.json()).toMatchObject({ total_screen_minutes: 150, productive_minutes: 120, distraction_minutes: 30 });

    const clr = await app.request("/api/life/rhythm?log_date=2026-11-27", { method: "DELETE", headers: auth });
    expect(await clr.json()).toEqual({ status: "ok", deleted_count: 1 });

    // Data export -> ZIP inspect -> import into a fresh account + zip rejection test
    const expRes = await app.request("/api/data/export", { headers: auth });
    expect(expRes.status).toBe(200);
    expect(expRes.headers.get("content-type")).toBe("application/zip");
    expect(expRes.headers.get("x-memento-counts")).toContain("documents=1");
    const zipBuf = new Uint8Array(await expRes.arrayBuffer());
    const unzipped = unzipSync(zipBuf);
    expect(unzipped["manifest.json"]).toBeDefined();

    const u2 = await addUser(db, { role: "viewer" });
    const tok2 = await createAccessToken(u2.id, u2.role, settings.secretKey, 60, settings.algorithm);
    const form = new FormData();
    form.append("file", new File([zipBuf], "export.zip", { type: "application/zip" }));
    const impRes = await app.request("/api/data/import", { method: "POST", headers: { authorization: `Bearer ${tok2}` }, body: form });
    expect(impRes.status).toBe(200);
    const impBody = (await impRes.json()) as { ok: boolean; counts: Record<string, number> };
    expect(impBody.ok).toBe(true);
    expect(impBody.counts.documents).toBe(1);
    expect(impBody.counts.conversation_messages).toBe(2);

    // Reject unexpected member in zip
    const badZip = zipSync({ "manifest.json": new TextEncoder().encode('{"format_version":"1.0"}'), "evil.txt": new TextEncoder().encode("x") });
    const badForm = new FormData();
    badForm.append("file", new File([new Uint8Array(badZip)], "bad.zip", { type: "application/zip" }));
    const badImp = await app.request("/api/data/import", { method: "POST", headers: { authorization: `Bearer ${tok2}` }, body: badForm });
    expect(badImp.status).toBe(400);
  });
});
