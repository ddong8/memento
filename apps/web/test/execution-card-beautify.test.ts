import { describe, it, expect } from "vitest";
import { formatShortPath, cleanPromptText } from "../src/components/ExecutionCard";
import { cleanUserMessage } from "../src/components/ask/bubbles";
import { extractMediaFromMarkdown } from "../src/components/viewers/MediaInspectorContext";

describe("ExecutionCard & Ask Bubble Visual Beautification & Sanitization", () => {
  describe("1. formatShortPath", () => {
    it("shortens macOS home directory to ~", () => {
      expect(formatShortPath("/Users/haixingdong/dev/memento")).toBe("~/dev/memento");
      expect(formatShortPath("/Users/john")).toBe("~");
    });

    it("shortens Linux home directory to ~", () => {
      expect(formatShortPath("/home/ubuntu/app/server")).toBe("~/app/server");
      expect(formatShortPath("/home/deployer")).toBe("~");
    });

    it("leaves relative or system paths unchanged", () => {
      expect(formatShortPath("")).toBe("");
      expect(formatShortPath("/var/log/syslog")).toBe("/var/log/syslog");
      expect(formatShortPath("./src/components")).toBe("./src/components");
    });
  });

  describe("2. cleanPromptText and cleanUserMessage", () => {
    const rawUploadedPrompt =
      "【用户上传了图片 #1】\n" +
      "本地文件路径: /tmp/memento_images/1a02c819-80ab-492e-b958-fc3a3e32b37f/image_1.jpg\n" +
      "提示: 你可以使用视觉/文件查看工具（如 view_file）直接读取该文件进行图像分析与代码实现。\n\n" +
      "这个页面也再美化一下吧";

    it("purges internal system prompt wrappers and keeps user question intact", () => {
      const cleaned = cleanPromptText(rawUploadedPrompt);
      expect(cleaned).toBe("这个页面也再美化一下吧");
      expect(cleaned).not.toContain("【用户上传了图片");
      expect(cleaned).not.toContain("/tmp/memento_images");
    });

    it("cleanUserMessage scrubs system messages and attachment boilerplate", () => {
      const cleanedUser = cleanUserMessage(rawUploadedPrompt);
      expect(cleanedUser).toBe("这个页面也再美化一下吧");

      const sysMsg = "<SYSTEM_MESSAGE>Session resumed</SYSTEM_MESSAGE>请帮我排查问题";
      expect(cleanUserMessage(sysMsg)).toBe("请帮我排查问题");
    });

    it("handles plain text without modifications", () => {
      expect(cleanPromptText("Hello Antigravity")).toBe("Hello Antigravity");
      expect(cleanUserMessage("Hello Antigravity")).toBe("Hello Antigravity");
    });
  });

  describe("3. Discovered Media Safety - No False Positives from User Uploads", () => {
    it("does not report user uploaded images as generated products", () => {
      const toolOutput = "Task completed successfully. Inspected /tmp/memento_images/session-1/image_1.jpg";
      const extracted = extractMediaFromMarkdown(toolOutput);
      expect(extracted.length).toBeGreaterThan(0);

      // Filtering rule applied in ExecutionCard
      const promptRef = "/tmp/memento_images/session-1/image_1.jpg 这个页面也再美化一下吧";
      const filtered = extracted.filter((item) => {
        if (item.url.includes("/tmp/memento_images/") || item.url.includes("/memento/images/") || item.url.startsWith("blob:")) {
          return false;
        }
        if (promptRef && promptRef.includes(item.url)) {
          return false;
        }
        return true;
      });

      expect(filtered).toHaveLength(0);
    });

    it("allows genuine generated artifacts (e.g. diagrams, charts, reports)", () => {
      const toolOutput = "Report generated: /Users/haixingdong/dev/memento/docs/report.pdf and [chart](/output/chart.png)";
      const extracted = extractMediaFromMarkdown(toolOutput);
      const promptRef = "请生成分析报告";

      const filtered = extracted.filter((item) => {
        if (item.url.includes("/tmp/memento_images/") || item.url.includes("/memento/images/") || item.url.startsWith("blob:")) {
          return false;
        }
        if (promptRef && promptRef.includes(item.url)) {
          return false;
        }
        return true;
      });

      expect(filtered.length).toBe(2);
      expect(filtered.map((m) => m.type)).toContain("pdf");
      expect(filtered.map((m) => m.type)).toContain("image");
    });
  });
});
