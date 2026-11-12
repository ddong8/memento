// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import TaskTimeline from "../src/components/TaskTimeline";
import { executorCommand } from "../src/components/devices/ExecutorGuide";
import type { TaskEvent } from "@memento/core";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("code on another device", () => {
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

  it("shows the sync, where the changes went and which files", () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts`, status: "M" }));
    const events: TaskEvent[] = [
      { kind: "workspace", status: "synced", source: "MacBook", branch: "main", bytes: 2048, seconds: 1.2 },
      { kind: "workspace", status: "conflict", source: "MacBook", branch: "memento/abcd1234", files },
    ];
    act(() => {
      root.render(<TaskTimeline events={events} running={false} taskId="t-ws" />);
    });
    const text = container.textContent || "";
    expect(text).toContain("MacBook");
    expect(text).toContain("memento/abcd1234");
    expect(text).toContain("src/f0.ts");
    expect(text).not.toContain("src/f7.ts");
  });

  it("shows the commits that came back and the push done from the source", () => {
    const events: TaskEvent[] = [
      {
        kind: "workspace",
        status: "applied",
        source: "MacBook",
        files: [{ path: "a.ts", status: "M" }],
        commits: [
          { sha: "1111111122222222333333334444444455555555", subject: "feat: 第二个" },
          { sha: "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee", subject: "fix: 第一个" },
        ],
        committed: "branch",
        commit_branch: "main",
        push: { status: "pushed", remote: "origin", branch: "main", rebased: 1 },
      },
      {
        kind: "workspace",
        status: "conflict",
        source: "MacBook",
        branch: "memento/abcd1234",
        commits: [{ sha: "9999999988888888777777776666666655555555", subject: "feat: x" }],
        committed: "kept",
        commit_branch: "memento/abcd1234",
        push: { status: "skipped", detail: "提交放在了分支 memento/abcd1234，没有推送" },
      },
    ];
    act(() => {
      root.render(<TaskTimeline events={events} running={false} taskId="t-ws2" />);
    });
    const text = container.textContent || "";
    expect(text).toContain("11111111 feat: 第二个");
    expect(text).toContain("origin/main");
    expect(text).toContain("memento/abcd1234");
    expect(text).toContain("没有推送");
  });

  it("builds the executor command from the server, the token and the chosen agents", () => {
    expect(executorCommand("https://mem.example.com", "tok", ["claude", "agy"])).toBe(
      "curl -fsSL https://mem.example.com/install/executor.sh | bash -s -- --token tok --agents claude,agy",
    );
    expect(executorCommand("https://mem.example.com", "tok", [])).not.toContain("--agents");
  });
});
