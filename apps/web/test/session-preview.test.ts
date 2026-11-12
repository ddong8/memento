import { describe, expect, it, vi } from "vitest";

import { fetchLatestSessionMessages, sessionMessagesToTurns, type SessionMessage } from "@/lib/ask/sessions";

const page = (total: number, offset: number, limit: number) => ({
  total,
  messages: Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
    role: "user",
    content: `m${offset + i}`,
  })),
});

describe("fetchLatestSessionMessages", () => {
  it("takes a short session in one request", async () => {
    const get = vi.fn(async (_id: string, offset: number, limit: number) => page(40, offset, limit));
    const msgs = await fetchLatestSessionMessages(get, "doc");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("doc", 0, 100);
    expect(msgs).toHaveLength(40);
  });

  it("takes a long session's last messages, not its opening", async () => {
    const get = vi.fn(async (_id: string, offset: number, limit: number) => page(1021, offset, limit));
    const msgs = await fetchLatestSessionMessages(get, "doc");
    expect(get).toHaveBeenLastCalledWith("doc", 921, 100);
    expect(msgs).toHaveLength(100);
    expect(msgs[0].content).toBe("m921");
    expect(msgs[99].content).toBe("m1020");
  });

  it("asks once more only past the limit", async () => {
    const get = vi.fn(async (_id: string, offset: number, limit: number) => page(100, offset, limit));
    await fetchLatestSessionMessages(get, "doc");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("is empty when the endpoint has nothing", async () => {
    expect(await fetchLatestSessionMessages(async () => null, "doc")).toEqual([]);
  });
});

describe("sessionMessagesToTurns", () => {
  it("puts tool calls and their output on the assistant turn before them", () => {
    const msgs: SessionMessage[] = [
      { role: "user", content: "check git", timestamp: "t1" },
      { role: "assistant", content: "Looking.", timestamp: "t2" },
      { role: "tool", content: "", raw_type: "tool_call", tool_name: "Bash", tool_input: "git status", timestamp: "t3" },
      { role: "tool", content: "clean", timestamp: "t4" },
      { role: "assistant", content: "All clean.", timestamp: "t5" },
    ];
    const turns = sessionMessagesToTurns(msgs);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant"]);
    expect(turns[1].started_at).toBe("t1");
    expect(turns[1].created_at).toBe("t4");
    expect(turns[1].toolCalls).toEqual([
      { name: "Bash", args: { command: "git status" }, result: { stdout: "clean", status: "succeeded", exit_code: 0 } },
    ]);
    expect(turns[2].content).toBe("All clean.");
  });

  it("starts an assistant turn for tool output cut from its call (the latest page can begin mid-turn)", () => {
    const turns = sessionMessagesToTurns([
      { role: "tool", content: "output of a call on the page before", timestamp: "t1" },
      { role: "assistant", content: "Done.", timestamp: "t2" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "assistant", content: "", created_at: "t1" });
    expect(turns[0].toolCalls).toEqual([
      { name: "tool", args: {}, result: { stdout: "output of a call on the page before", status: "succeeded", exit_code: 0 } },
    ]);
  });

  it("reads legacy [Tool:] and [Result] text", () => {
    const turns = sessionMessagesToTurns([
      { role: "assistant", content: 'Running it.\n[Tool: Bash]\n{"command":"ls -la"}' },
      { role: "user", content: "[Result] a.txt" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe("Running it.");
    expect(turns[0].toolCalls).toEqual([
      { name: "Bash", args: { command: "ls -la" }, result: { stdout: "a.txt", status: "succeeded", exit_code: 0 } },
    ]);
  });

  it("keeps tool and meta noise out of the user's words", () => {
    const turns = sessionMessagesToTurns([
      { role: "user", content: '{"tool_use_id":"x"}' },
      { role: "user", content: "[Tool: Bash] leftover" },
      { role: "user", content: "real question" },
    ]);
    expect(turns).toEqual([{ role: "user", content: "real question", images: undefined, created_at: undefined }]);
  });

  it("takes null fields from the endpoint as absent", () => {
    const turns = sessionMessagesToTurns([
      { role: null, content: null, created_at: "t0" },
      { role: "assistant", content: "hi", thinking: null, tool_name: null, tool_input: null, timestamp: null, created_at: "t1" },
    ]);
    expect(turns[0]).toMatchObject({ role: "user", content: "", created_at: "t0" });
    expect(turns[1]).toMatchObject({ role: "assistant", content: "hi", created_at: "t1" });
    expect(turns[1].toolCalls).toBeUndefined();
  });
});
