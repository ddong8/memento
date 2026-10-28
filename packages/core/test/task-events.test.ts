import { describe, expect, it } from "vitest";

import { formatTokenCount, mergeTaskEvent, taskRunSummary, taskToolLabel, type TaskEvent } from "../src/index.js";

describe("task events", () => {
  it("updates a tool step in place and appends the rest", () => {
    let events: TaskEvent[] = [];
    events = mergeTaskEvent(events, { kind: "tool", id: "t1", name: "Bash", detail: "ls", status: "running" });
    events = mergeTaskEvent(events, { kind: "steer", text: "顺便看 README", status: "sent" });
    events = mergeTaskEvent(events, { kind: "tool", id: "t1", status: "done", output: "README.md" });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "tool", detail: "ls", status: "done", output: "README.md" });
  });

  it("summarizes steps, cost and time", () => {
    expect(
      taskRunSummary([
        { kind: "tool", id: "a" },
        { kind: "tool", id: "b" },
        { kind: "usage", cost_usd: 0.1137, duration_ms: 124000 },
      ]),
    ).toBe("2 步 · $0.11 · 2 分 4 秒");
    expect(taskRunSummary([{ kind: "tool" }, { kind: "usage", duration_ms: 3986 }])).toBe("1 步 · 4 秒");
    expect(taskRunSummary([{ kind: "tool" }, { kind: "usage", input_tokens: 36_402_801, cost_usd: 5.78 }])).toBe("1 步 · 读取 3,640 万 token · $5.78");
  });

  it("says how much of what a run read came from the cache", () => {
    expect(
      taskRunSummary([{ kind: "tool" }, { kind: "usage", input_tokens: 36_402_801, cache_read_tokens: 35_600_000, cache_write_tokens: 790_000, cost_usd: 5.78 }]),
    ).toBe("1 步 · 读取 3,640 万 token（缓存命中 97%） · $5.78");
    // Rounded down, so a run with any miss never shows 100%
    expect(taskRunSummary([{ kind: "usage", input_tokens: 1_000_000, cache_read_tokens: 999_900 }])).toBe("0 步 · 读取 100 万 token（缓存命中 99%）");
    // A cold run: nothing came from the cache
    expect(taskRunSummary([{ kind: "usage", input_tokens: 200_000, cache_read_tokens: 0, cache_write_tokens: 199_000 }])).toBe("0 步 · 读取 20 万 token");
  });

  it("formats token counts in 万 / 亿", () => {
    expect(formatTokenCount(8500)).toBe("8,500");
    expect(formatTokenCount(342_668)).toBe("34 万");
    expect(formatTokenCount(172_229_033)).toBe("1.7 亿");
  });

  it("labels tools by what they do", () => {
    expect(taskToolLabel("Bash")).toBe("运行命令");
    expect(taskToolLabel("Shell")).toBe("运行命令");
    expect(taskToolLabel("Bash: `du -sh ~/.memento`")).toBe("运行命令");
    expect(taskToolLabel("TaskOutput")).toBe("任务输出");
    expect(taskToolLabel("mcp.search")).toBe("mcp.search");
  });
});
