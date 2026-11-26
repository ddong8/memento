import { describe, expect, it } from "vitest";
import {
  formatToolArgsSummary,
  formatToolResultMarkdown,
  getToolMeta,
  isMemoryOrWebTool,
  isNonDeviceTool,
  isPlanTool,
  TOOL_META_MAP,
} from "../src/lib/ask/tool-meta";
import { formatLiveActivityToolStep } from "../src/lib/ask/live-activity";

describe("orchestrator tool metadata & rendering helpers", () => {
  it("maps all MCP memory, web, plan, and device tools with Chinese labels", () => {
    const required = [
      "mind_resonance",
      "search_memory",
      "memory_recall",
      "memory_open",
      "memory_conversation",
      "memory_context",
      "memory_blueprint",
      "memory_project_map",
      "memory_graph",
      "memory_core",
      "memory_store",
      "daily_summary",
      "check_rules",
      "use_skill",
      "remember_pitfall",
      "add_todo",
      "list_todos",
      "todo_update",
      "fetch_url",
      "plan_and_run",
      "plan_status",
      "list_devices",
      "run_on_device",
    ];
    for (const name of required) {
      expect(TOOL_META_MAP[name]).toBeDefined();
      expect(getToolMeta(name, true).label.length).toBeGreaterThan(0);
    }
    expect(isMemoryOrWebTool("memory_blueprint")).toBe(true);
    expect(isMemoryOrWebTool("fetch_url")).toBe(true);
    expect(isMemoryOrWebTool("run_on_device")).toBe(false);
    expect(isPlanTool("plan_status")).toBe(true);
    expect(isNonDeviceTool("memory_store")).toBe(true);
    expect(isNonDeviceTool("run_on_device")).toBe(false);
  });

  it("formats concise tool argument summaries and markdown outputs", () => {
    expect(formatToolArgsSummary("memory_blueprint", { project_name: "memento", section: "business:3" })).toBe("memento · business:3");
    expect(formatToolArgsSummary("memory_store", { entity_name: "Memento", content: "启用上下文压缩" })).toBe("Memento: 启用上下文压缩");
    expect(formatToolArgsSummary("todo_update", { todo_id: "12345678-aaaa", status: "done" })).toBe("12345678 → done");

    expect(formatToolResultMarkdown("memory_blueprint", { markdown: "# 蓝图\n内容" })).toBe("# 蓝图\n内容");
    expect(formatToolResultMarkdown("search_memory", { results: [{ title: "部署手册", tool: "obsidian", excerpt: "k3s 部署" }] })).toContain("部署手册");
    expect(formatToolResultMarkdown("list_todos", { todos: [{ id: "abcd1234", title: "写测试" }] })).toContain("写测试");
  });

  it("formats Live Activity steps for MCP memory tools safely without '完成' triggers", () => {
    const step = formatLiveActivityToolStep("memory_blueprint", { project_name: "memento", section: "summary" });
    expect(step).toContain("读取蓝图");
    expect(step).toContain("memento");
    expect(step).not.toContain("完成");

    const todoStep = formatLiveActivityToolStep("todo_update", { todo_id: "12345678", status: "done", title: "任务已完成检查" });
    expect(todoStep).not.toContain("完成");
  });
});
