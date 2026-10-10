import { describe, expect, it } from "vitest";
import { detectStillRunning } from "../src/task-runner.js";
import { ClaudeStreamParser } from "../src/agent-stream.js";

describe("detectStillRunning", () => {
  it("detects Antigravity active background task", () => {
    const stdout = `
⚡ [Running tests]
Tool is running as a background task with task id: eebfe902/task-73
Task logs are available at: task-73.log
⏳ [等待后台任务 task-73 完成...]
`;
    expect(detectStillRunning(stdout, "", undefined, 0)).toBe(true);
  });

  it("recognizes Antigravity completed background task", () => {
    const stdout = `
⚡ [Running tests]
Tool is running as a background task with task id: eebfe902/task-73
✅ [后台任务 task-73 执行完毕，已接收运行结果]
测试全部通过，共 76 个测试用例。
`;
    expect(detectStillRunning(stdout, "", undefined, 0)).toBe(false);
  });

  it("detects STATUS_STILL_RUNNING marker", () => {
    const stdout = "一些输出...\n[STATUS_STILL_RUNNING: tasks=task-102]\n";
    expect(detectStillRunning(stdout, "", undefined, 0)).toBe(true);
  });

  it("detects Claude stream parser isStillRunning flag", () => {
    const parser = new ClaudeStreamParser();
    parser.isStillRunning = true;
    expect(detectStillRunning("正常输出", "", parser, 0)).toBe(true);
  });

  it("detects Chinese background text patterns", () => {
    const stdout = "任务已提交，已经在后台启动编译脚本，正在后台运行。";
    expect(detectStillRunning(stdout, "", undefined, 0)).toBe(true);
  });

  it("ignores non-zero exit code (failure)", () => {
    const stdout = "已经在后台启动编译脚本";
    expect(detectStillRunning(stdout, "Error occurred", undefined, 1)).toBe(false);
  });

  it("normal finished task is not still running", () => {
    const stdout = "所有文件构建完毕，dist 目录生成成功。";
    expect(detectStillRunning(stdout, "", undefined, 0)).toBe(false);
  });
});
