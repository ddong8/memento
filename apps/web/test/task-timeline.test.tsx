// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TaskTimeline from "../src/components/TaskTimeline";
import type { TaskEvent } from "@memento/core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("TaskTimeline", () => {
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

  it("handles long bash command without overflowing and parses label correctly", () => {
    const longBash = "du -sh ~/.memento ~/.workbuddy ~/.Trash 2>/dev/null; ls -la /very/long/path/that/used/to/overflow/screen";
    const events: TaskEvent[] = [
      {
        kind: "tool",
        id: "tool_1",
        name: `Bash: \`${longBash}\``,
        detail: `Bash: \`${longBash}\``,
        status: "done",
      },
      {
        kind: "tool",
        id: "tool_2",
        name: "TaskOutput",
        detail: "TaskOutput",
        status: "done",
      },
    ];

    act(() => {
      root.render(<TaskTimeline events={events} running={false} taskId="task-1" />);
    });

    // Check parsed tool labels
    const textContent = container.textContent || "";
    expect(textContent).toContain("运行命令");
    expect(textContent).toContain("任务输出");

    // Check buttons have overflow and width constraints
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of Array.from(buttons)) {
      if (btn.textContent?.includes("运行命令")) {
        expect(btn.style.overflow).toBe("hidden");
        expect(btn.style.maxWidth).toBe("100%");
      }
    }

    // Check check icons are rendered
    const checkIcons = container.querySelectorAll("svg");
    expect(checkIcons.length).toBeGreaterThanOrEqual(2);
  });
});
