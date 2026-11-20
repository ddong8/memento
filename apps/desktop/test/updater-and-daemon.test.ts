import { describe, expect, it } from "vitest";

import {
  createNotificationDeduper,
  mediaRemoteUrl,
  normalizeDesktopAppName,
  normalizeMenuItems,
  parseByteRange,
  parseMementoMediaFilePath,
} from "../src/helpers";

describe("desktop security and lifecycle helpers", () => {
  it("mediaRemoteUrl rejects SSRF, credentials, non-stream APIs, and cross-origin URLs", () => {
    const origins = ["https://mem.ihasy.com", "http://127.0.0.1:8000"];
    const wrap = (remote: string) => `memento-media://local/a/b.png?remote=${encodeURIComponent(remote)}`;

    // Allowed same-origin device file stream
    const valid = "https://mem.ihasy.com/api/devices/dev1/files/stream/b.png?path=%2Fa%2Fb.png";
    expect(mediaRemoteUrl(wrap(valid), origins)).toBe(valid);

    // Rejected: SSRF to metadata / arbitrary external hosts / non-stream routes
    expect(mediaRemoteUrl(wrap("http://169.254.169.254/latest/meta-data/"), origins)).toBeNull();
    expect(mediaRemoteUrl(wrap("https://mem.ihasy.com.evil.com/api/devices/dev1/files/stream/a.png"), origins)).toBeNull();
    expect(mediaRemoteUrl(wrap("https://mem.ihasy.com/api/admin/users"), origins)).toBeNull();
    expect(mediaRemoteUrl(wrap("file:///etc/passwd"), origins)).toBeNull();
  });

  it("parseMementoMediaFilePath handles encoded unicode, spaces, and Windows drive normalization", () => {
    expect(parseMementoMediaFilePath("memento-media://local/Users/me/%E6%B5%8B%E8%AF%95%201.pdf", "darwin")).toBe("/Users/me/测试 1.pdf");
    expect(parseMementoMediaFilePath("memento-media://local/d/work/demo%231.mp4", "win32")).toBe("D:/work/demo#1.mp4");
    expect(parseMementoMediaFilePath("https://example.com/a.png", "darwin")).toBe("");
    expect(parseMementoMediaFilePath("not a url", "darwin")).toBe("");
  });

  it("parseByteRange covers empty files, zero-length suffix, and boundary clamping", () => {
    expect(parseByteRange("bytes=0-10", 0)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-1", 1)).toEqual({ start: 0, end: 0 });
    expect(parseByteRange("bytes=0-0", 1)).toEqual({ start: 0, end: 0 });
    expect(parseByteRange("bytes=1-1", 1)).toBe("unsatisfiable");
  });

  it("createNotificationDeduper isolates different titles and purges expired keys", () => {
    let now = 1000;
    const isDup = createNotificationDeduper(5000, () => now);
    expect(isDup("设备 A", "任务完成：构建成功")).toBe(false);
    expect(isDup("设备 B", "任务完成：构建成功")).toBe(false);
    expect(isDup("设备 A", "构建成功")).toBe(true);
    now += 6000;
    expect(isDup("设备 A", "构建成功")).toBe(false);
  });

  it("normalizeDesktopAppName strips system noise and normalizes IDE aliases", () => {
    expect(normalizeDesktopAppName("LockApp")).toBe("");
    expect(normalizeDesktopAppName("ScreenSaverEngine")).toBe("");
    expect(normalizeDesktopAppName("Visual Studio Code")).toBe("VS Code");
    expect(normalizeDesktopAppName("Antigravity Helper")).toBe("Antigravity");
  });

  it("normalizeMenuItems strips trailing/leading/duplicate separators and preserves checked flags", () => {
    const out = normalizeMenuItems([
      { type: "separator" },
      { id: "a", label: "复制", checked: true },
      { type: "separator" },
      { type: "separator" },
      { id: "b", label: "删除" },
      { type: "separator" },
    ]);
    expect(out).toEqual([
      { id: "a", label: "复制", checked: true },
      { id: "", label: "", type: "separator" },
      { id: "b", label: "删除" },
    ]);
  });
});
