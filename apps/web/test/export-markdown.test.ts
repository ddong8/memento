import { describe, expect, it } from "vitest";
import { buildConversationMarkdown } from "@/lib/ask/export-markdown";

describe("buildConversationMarkdown", () => {
  it("formats user turns, assistant thinking, tool calls, and summary cleanly", () => {
    const md = buildConversationMarkdown(
      [
        { role: "user", content: "检查数据库连接池", images: ["/api/media/image/a.png"] },
        {
          role: "assistant",
          content: "已将连接池默认上限调整为 35。",
          model: "claude-opus",
          duration_ms: 4200,
          thinking: "分析多副本连接池上限",
          toolCalls: [
            {
              name: "run_on_device",
              device_name: "dev-mac",
              args: { command: "git status -s" },
              result: { stdout: "M server/server/db/session.py" },
            },
          ],
        },
      ],
      {
        title: "连接池优化",
        executionMode: "claude",
        selectedDevice: "dev-mac",
        exportedAt: "2026-11-20 16:00:00",
      },
    );

    expect(md).toContain("# 连接池优化");
    expect(md).toContain("模式: claude | 设备: dev-mac | 总轮次: 2");
    expect(md).toContain("包含 1 张图片附件");
    expect(md).toContain("AI 执事回复 #1 [claude-opus] (4.2s)");
    expect(md).toContain("分析多副本连接池上限");
    expect(md).toContain("git status -s");
    expect(md).toContain("M server/server/db/session.py");
    expect(md).toContain("已将连接池默认上限调整为 35。");
  });
});
