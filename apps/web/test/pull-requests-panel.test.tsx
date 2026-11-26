// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/native-notify", () => ({ showInAppToast: vi.fn(), triggerHapticFeedback: vi.fn() }));
vi.mock("@/components/viewers/MarkdownViewer", () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }));

import { api } from "../src/lib/api-client";
import { PullRequestsPanel } from "../src/components/ask/PullRequestsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const checks = (state: "success" | "failure" | "pending", n = 2) => ({
  state, passed: state === "success" ? n : 0, failed: state === "failure" ? 1 : 0, pending: state === "pending" ? 1 : 0, total: n,
});

describe("pull requests panel", () => {
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
    vi.restoreAllMocks();
  });

  it("lists PRs with their CI state, opens one and merges it with rebase by default", async () => {
    vi.spyOn(api, "listPullRequests").mockResolvedValue({
      prs: [
        { number: 12, title: "权限模式", author: "ddong8", headRefName: "feat/perm", baseRefName: "main", isDraft: false, updatedAt: "", url: "https://github.com/x/y/pull/12", checks: checks("failure") },
        { number: 11, title: "底栏胶囊", author: "ddong8", headRefName: "fix/pill", baseRefName: "main", isDraft: false, updatedAt: "", url: "", checks: checks("success") },
      ],
    });
    vi.spyOn(api, "getPullRequest").mockResolvedValue({
      number: 12, title: "权限模式", author: "ddong8", headRefName: "feat/perm", baseRefName: "main", isDraft: false, updatedAt: "",
      url: "https://github.com/x/y/pull/12", checks: checks("pending"), body: "加了四种权限模式", state: "OPEN",
      check_runs: [{ name: "ci / web", status: "IN_PROGRESS", conclusion: "", url: "" }],
      diff: "diff --git a/a.ts b/a.ts\n+const y = 3;\n-const y = 2;", diff_truncated: false,
    });
    const merge = vi.spyOn(api, "mergePullRequest").mockResolvedValue({ ok: true, method: "rebase", output: "" });
    const watch = vi.spyOn(api, "watchPullRequestChecks").mockResolvedValue({ ok: true });

    await act(async () => root.render(<PullRequestsPanel deviceId="mini" cwd="/repo" isZh={true} />));
    const text = container.textContent || "";
    expect(text).toContain("权限模式");
    expect(text).toContain("检查失败");
    expect(text).toContain("检查通过");

    const row = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("#12"))!;
    await act(async () => row.click());
    expect(container.querySelector('[data-testid="pr-detail"]')).toBeTruthy();
    expect(container.textContent).toContain("加了四种权限模式");
    expect(container.textContent).toContain("ci / web");

    const watchBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("盯 CI"))!;
    await act(async () => watchBtn.click());
    expect(watch).toHaveBeenCalledWith({ device_id: "mini", cwd: "/repo", number: 12 });

    const mergeBtn = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("变基合并"))!;
    await act(async () => mergeBtn.click());
    expect(merge).toHaveBeenCalledWith({ device_id: "mini", cwd: "/repo", number: 12, method: "rebase" });
  });

  it("says what's wrong when the device can't list them (gh missing or signed out)", async () => {
    vi.spyOn(api, "listPullRequests").mockRejectedValue(new Error("设备上没有安装 GitHub CLI（gh），装好并 gh auth login 后再试"));
    await act(async () => root.render(<PullRequestsPanel deviceId="mini" cwd="/repo" isZh={true} />));
    expect(container.textContent).toContain("GitHub CLI");
  });
});
