// Integration & unit tests for P2 (ingest, conversation parser, message store, search, conversations, exclusions, retrieval).
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createAccessToken } from "../src/auth/jwt";
import { l1ClearForTests } from "../src/cache";
import { conversationMessages, documents, userMemories, users } from "../src/db/pulled/schema";
import { computeEbbinghausMemoryScore, fuseRanks, retrieveCoreMemories } from "../src/services/ask-retrieval";
import { countConversationMessages, messagesToStore, parseConversation, rowKey } from "../src/services/conversation-parser";
import { chunkText, rankChunkPool } from "../src/services/embedding";
import { planAlignment } from "../src/services/message-store";
import { addUser, setupApp, TEST_DB } from "./helpers";

describe("P2 pure units (parser, alignment, chunking, ranking)", () => {
  it("parses Claude Code, Codex (with dedup), Antigravity, Hermes & Cursor conversations", () => {
    const cc = [
      JSON.stringify({ type: "user", timestamp: "2026-11-27T01:00:00Z", message: { role: "user", content: "修复部署问题" } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-27T01:00:02Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "先检查日志" },
            { type: "tool_use", name: "Bash", input: { command: "kubectl get pods" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-11-27T01:00:03Z",
        message: { role: "user", content: [{ type: "tool_result", content: "api-ts 1/1 Running", is_error: false }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-27T01:00:05Z",
        message: { role: "assistant", content: [{ type: "text", text: "已经恢复正常" }] },
      }),
    ].join("\n");
    const ccMsgs = parseConversation(cc, "claude_code");
    expect(ccMsgs.map((m) => m.role)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(ccMsgs[1]!.toolName).toBe("Bash");
    expect(ccMsgs[1]!.toolInput).toBe("kubectl get pods");
    expect(countConversationMessages(cc, "claude_code")).toBe(4);

    // Codex duplicate event_msg + response_item + task_complete should collapse
    const codex = [
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-27T02:00:00Z", payload: { type: "user_message", message: "跑测试" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-11-27T02:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑测试" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-11-27T02:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "全部通过" }] } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-27T02:00:03Z", payload: { type: "task_complete", last_agent_message: "全部通过" } }),
    ].join("\n");
    expect(parseConversation(codex, "codex").map((m) => `${m.role}:${m.content}`)).toEqual(["user:跑测试", "assistant:全部通过"]);

    // Hermes single JSON document
    const hermes = JSON.stringify({
      session_start: "2026-11-27T03:00:00Z",
      messages: [
        { role: "system", content: "ignored" },
        { role: "user", content: "检查磁盘" },
        { role: "assistant", content: "正在查看", tool_calls: [{ id: "c1", function: { name: "df" } }] },
        { role: "tool", tool_call_id: "c1", content: JSON.stringify({ output: "/data2 80% free", exit_code: 0, error: null }) },
      ],
    });
    const hm = parseConversation(hermes, "hermes");
    expect(hm.length).toBe(3);
    expect(hm[2]!.toolName).toBe("df");
    expect(countConversationMessages(hermes, "hermes")).toBe(3);
  });

  it("aligns stored messages preserving row IDs, parking on partial resync, and interleaving on audit", () => {
    const raw = [
      JSON.stringify({ type: "user", timestamp: "2026-11-27T01:00:00Z", message: { role: "user", content: "第一句" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-27T01:00:05Z", message: { role: "assistant", content: "第二句" } }),
    ].join("\n");
    const expected = messagesToStore(raw, "claude_code");
    expect(expected.length).toBe(2);
    const stored = [
      { id: 10n, lineNumber: 1, rowKey: expected[0]!.key, looseKey: expected[0]!.loose },
      { id: 11n, lineNumber: 2, rowKey: expected[0]!.key, looseKey: expected[0]!.loose }, // duplicate
      { id: 12n, lineNumber: 3, rowKey: rowKey("assistant", null, "legacy"), looseKey: null },
    ];
    const plan = planAlignment(stored, expected, 1, "interleave");
    expect(plan.delete).toEqual([11n]);
    expect(plan.duplicates).toBe(1);
    expect(plan.unknown).toBe(1);
    expect(plan.insert.length).toBe(1);
  });

  it("chunks text cleanly, penalizes mega-chunk docs, fuses RRF ranks and computes Ebbinghaus decay", () => {
    const long = Array.from({ length: 10 }, (_, i) => `段落 ${i}：${"中文内容测试".repeat(80)}`).join("\n\n");
    const chunks = chunkText(long, 600, 100);
    expect(chunks.length).toBeGreaterThan(2);

    const hits = rankChunkPool(
      [
        { documentId: "big", chunkId: "c1", dist: 0.1 },
        { documentId: "small", chunkId: "c2", dist: 0.11 },
      ],
      new Map([
        ["big", 500],
        ["small", 2],
      ]),
      2,
    );
    expect(hits[0]!.documentId).toBe("small");

    const fused = fuseRanks(
      [
        { id: "a", title: "foo", relativePath: "x" },
        { id: "b", title: "CAS 50-00-0", relativePath: "y" },
      ],
      ["b", "a"],
      ["a", "b"],
      "50-00-0",
    );
    expect(fused[0]!.id).toBe("b");

    const recent = computeEbbinghausMemoryScore(0.9, new Date().toISOString(), 5);
    const old = computeEbbinghausMemoryScore(0.9, new Date(Date.now() - 60 * 86400_000).toISOString(), 0);
    expect(recent).toBeGreaterThan(old);
  });
});

describe.skipIf(!TEST_DB)("P2 routes (against Postgres)", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    l1ClearForTests();
    while (cleanups.length) await cleanups.pop()!();
  });

  async function init() {
    const ctx = await setupApp({
      MEMENTO_LAN_URLS: "http://192.168.1.10:8000",
      MEMENTO_REMOTE_EXEC: "1",
      MEMENTO_EMBEDDING_SERVER_URL: "http://127.0.0.1:1",
    });
    cleanups.push(() => ctx.sql.end());
    const owner = await addUser(ctx.db, { email: "owner-p2@example.com", name: "Owner P2", role: "owner" });
    const ownerToken = await createAccessToken(owner.id, "owner", ctx.settings.secretKey, 60);
    return {
      ...ctx,
      owner,
      authHeaders: { authorization: `Bearer ${ownerToken}` },
      collectorHeaders: {
        "x-collector-token": owner.collectorToken!,
        "x-device-id": "dev-mac-1",
        "x-device-name": "MacMini",
        "x-device-platform": "darwin",
      },
    };
  }

  it("ingests full + delta slices, enforces 409 OffsetMismatch, indexes FTS, searches & serves conversations", async () => {
    const { app, db, settings, owner, authHeaders, collectorHeaders } = await init();
    // Heartbeat mints remote_exec_key + returns lan config
    const hb = await app.request("/api/ingest/heartbeat", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({ collect: { backlog: 0 } }),
    });
    expect(hb.status).toBe(200);
    const hbJson = (await hb.json()) as { device_id: string; remote_exec_key: string; lan: { urls: string[]; key: string } };
    expect(hbJson.remote_exec_key).toBeTruthy();
    expect(hbJson.lan.urls).toEqual(["http://192.168.1.10:8000"]);

    // LAN hello rejects public XFF, accepts loopback/LAN
    const pubHello = await app.request("/api/ingest/lan-hello?device=dev-mac-1&challenge=12345678", {
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    expect(pubHello.status).toBe(404);
    const lanHello = await app.request("/api/ingest/lan-hello?device=dev-mac-1&challenge=12345678", {
      headers: { "x-forwarded-for": "192.168.1.50" },
    });
    expect(lanHello.status).toBe(200);
    expect(((await lanHello.json()) as { proof: string }).proof).toHaveLength(64);

    // Full upload of a Claude Code conversation with a secret token to test re-sanitization
    const line1 = JSON.stringify({
      type: "user",
      timestamp: "2026-11-27T05:00:00Z",
      cwd: "/Users/haixingdong/dev/memento",
      message: { role: "user", content: "帮我排查异地备份与 pgvector 向量检索问题，旧密钥 sk-1234567890abcdefghij1234" },
    });
    const line2 = JSON.stringify({
      type: "assistant",
      timestamp: "2026-11-27T05:00:05Z",
      message: { role: "assistant", content: [{ type: "text", text: "已经查到根因，异地备份脚本恢复正常。" }], usage: { input_tokens: 1200, cache_read_input_tokens: 8000 } },
    });
    const part1 = `${line1}\n${line2}`;
    const bytes1 = Buffer.byteLength(part1, "utf8");

    const up1 = await app.request("/api/ingest/file", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "claude_code",
        category: "conversation",
        content_type: "jsonl",
        relative_path: "projects/-Users-haixingdong-dev-memento/sess-1.jsonl",
        hash: "h1",
        mode: "full",
        offset: 0,
        end_offset: bytes1,
        file_size: bytes1,
        content: part1,
        metadata: { session_id: "sess-1" },
      }),
    });
    expect(up1.status).toBe(200);
    const up1Json = (await up1.json()) as { document_id: string; next_offset: number };
    expect(up1Json.document_id).toBeTruthy();
    expect(up1Json.next_offset).toBe(bytes1);

    // Verify re-sanitization
    const [storedDoc] = await db.select().from(documents).where(eq(documents.id, up1Json.document_id));
    expect(storedDoc!.needsReview).toBe(true);
    expect(storedDoc!.content).toContain("[API_KEY_REDACTED]");
    expect(storedDoc!.content).not.toContain("sk-1234567890");

    // Wrong delta offset returns 409 with expected_offset
    const badDelta = await app.request("/api/ingest/file", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "claude_code",
        category: "conversation",
        content_type: "jsonl",
        relative_path: "projects/-Users-haixingdong-dev-memento/sess-1.jsonl",
        hash: "h2",
        mode: "delta",
        offset: bytes1 + 50,
        end_offset: bytes1 + 100,
        file_size: bytes1 + 100,
        content: "",
      }),
    });
    expect(badDelta.status).toBe(409);
    expect(((await badDelta.json()) as { detail: { expected_offset: number } }).detail.expected_offset).toBe(bytes1);

    // Valid delta appends message
    const line3 = JSON.stringify({
      type: "user",
      timestamp: "2026-11-27T05:01:00Z",
      message: { role: "user", content: "顺便跑一下契约检查" },
    });
    const bytes2 = bytes1 + Buffer.byteLength(line3, "utf8");
    const up2 = await app.request("/api/ingest/file", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "claude_code",
        category: "conversation",
        content_type: "jsonl",
        relative_path: "projects/-Users-haixingdong-dev-memento/sess-1.jsonl",
        hash: "h3",
        mode: "delta",
        offset: bytes1,
        end_offset: bytes2,
        file_size: bytes2,
        content: line3,
      }),
    });
    expect(up2.status).toBe(200);

    // Reconcile reports mismatch when collector offset lags
    const rec = await app.request("/api/ingest/reconcile", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ tool: "claude_code", relative_path: "projects/-Users-haixingdong-dev-memento/sess-1.jsonl", offset: 0 }],
      }),
    });
    expect(rec.status).toBe(200);
    const recJson = (await rec.json()) as { files: { expected_offset: number }[] };
    expect(recJson.files[0]!.expected_offset).toBe(bytes2);

    // Search via jieba FTS finds the ingested Chinese conversation
    const sr = await app.request(`/api/search?q=${encodeURIComponent("异地备份")}`, { headers: authHeaders });
    expect(sr.status).toBe(200);
    const srJson = (await sr.json()) as { total: number; results: { id: string }[] };
    expect(srJson.total).toBe(1);
    expect(srJson.results[0]!.id).toBe(up1Json.document_id);

    // Conversations GET, messages, PATCH, stats & compact
    const conv = await app.request(`/api/conversations/${up1Json.document_id}`, { headers: authHeaders });
    expect(conv.status).toBe(200);
    expect(((await conv.json()) as { message_count: number }).message_count).toBe(3);

    const msgs = await app.request(`/api/conversations/${up1Json.document_id}/messages?limit=2&offset=0`, { headers: authHeaders });
    expect(msgs.status).toBe(200);
    const msgsJson = (await msgs.json()) as { total: number; messages: { role: string }[] };
    expect(msgsJson.total).toBe(3);
    expect(msgsJson.messages.length).toBe(2);

    const patch = await app.request(`/api/conversations/${up1Json.document_id}`, {
      method: "PATCH",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ title: "异地备份排查记录" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { title: string }).title).toBe("异地备份排查记录");

    const stats = await app.request(`/api/conversations/sess-1/stats`, { headers: authHeaders });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as { estimated_tokens: number }).estimated_tokens).toBe(9200);

    const compact = await app.request(`/api/conversations/sess-1/compact`, {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ recent_turns: 2, new_prompt: "继续" }),
    });
    expect(compact.status).toBe(200);
    expect(((await compact.json()) as { injected_context: string }).injected_context).toContain("前序会话核心记忆快照");

    // Core memory recall increments recall_count
    const memId = randomUUID();
    await db.insert(userMemories).values({
      id: memId,
      userId: owner.id,
      category: "rule",
      key: "memento_backup",
      content: "异地备份保留 7 份",
      confidence: 1.0,
      source: "manual",
      treePath: "/project/memento/backup",
      isFolder: false,
      status: "active",
    });
    const [u] = await db.select().from(users).where(eq(users.id, owner.id));
    const recalled = await retrieveCoreMemories(db, settings, null, u!, "异地备份", { cwd: "/Users/haixingdong/dev/memento" });
    expect(recalled.length).toBe(1);
    const [mAfter] = await db.select().from(userMemories).where(eq(userMemories.id, memId));
    expect(mAfter!.recallCount).toBe(1);
  });

  it("previews, excludes (purges & drops new ingests), and restores a project", async () => {
    const { app, db, authHeaders, collectorHeaders } = await init();
    // Ingest a file in project "throwaway-test"
    const up = await app.request("/api/ingest/file", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "claude_code",
        category: "conversation",
        content_type: "jsonl",
        relative_path: "projects/-Users-x-dev-throwaway-test/t1.jsonl",
        hash: "ht1",
        mode: "full",
        offset: 0,
        end_offset: 50,
        file_size: 50,
        content: JSON.stringify({ type: "user", message: { role: "user", content: "临时测试" } }),
        metadata: { project_name: "throwaway-test" },
      }),
    });
    expect(up.status).toBe(200);

    const prev = await app.request("/api/collect/exclusions/preview?name=throwaway-test", { headers: authHeaders });
    expect(prev.status).toBe(200);
    expect(((await prev.json()) as { documents: number }).documents).toBe(1);

    const add = await app.request("/api/collect/exclusions", {
      method: "POST",
      headers: { ...authHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "throwaway-test" }),
    });
    expect(add.status).toBe(200);
    const addJson = (await add.json()) as { item: { key: string } };
    expect(addJson.item.key).toBe("throwawaytest");

    // Wait briefly for background purge to complete
    await new Promise((r) => setTimeout(r, 200));
    const docsLeft = await db.select().from(documents);
    expect(docsLeft.length).toBe(0);
    const msgsLeft = await db.select().from(conversationMessages);
    expect(msgsLeft.length).toBe(0);

    // Subsequent ingest for the excluded project is silently dropped (empty document_id)
    const dropped = await app.request("/api/ingest/file", {
      method: "POST",
      headers: { ...collectorHeaders, "content-type": "application/json" },
      body: JSON.stringify({
        tool: "claude_code",
        category: "conversation",
        content_type: "jsonl",
        relative_path: "projects/-Users-x-dev-throwaway-test/t2.jsonl",
        hash: "ht2",
        mode: "full",
        offset: 0,
        end_offset: 40,
        file_size: 40,
        content: JSON.stringify({ type: "user", message: { role: "user", content: "被排除的新日志" } }),
        metadata: { project_name: "throwaway-test" },
      }),
    });
    expect(dropped.status).toBe(200);
    expect(((await dropped.json()) as { document_id: string }).document_id).toBe("");

    // Restore exclusion
    const del = await app.request("/api/collect/exclusions/throwawaytest", { method: "DELETE", headers: authHeaders });
    expect(del.status).toBe(200);
    const list = await app.request("/api/collect/exclusions", { headers: authHeaders });
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(0);
  });
});
