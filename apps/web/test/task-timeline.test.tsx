// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TaskTimeline, { stepFiles } from "../src/components/TaskTimeline";
import { MediaInspectorProvider, useMediaInspector } from "../src/components/viewers/MediaInspectorContext";
import { fileDevice } from "../src/lib/file-devices";
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

  it("shows the file a read or edit step worked on, name first", () => {
    const events: TaskEvent[] = [
      { kind: "tool", id: "r", name: "Read", detail: "/Users/me/dev/app/src/main.ts", status: "done" },
      { kind: "tool", id: "e", name: "Edit", detail: "src/a.ts, src/b.ts", status: "done" },
      { kind: "tool", id: "v", name: "view_file", detail: "C:\\work\\notes.md:10-40", status: "running" },
      { kind: "tool", id: "w", name: "Write", detail: "Writing the summary", status: "done" },
    ];
    act(() => {
      root.render(<TaskTimeline events={events} running taskId="task-2" />);
    });
    const text = container.textContent || "";
    expect(text).toContain("main.ts");
    expect(text).toContain("/Users/me/dev/app/src");
    expect(text).toContain("a.ts, b.ts");
    expect(text).toContain("notes.md:10-40");
    expect(text).toContain("Writing the summary");
    const title = Array.from(container.querySelectorAll("span[title]")).map((el) => el.getAttribute("title"));
    expect(title).toContain("/Users/me/dev/app/src/main.ts");
    expect(title).toContain("src/a.ts\nsrc/b.ts");
    // Without the workbench around, file names aren't links.
    expect(container.querySelectorAll('[role="link"]').length).toBe(0);
  });

  it("renders nested collapsible subagent and swarm cards and groups child tool steps inside them", () => {
    const events: TaskEvent[] = [
      {
        kind: "subagent",
        id: "sub_1",
        name: "CodeReviewer",
        role: "researcher",
        agent_type: "subagent",
        detail: "审查后端接口",
        status: "running",
      },
      {
        kind: "tool",
        id: "child_read",
        name: "Read",
        detail: "/Users/me/dev/app/src/api.ts",
        status: "done",
        subagent_id: "sub_1",
        subagent_name: "CodeReviewer",
      },
      {
        kind: "subagent",
        id: "swarm_1",
        name: "worker-1",
        agent_type: "swarm",
        detail: "构建 Web",
        status: "done",
        output: "构建完成，0 错误",
      },
    ];

    act(() => {
      root.render(<TaskTimeline events={events} running taskId="task-sub" />);
    });

    const text = container.textContent || "";
    expect(text).toContain("子智能体");
    expect(text).toContain("CodeReviewer");
    expect(text).toContain("1 步");
    // Running subagent is auto-expanded, showing its nested tool step
    expect(text).toContain("api.ts");
    // Completed swarm card is collapsed by default, hiding its output until clicked
    expect(text).toContain("Swarm");
    expect(text).toContain("worker-1");
    expect(text).not.toContain("构建完成，0 错误");
    // Summary includes subagent count
    expect(text).toContain("2 个子智能体");

    // Click the completed swarm header to expand its output
    const swarmBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("worker-1"));
    expect(swarmBtn).toBeTruthy();
    act(() => swarmBtn!.click());
    expect(container.textContent || "").toContain("构建完成，0 错误");

    // Click the running subagent header to collapse its nested tools
    const subBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("CodeReviewer"));
    expect(subBtn).toBeTruthy();
    act(() => subBtn!.click());
    expect(container.textContent || "").not.toContain("api.ts");
  });
});

describe("TaskTimeline in the workbench", () => {
  it("opens a file the task wrote, from the task's device, even when the step has no output", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe() {
      return <output data-active={useMediaInspector()?.activeMedia?.url ?? ""} />;
    }
    const events: TaskEvent[] = [
      { kind: "tool", id: "w", name: "Write", detail: "C:\\work\\report.md", status: "done" },
      { kind: "tool", id: "e", name: "Edit", detail: "/Users/me/app/main.ts", status: "done" },
    ];
    act(() => {
      root.render(
        <MediaInspectorProvider>
          <TaskTimeline events={events} running={false} taskId="t" device={{ id: "pc-1", name: "PC (Windows)" }} />
          <Probe />
        </MediaInspectorProvider>,
      );
    });
    const links = container.querySelectorAll<HTMLElement>('[role="link"]');
    // The .md previews in the workbench; a .ts file has no viewer, so it is just shown.
    expect(Array.from(links).map((l) => l.textContent)).toEqual(["report.md"]);
    act(() => links[0].click());
    expect(container.querySelector("output")?.dataset.active).toBe("C:\\work\\report.md");
    expect(fileDevice("C:/work/report.md")).toEqual({ id: "pc-1", name: "PC (Windows)" });
    act(() => root.unmount());
    container.remove();
  });
});

describe("stepFiles", () => {
  it("reads paths, path lists and line ranges", () => {
    expect(stepFiles("/a/b/c.ts")).toEqual([{ path: "/a/b/c.ts", range: "", name: "c.ts", dir: "/a/b" }]);
    expect(stepFiles("src/x.ts:10-40")).toEqual([{ path: "src/x.ts", range: "10-40", name: "x.ts", dir: "src" }]);
    expect(stepFiles("C:\\a\\b.md")).toEqual([{ path: "C:\\a\\b.md", range: "", name: "b.md", dir: "C:\\a" }]);
    expect(stepFiles("README.md")).toEqual([{ path: "README.md", range: "", name: "README.md", dir: "" }]);
    expect(stepFiles("/Users/me/My Docs/a.md").map((f) => f.name)).toEqual(["a.md"]);
    expect(stepFiles("a.ts, b.ts").map((f) => f.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("leaves descriptions and cut-short lists as text", () => {
    expect(stepFiles("Reading the config")).toEqual([]);
    expect(stepFiles("Makefile")).toEqual([]);
    expect(stepFiles("a.ts, src/very/long/pa…")).toEqual([]);
    expect(stepFiles("Read file src/a.ts")).toEqual([]);
    expect(stepFiles("")).toEqual([]);
  });
});
