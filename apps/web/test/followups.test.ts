import { describe, expect, it } from "vitest";
import { type FollowUp, nextMessage, requeue, steerableTaskId } from "../src/lib/ask/followups";
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
      { id: "1", text: "先看 README", at: 1000, status: "queued" },
      { id: "2", text: "已经送到的", at: 2000, status: "sent" },
      { id: "3", text: " 再跑测试 ", at: 3000, status: "queued", images: ["data:image/png;base64,x"] },
    ];
    expect(nextMessage(items, [])).toEqual({ text: "先看 README\n\n再跑测试", images: ["data:image/png;base64,x"] });
    expect(nextMessage([], [])).toEqual({ text: "", images: [] });
  });

  it("merges what the server kept with this page's own, by time, each text once", () => {
    const items: FollowUp[] = [
      { id: "1", text: "页面上排队的", at: 5_000, status: "queued" },
      // kept by the server: it comes back from there, not from the page
      { id: "2", text: "设备说来不及", at: 2_000, status: "queued", held: true },
    ];
    const held = [
      { text: "设备说来不及", at: 2 },
      { text: "关页面前发的", at: 1 },
      { text: "页面上排队的", at: 6 },
    ];
    expect(nextMessage(items, held).text).toBe("关页面前发的\n\n设备说来不及\n\n页面上排队的");
  });

  it("puts a follow-up the agent could not take back into the queue, once", () => {
    const items: FollowUp[] = [
      { id: "1", text: "补一句", at: 1, status: "sent" },
      { id: "2", text: "补一句", at: 2, status: "sent" },
    ];
    const once = requeue(items, "补一句");
    expect(once.map((f) => f.status)).toEqual(["queued", "sent"]);
    expect(once[0].held).toBe(true);
    expect(requeue(once, "补一句").map((f) => f.status)).toEqual(["queued", "queued"]);
    expect(requeue(items, "别的")).toBe(items);
  });
});
