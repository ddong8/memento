import { describe, expect, it, vi } from "vitest";
import { computeBackoffWithJitter, TaskRunner, type TaskChunkMessage } from "../src/task-runner.js";
import { WsTaskClient } from "../src/ws-client.js";
import type { CollectorConfig } from "../src/config.js";

describe("Task resilience: exponential backoff with jitter & idempotent log buffer", () => {
  it("computeBackoffWithJitter scales exponentially and clamps within [500, maxMs]", () => {
    const baseMs = 1000;
    const maxMs = 10000;
    const b0 = computeBackoffWithJitter(0, { baseMs, maxMs, jitterRatio: 0.1 });
    expect(b0).toBeGreaterThanOrEqual(500);
    expect(b0).toBeLessThanOrEqual(1200);

    const b2 = computeBackoffWithJitter(2, { baseMs, maxMs, jitterRatio: 0.1 });
    // base * 2^2 = 4000 +/- 10%
    expect(b2).toBeGreaterThanOrEqual(3500);
    expect(b2).toBeLessThanOrEqual(4500);

    const bHigh = computeBackoffWithJitter(10, { baseMs, maxMs, jitterRatio: 0.1 });
    // Clamped at maxMs +/- jitter
    expect(bHigh).toBeLessThanOrEqual(maxMs);
    expect(bHigh).toBeGreaterThanOrEqual(8500);
  });

  it("TaskRunner generates monotonic sequence numbers and buffers chunks for idempotent resend", () => {
    const sentMessages: Record<string, unknown>[] = [];
    const sendFn = vi.fn((msg: Record<string, unknown>) => {
      sentMessages.push(msg);
    });

    const runner = new TaskRunner(sendFn);
    const taskId = "task-resilience-1";

    const c1 = runner.sendChunk(taskId, "stdout", "line 1\n");
    const c2 = runner.sendChunk(taskId, "stdout", "line 2\n");
    const c3 = runner.sendChunk(taskId, "stderr", "warn 1\n");

    expect(c1.seq).toBe(1);
    expect(c2.seq).toBe(2);
    expect(c3.seq).toBe(3);

    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[0]).toMatchObject({ type: "task_chunk", task_id: taskId, stream: "stdout", seq: 1 });

    // Test getBufferedChunks
    const fromSeq2 = runner.getBufferedChunks(taskId, 2);
    expect(fromSeq2).toHaveLength(2);
    expect(fromSeq2.map((c) => c.seq)).toEqual([2, 3]);

    // Test resendBufferedChunks
    sentMessages.length = 0;
    const resentCount = runner.resendBufferedChunks(taskId, 2);
    expect(resentCount).toBe(2);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toMatchObject({ seq: 2 });
    expect(sentMessages[1]).toMatchObject({ seq: 3 });

    // Clean up
    runner.clearTaskLogBuffer(taskId);
    expect(runner.getBufferedChunks(taskId)).toHaveLength(0);
  });

  it("WsTaskClient pendingOutbox deduplicates task chunks with matching task_id and seq", () => {
    const dummyConfig: CollectorConfig = {
      serverUrl: "http://localhost:8000",
      token: "test-token",
      deviceId: "dev-test-1",
      deviceName: "test-box",
    };

    const client = new WsTaskClient(dummyConfig);
    const taskId = "task-reconnect-dedup";

    // Client is disconnected, sendJson should buffer into pendingOutbox
    const chunkA1: TaskChunkMessage = { type: "task_chunk", task_id: taskId, stream: "stdout", text: "chunk 1", seq: 1 };
    const chunkA2: TaskChunkMessage = { type: "task_chunk", task_id: taskId, stream: "stdout", text: "chunk 2", seq: 2 };
    const chunkA1Duplicate: TaskChunkMessage = { type: "task_chunk", task_id: taskId, stream: "stdout", text: "chunk 1", seq: 1 };

    client.sendJson(chunkA1 as unknown as Record<string, unknown>);
    client.sendJson(chunkA2 as unknown as Record<string, unknown>);
    client.sendJson(chunkA1Duplicate as unknown as Record<string, unknown>);

    const outbox = (client as any).pendingOutbox as Record<string, unknown>[];
    expect(outbox).toHaveLength(2);
    expect(outbox.map((m) => m.seq)).toEqual([1, 2]);

    client.dispose();
  });

  it("WsTaskClient preserves strict FIFO message order when pending messages exist and new message arrives", () => {
    const dummyConfig: CollectorConfig = {
      serverUrl: "http://localhost:8000",
      token: "test-token",
      deviceId: "dev-test-fifo",
      deviceName: "test-box",
    };

    const client = new WsTaskClient(dummyConfig);
    const taskId = "task-fifo-test";

    // 1. Buffer messages while disconnected
    client.sendJson({ type: "task_chunk", task_id: taskId, stream: "stdout", text: "step 1", seq: 1 });
    client.sendJson({ type: "task_chunk", task_id: taskId, stream: "stdout", text: "step 2", seq: 2 });

    // 2. Mock a newly established WebSocket connection (readyState = 1, OPEN)
    const sentFrames: string[] = [];
    (client as any).ws = {
      readyState: 1, // WebSocket.OPEN
      send: vi.fn((data: string) => {
        sentFrames.push(data);
      }),
      close: vi.fn(),
    };

    // 3. New message arrives while pendingOutbox is not empty
    client.sendJson({ type: "task_chunk", task_id: taskId, stream: "stdout", text: "step 3", seq: 3 });

    // Verify frames sent in exact chronological order: step 1, step 2, step 3
    expect(sentFrames).toHaveLength(3);
    const parsed = sentFrames.map((f) => JSON.parse(f));
    expect(parsed[0]).toMatchObject({ seq: 1, text: "step 1" });
    expect(parsed[1]).toMatchObject({ seq: 2, text: "step 2" });
    expect(parsed[2]).toMatchObject({ seq: 3, text: "step 3" });

    // Verify outbox is now empty
    expect((client as any).pendingOutbox).toHaveLength(0);

    client.dispose();
  });
});
