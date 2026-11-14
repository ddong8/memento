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

import { viaRelay } from "../src/lib/p2p";

describe("which workbench files are tried straight from their device", () => {
  it("those that come through the server's relay, not the desktop app's own disk or other sites", () => {
    const relay = "https://mem.example/api/devices/mac/files/stream/a.md?path=%2Fa.md";
    expect(viaRelay({ playUrl: relay, relayUrl: relay })).toBe(true);
    expect(viaRelay({ playUrl: "memento-media://local/a.md", relayUrl: relay })).toBe(false);
    expect(viaRelay({ playUrl: "https://example.com/a.pdf" })).toBe(false);
  });
});

describe("links that name nothing the workbench can open", () => {
  it("leaves out patterns and the site-root pictures of fetched web pages", async () => {
    const { extractMediaFromMarkdown } = await import("../src/components/viewers/MediaInspectorContext");
    const text = [
      "![Azure Logo](/assets/third-parties/azure.png) ![logo](/img/logo_dark.svg)",
      "icons: /favicon.png /apple-touch-icon.png, pictures under assets/memento_*.png and /article/*.png",
      "real: /tmp/winshot/full2_s.png and /Users/me/Desktop/shot.jpg and /data2/memento/images/c1/image_1.webp",
      "C:/Users/Admin/Pictures/a.png and C:/logs/*.log",
    ].join("\n");
    const urls = extractMediaFromMarkdown(text).map((m) => m.url);
    expect(urls).toEqual([
      "/tmp/winshot/full2_s.png",
      "/Users/me/Desktop/shot.jpg",
      "/data2/memento/images/c1/image_1.webp",
      "C:/Users/Admin/Pictures/a.png",
    ]);
  });

  it("knows a device path from a site path", async () => {
    const { isLocalFilePath, hasWildcard } = await import("../src/components/viewers/MediaPreview");
    expect(isLocalFilePath("/assets/third-parties/heroku_dark.png")).toBe(false);
    expect(isLocalFilePath("/favicon.png")).toBe(false);
    expect(isLocalFilePath("/tmp/a/*.png")).toBe(false);
    expect(isLocalFilePath("/tmp/a/b.png")).toBe(true);
    expect(isLocalFilePath("/srv/app/out/chart.png")).toBe(true);
    expect(isLocalFilePath("/workspace/proj/shot.png")).toBe(true);
    expect(hasWildcard("/x/a.png?v=2")).toBe(false);
  });
});
