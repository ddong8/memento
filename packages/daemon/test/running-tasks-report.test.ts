import { describe, expect, it, vi } from "vitest";
import { TaskRunner } from "../src/task-runner.js";
import { WsTaskClient } from "../src/ws-client.js";
import type { CollectorConfig } from "../src/config.js";

const config: CollectorConfig = {
  serverUrl: "http://localhost:8000",
  token: "test-token",
  deviceId: "dev-running-report",
  deviceName: "test-box",
  platform: "darwin",
  extraWatchDirs: [],
};

describe("what the daemon runs, reported after a (re)connect", () => {
  it("counts a task from receipt to its end, not only while its process runs", async () => {
    const runner = new TaskRunner(vi.fn());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The task still getting ready (a workspace to sync, say): no process yet
    (runner as unknown as { executeTask: () => Promise<void> }).executeTask = () => gate;
    const done = runner.execute({ id: "t-1", action: "shell", payload: {}, timeoutSeconds: 60 } as never);
    expect(runner.activeTaskIds).toEqual(["t-1"]);
    expect(runner.runningTaskIds).toEqual([]);
    release();
    await done;
    expect(runner.activeTaskIds).toEqual([]);
  });

  it("lists running tasks and ones whose result still waits to go out, with the daemon's uptime", () => {
    const client = new WsTaskClient(config);
    (client.runner as unknown as { accepted: Set<string> }).accepted.add("t-run");
    // Disconnected: this result waits in the outbox
    client.sendJson({ type: "task_finished", task_id: "t-done", status: "succeeded" });
    const frames: Record<string, unknown>[] = [];
    (client as unknown as { ws: unknown }).ws = { readyState: 1, send: (s: string) => frames.push(JSON.parse(s)), close: () => {}, removeAllListeners: () => {}, terminate: () => {} };
    client.reportRunningTasks();
    const report = frames.find((f) => f.type === "running_tasks");
    expect(report).toBeDefined();
    expect(new Set(report!.task_ids as string[])).toEqual(new Set(["t-run", "t-done"]));
    expect(typeof report!.uptime_ms).toBe("number");
    expect(report!.uptime_ms as number).toBeGreaterThan(0);
    client.dispose();
  });
});
