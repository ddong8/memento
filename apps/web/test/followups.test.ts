import { describe, expect, it } from "vitest";
import { type FollowUp, queuedMessage, requeue, steerableTaskId } from "../src/lib/ask/followups";
import type { Turn } from "../src/lib/ask/turns";

const agentCall = (task_id: string, status: string, binary = "claude") => ({
  name: "run_on_device",
  args: { action: "agent", binary },
  result: { task_id, status, action: "agent" },
});

describe("follow-ups while a reply runs", () => {
  it("steers into the latest running agent task of the last reply", () => {
    const turns: Turn[] = [
      { role: "user", content: "改一下" },
      { role: "assistant", content: "", toolCalls: [agentCall("t1", "succeeded"), agentCall("t2", "running", "codex")] },
    ];
    expect(steerableTaskId(turns)).toBe("t2");
  });

  it("finds nothing to steer: no task yet, a finished one, a shell command, or an older reply", () => {
    expect(steerableTaskId([{ role: "assistant", content: "", toolCalls: [] }])).toBeNull();
    expect(steerableTaskId([{ role: "assistant", content: "", toolCalls: [agentCall("t1", "failed")] }])).toBeNull();
    const shell = { name: "run_on_device", args: { action: "shell", command: "ls" }, result: { task_id: "s1", status: "running", action: "shell" } };
    expect(steerableTaskId([{ role: "assistant", content: "", toolCalls: [shell] }])).toBeNull();
    expect(steerableTaskId([{ role: "assistant", content: "", toolCalls: [agentCall("t1", "running")] }, { role: "user", content: "x" }])).toBeNull();
  });

  it("steers a task that is still queued on the device", () => {
    expect(steerableTaskId([{ role: "assistant", content: "", toolCalls: [agentCall("t1", "queued")] }])).toBe("t1");
  });

  it("sends the queued ones as one message in typed order, skipping delivered ones", () => {
    const items: FollowUp[] = [
      { id: "1", text: "先看 README", status: "queued" },
      { id: "2", text: "已经送到的", status: "sent" },
      { id: "3", text: " 再跑测试 ", status: "queued" },
    ];
    expect(queuedMessage(items)).toBe("先看 README\n\n再跑测试");
    expect(queuedMessage([])).toBe("");
  });

  it("puts a follow-up the agent could not take back into the queue, once", () => {
    const items: FollowUp[] = [
      { id: "1", text: "补一句", status: "sent" },
      { id: "2", text: "补一句", status: "sent" },
    ];
    const once = requeue(items, "补一句");
    expect(once.map((f) => f.status)).toEqual(["queued", "sent"]);
    expect(requeue(once, "补一句").map((f) => f.status)).toEqual(["queued", "queued"]);
    expect(requeue(items, "别的")).toBe(items);
  });
});
