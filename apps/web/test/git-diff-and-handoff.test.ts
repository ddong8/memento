import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeTaskEvent, type TaskEvent } from "@memento/core";
import { formatApiError, formatInlineReviewPrompt, handoffModeLabel } from "@/lib/ask/git-review";

describe("git-review & cross-agent handoff helpers", () => {
  it("formats anchored inline diff comments with 1), 2) numbering and exact file:line locations", () => {
    const prompt = formatInlineReviewPrompt(
      [
        {
          id: "c1",
          path: "server/server/api/git_review.py",
          line: 48,
          side: "new",
          lineText: "if machine is None:",
          comment: "缺失设备时请返回更具体的错误提示",
        },
        {
          id: "c2",
          path: "apps/web/src/components/ask/GitDiffDrawer.tsx",
          line: 120,
          side: "old",
          lineText: "const oldVal = 1;",
          comment: "这段旧逻辑不要删，保留兼容",
        },
      ],
      { branch: "main", isZh: true },
    );

    expect(prompt).toContain("2 条逐行代码审阅意见");
    expect(prompt).toContain("分支 main 当前工作区");
    expect(prompt).toContain("1) server/server/api/git_review.py:48（行）");
    expect(prompt).toContain("2) apps/web/src/components/ask/GitDiffDrawer.tsx:120（旧行）");
    expect(prompt).toContain("缺失设备时请返回更具体的错误提示");
    expect(prompt).toContain("这段旧逻辑不要删，保留兼容");
  });

  it("returns empty string when no valid comments exist", () => {
    expect(formatInlineReviewPrompt([])).toBe("");
    expect(
      formatInlineReviewPrompt([
        { id: "x", path: "a.ts", line: 1, side: "new", lineText: "", comment: "   " },
      ]),
    ).toBe("");
  });

  it("merges checkpoint TaskEvents idempotently by checkpoint id", () => {
    const first: TaskEvent = {
      kind: "checkpoint",
      id: "cp-1",
      status: "created",
      branch: "main",
      before_ref: "refs/memento/checkpoints/cp-1/before",
      after_ref: "refs/memento/checkpoints/cp-1/after",
      files_changed: 2,
      insertions: 10,
      deletions: 3,
    };
    let list = mergeTaskEvent([], first);
    list = mergeTaskEvent(list, { ...first, files_changed: 3 });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "checkpoint", id: "cp-1", files_changed: 3 });
  });

  it("resolves human-readable labels for all handoff agent modes", () => {
    expect(handoffModeLabel("claude", true)).toBe("Claude Code");
    expect(handoffModeLabel("codex", true)).toBe("Codex");
    expect(handoffModeLabel("antigravity", true)).toBe("Antigravity");
    expect(handoffModeLabel("workbuddy", true)).toBe("WorkBuddy");
    expect(handoffModeLabel("ai", true)).toBe("AI 编排");
  });

  it("unwraps FastAPI JSON detail strings cleanly instead of showing raw JSON", () => {
    expect(formatApiError(new Error('API 504: {"detail":"设备 35 秒没有回应"}'))).toBe("设备 35 秒没有回应");
    expect(formatApiError(new Error('API 409: {"detail":"请升级客户端"}'))).toBe("请升级客户端");
    expect(formatApiError(new Error("普通网络异常"))).toBe("普通网络异常");
  });

  it("GitDiffDrawer and HandoffModal clear mobile Liquid Glass TabBar, iOS safe areas, and Windows window controls", () => {
    const diffSrc = readFileSync(resolve(process.cwd(), "src/components/ask/GitDiffDrawer.tsx"), "utf8");
    const handoffSrc = readFileSync(resolve(process.cwd(), "src/components/ask/HandoffModal.tsx"), "utf8");
    expect(diffSrc).toContain("data-window-controls");
    expect(diffSrc).toContain("--memento-tabbar-inset");
    expect(diffSrc).toContain("safe-area-inset-top");
    expect(diffSrc).toContain("safe-area-inset-bottom");
    expect(diffSrc).toContain("overscroll-x-contain");
    expect(handoffSrc).toContain("--memento-tabbar-inset");
    expect(handoffSrc).toContain("safe-area-inset-bottom");
  });
});

describe("AI-written commit message", () => {
  it("the commit tab asks the user's model for the message and PR text of the ticked files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const drawer = fs.readFileSync(path.join(__dirname, "../src/components/ask/GitDiffDrawer.tsx"), "utf8");
    const client = fs.readFileSync(path.join(__dirname, "../src/lib/api-client.ts"), "utf8");
    expect(drawer).toContain('data-testid="git-suggest-message"');
    expect(drawer).toContain("files: Array.from(selectedDeliverFiles)");
    expect(drawer).toContain("setPrBody(res.pr_body)");
    expect(client).toContain('"/api/git/suggest-message"');
  });
});

describe("projects with several repositories", () => {
  it("the code drawer offers a repository picker and works on the one picked", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const drawer = fs.readFileSync(path.join(__dirname, "../src/components/ask/GitDiffDrawer.tsx"), "utf8");
    expect(drawer).toContain('data-testid="git-repo-picker"');
    expect(drawer).toContain('const effectiveCwd = (repoPick || initialScope?.repoRoot || cwd || "").trim();');
    expect(drawer).toContain("api\n      .listGitRepos({ device_id: deviceId, cwd })".replace("\\n", "\n"));
  });
});
