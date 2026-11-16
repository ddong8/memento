// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExecutionCard, { type ToolCallItem } from "../src/components/ExecutionCard";

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
});
