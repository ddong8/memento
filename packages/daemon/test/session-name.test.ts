import { expect, it } from "vitest";

import { claudeSessionName } from "../src/task-runner.js";

const continued =
  "【前序会话核心记忆快照（原会话 ID: aa549791...）】\n### 核心记忆快照\n- 旧\n\n【执行规则】\n你已完整继承以上前序会话的全部背景。\n\n当前用户指令：\n部署完了吗";

it("names the session after the conversation, every turn", () => {
  expect(claudeSessionName("项目时间线记录功能", "部署完了吗", continued)).toBe("Memento: 项目时间线记录功能");
  expect(claudeSessionName("项目时间线记录功能", "各个工具的调用都是最佳状态吗", "各个工具的调用都是最佳状态吗")).toBe(
    "Memento: 项目时间线记录功能",
  );
});

it("falls back to what the user asked, not the context put in front of it", () => {
  expect(claudeSessionName("", "部署完了吗", continued)).toBe("Memento: 部署完了吗");
  expect(claudeSessionName("", "", continued)).toBe("Memento: 部署完了吗");
  expect(claudeSessionName("", "", "【前文对话历史】\n用户: 在吗\n--------------------\n【当前用户指令】\n查看设备")).toBe("Memento: 查看设备");
  expect(claudeSessionName("", "", "line one\nline two")).toBe("Memento: line one line two");
  expect(claudeSessionName("", "", "")).toBeUndefined();
});
