import { describe, expect, it } from "vitest";
import { extractMediaFromMarkdown } from "../src/components/viewers/MediaInspectorContext";
import { dirOfPath, resolveRelativeLink } from "../src/components/viewers/MediaPreview";

describe("relative links in the workbench", () => {
  it("resolves a link against the folder of the file it is in", () => {
    expect(resolveRelativeLink("reply-in-chinese.md", "/home/me/.claude/memory")).toBe("/home/me/.claude/memory/reply-in-chinese.md");
    expect(resolveRelativeLink("../docs/a%20b.md#x", "/repo/notes")).toBe("/repo/docs/a b.md");
    expect(resolveRelativeLink("./img/p.png", "C:\\Users\\me\\proj")).toBe("C:\\Users\\me\\proj\\img\\p.png");
  });
  it("leaves absolute links alone and drops relative ones with nothing to resolve them against", () => {
    expect(resolveRelativeLink("https://a.com/x.md")).toBe("https://a.com/x.md");
    expect(resolveRelativeLink("/Users/me/a.md")).toBe("/Users/me/a.md");
    expect(resolveRelativeLink("C:/a/b.md")).toBe("C:/a/b.md");
    expect(resolveRelativeLink("assets/cover.png")).toBe("assets/cover.png");
    expect(resolveRelativeLink("reply-in-chinese.md")).toBeNull();
    expect(resolveRelativeLink("reply-in-chinese.md", null)).toBeNull();
  });
  it("gives a file's folder", () => {
    expect(dirOfPath("/a/b/MEMORY.md")).toBe("/a/b");
    expect(dirOfPath("file:///a/b%20c/x.md")).toBe("/a/b c");
    expect(dirOfPath("C:\\a\\x.md")).toBe("C:\\a");
  });
  it("doesn't list a MEMORY.md index's relative links as files, unless it knows where it was read from", () => {
    const index = "- [回复用中文](reply-in-chinese.md) — 用中文\n- [续接](session-continue-in-place.md)\n见 /home/me/report.md";
    expect(extractMediaFromMarkdown(index).map((m) => m.url)).toEqual(["/home/me/report.md"]);
    expect(extractMediaFromMarkdown(index, "/home/me/memory").map((m) => m.url)).toEqual([
      "/home/me/memory/reply-in-chinese.md",
      "/home/me/memory/session-continue-in-place.md",
      "/home/me/report.md",
    ]);
  });
});
