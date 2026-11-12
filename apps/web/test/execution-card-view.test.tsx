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
});
