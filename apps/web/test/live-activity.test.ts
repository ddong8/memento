import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatLiveActivityProgressStep,
  formatLiveActivityTaskEvent,
  formatLiveActivityToolStep,
  sanitizeLiveActivityStep,
} from "../src/lib/ask/live-activity";

describe("live-activity helpers", () => {
  it("rewrites completion words for non-terminal updates while preserving terminal steps", () => {
    expect(
      sanitizeLiveActivityStep("后台任务持续执行中，完成后将自动继续", "executing", "update"),
    ).toBe("后台任务持续执行中，就绪后将自动继续");
    expect(sanitizeLiveActivityStep("子任务已完成，准备下一步", "background", "update")).toBe(
      "子任务已就绪，准备下一步",
    );
    expect(sanitizeLiveActivityStep("步骤已结束，等待唤醒", "running", "update")).toBe(
      "步骤收尾中，等待唤醒",
    );
    expect(sanitizeLiveActivityStep("旧步骤已停止", "running", "update")).toBe("旧步骤暂停中");

    // Terminal updates preserve completion wording verbatim
    expect(sanitizeLiveActivityStep("任务完成", "done", "end")).toBe("任务完成");
    expect(sanitizeLiveActivityStep("已停止", "cancelled", "end")).toBe("已停止");
    expect(sanitizeLiveActivityStep("任务已完成", "done", "update")).toBe("任务已完成");
  });

  it("never echoes raw run_on_device prompt into currentStep", () => {
    const step = formatLiveActivityToolStep("run_on_device", {
      prompt: "检查视频合成是否完成了，没完成就继续",
    });
    expect(step).toBe("正在设备上执行智能体任务...");
    expect(step).not.toContain("完成");

    const cmdStep = formatLiveActivityToolStep("run_on_device", {
      command: "python check.py --wait-until 完成",
    });
    expect(cmdStep).toContain("设备命令:");
    expect(cmdStep).not.toContain("完成");
  });

  it("formats background, subagent, and tool task events cleanly without completion triggers", () => {
    expect(formatLiveActivityProgressStep("running")).toBe("设备任务执行中...");
    expect(formatLiveActivityProgressStep("queued")).toBe("任务排队中...");
    const prog = formatLiveActivityProgressStep("正在等待 2 个后台任务完成...");
    expect(prog).not.toContain("完成");

    const bgStart = formatLiveActivityTaskEvent({
      kind: "background",
      tasks: [{ id: "task-1", description: "ffmpeg 超分完成后汇总" }],
    });
    expect(bgStart?.status).toBe("background");
    expect(bgStart?.currentStep).toContain("后台运行中（1个）");
    expect(bgStart?.currentStep).not.toContain("完成");

    const bgEnd = formatLiveActivityTaskEvent({
      kind: "background",
      tasks: [],
    });
    expect(bgEnd?.status).toBe("thinking");
    expect(bgEnd?.currentStep).toBe("后台结果已返回，继续推理中...");

    const bgTool = formatLiveActivityTaskEvent({
      kind: "tool",
      status: "background",
      name: "run_command",
      detail: "等待构建完成",
    });
    expect(bgTool?.status).toBe("background");
    expect(bgTool?.currentStep).not.toContain("完成");

    const sub = formatLiveActivityTaskEvent({
      kind: "subagent",
      status: "running",
      name: "完成后核对器",
    });
    expect(sub?.status).toBe("executing");
    expect(sub?.currentStep).not.toContain("完成");
  });

  it("never sends a bogus done end from ask page effect cleanup", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const askPage = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/ask/page.tsx"), "utf8");
    const stopIdx = askPage.indexOf("(window as any).__memento_stop_task");
    expect(stopIdx).toBeGreaterThan(-1);
    const effectBlock = askPage.slice(stopIdx, stopIdx + 1200);
    expect(effectBlock).not.toContain('currentStep: "任务完成"');
    expect(effectBlock).not.toContain('status: "done"');

    const swiftFiles = [
      "apps/mobile/targets/MementoLiveActivity/MementoLiveActivity.swift",
      "apps/mobile/plugins/withLiveActivity.js",
    ];
    for (const rel of swiftFiles) {
      const content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
      expect(content).not.toContain('currentStep.contains("完成")');
    }
    const generatedAppDelegate = path.join(repoRoot, "apps/mobile/ios/Memento/AppDelegate.swift");
    if (fs.existsSync(generatedAppDelegate)) {
      const content = fs.readFileSync(generatedAppDelegate, "utf8");
      expect(content).not.toContain('currentStep.contains("完成")');
    }
  });
});
