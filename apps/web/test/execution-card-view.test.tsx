// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExecutionCard, { promptRepeatsUser, type ToolCallItem } from "../src/components/ExecutionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("execution card output", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a shell call's output as Markdown, with no Terminal view to switch to", () => {
    const call: ToolCallItem = {
      name: "run_on_device",
      args: { action: "shell", command: "cat notes.md" },
      result: { action: "shell", status: "succeeded", exit_code: 0, stdout: "# 标题\n\n- 第一条" },
    };
    act(() => root.render(<ExecutionCard call={call} />));
    const text = container.textContent || "";
    expect(text).not.toContain("Terminal");
    expect(container.querySelector("pre[style*='#080c14']")).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("标题");
    expect(text).toContain("$ cat notes.md");
  });

  it("a running agent card says what it's doing once, and doesn't echo the user's question or a bare path row", () => {
    const call = {
      name: "run_on_device",
      args: { action: "agent", binary: "claude", prompt: "目前这样适配是最优的吗", cwd: "/Users/someone/dev/memento" },
      result: { action: "agent", status: "running", task_id: "t-run" },
    } as unknown as ToolCallItem;
    act(() => root.render(<ExecutionCard call={call} userPrompt="目前这样适配是最优的吗" />));
    const text = container.textContent || "";
    expect(text.match(/设备运行中/g)?.length).toBe(1);
    expect(text).not.toContain("提示词");
    // working folder sits in the header; no copy button before there's output
    expect(text).toContain("memento");
    expect(text).not.toContain("~/dev/memento");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "复制")).toBe(false);
  });

  it("still shows a brief the orchestrator wrote for the agent", () => {
    const call = {
      name: "run_on_device",
      args: { action: "agent", binary: "codex", prompt: "在 server 里给导出接口加分页，跑 pytest 并汇报" },
      result: { action: "agent", status: "running", task_id: "t-brief" },
    } as unknown as ToolCallItem;
    act(() => root.render(<ExecutionCard call={call} userPrompt="导出太慢了，帮我处理一下" />));
    expect(container.textContent).toContain("提示词");
  });

  it("knows when the agent prompt is just the user's message", () => {
    expect(promptRepeatsUser("目前这样适配是最优的吗", "目前这样适配是最优的吗")).toBe(true);
    expect(promptRepeatsUser("【用户上传了图片 #1】\n本地文件路径: /tmp/a.jpg\n提示: 看图\n目前这样适配是最优的吗", "目前这样适配是最优的吗")).toBe(true);
    expect(promptRepeatsUser("在 server 里给导出接口加分页", "导出太慢了")).toBe(false);
    expect(promptRepeatsUser("目前这样适配是最优的吗", undefined)).toBe(false);
  });

  const question = (status: string) => ({
    name: "run_on_device",
    args: { action: "agent", binary: "claude", prompt: "issues你回复了吗" },
    result: {
      action: "agent",
      status,
      task_id: "t-question",
      events: [
        {
          kind: "question",
          id: "q1",
          tool: "AskUserQuestion",
          header: "回复评论",
          question: "要在 #21、#20、#19 下各发一条评论吗？",
          options: [{ label: "三条都发" }, { label: "先不发" }],
        },
      ],
    },
  }) as unknown as ToolCallItem;

  it("keeps an unanswered question clickable while the task runs, though the agent already wrote a reply", () => {
    // Claude Code writes "here are the drafts first:" and then asks: the task is not over
    act(() => root.render(<ExecutionCard call={question("running")} parentContent="草稿如下：" />));
    const text = container.textContent || "";
    expect(text).toContain("等待交互");
    expect(text).not.toContain("执行成功");
    const pick = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("三条都发"));
    expect(pick).toBeTruthy();
    expect(pick!.disabled).toBe(false);
  });

  it("says a question left unanswered by a task that ended can't be picked any more", () => {
    act(() => root.render(<ExecutionCard call={question("failed")} parentContent="草稿如下：" />));
    const text = container.textContent || "";
    expect(text).toContain("已结束");
    expect(text).not.toContain("等待交互");
    expect(text).toContain("直接在下方输入框");
  });

  it("keeps showing 后台运行中 while a running task already streamed text and has an active background tool", () => {
    const call: ToolCallItem = {
      name: "run_on_device",
      args: { action: "agent", binary: "agy", prompt: "监控渲染" },
      result: {
        action: "agent",
        status: "running",
        task_id: "t-bg",
        stdout: "渲染已在后台启动。",
        events: [
          { kind: "tool", id: "call_bg_1", name: "run_command", detail: "python render.py", status: "background" },
          { kind: "background", tasks: [{ id: "task-2", description: "python render.py" }] },
        ],
      },
    };
    act(() => root.render(<ExecutionCard call={call} parentContent="渲染已在后台启动。" />));
    const text = container.textContent || "";
    expect(text).toContain("后台运行中");
    expect(text).not.toContain("完成");
  });
});
