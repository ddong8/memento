import { describe, expect, it } from "vitest";

import {
  normalizeMenuItems,
  createNotificationDeduper,
  getMediaMimeType,
  getTodayKey,
  normalizeDesktopAppName,
  parseByteRange,
  mediaRemoteUrl,
  parseMementoMediaFilePath,
} from "../src/helpers";

describe("media byte ranges", () => {
  const size = 1000;
  it("a plain range, and an open end runs to the last byte", () => {
    expect(parseByteRange("bytes=0-99", size)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange("bytes=900-", size)).toEqual({ start: 900, end: 999 });
  });

  it("bytes=-N is the last N bytes, not the first N + 1", () => {
    expect(parseByteRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("an end past the file is cut to its last byte, so Content-Length matches the body", () => {
    expect(parseByteRange("bytes=0-99999999", size)).toEqual({ start: 0, end: 999 });
  });

  it("past the end or backwards is a 416; anything else is the whole file", () => {
    expect(parseByteRange("bytes=1000-", size)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=500-100", size)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", size)).toBe("unsatisfiable");
    for (const h of [null, undefined, "", "bytes=-", "items=0-1", "bytes=0-1,5-9", "bytes=abc-"]) expect(parseByteRange(h, size)).toBeNull();
  });
});

describe("memento-media URLs", () => {
  it("the host Chromium makes of the first path segment is put back", () => {
    expect(parseMementoMediaFilePath("memento-media://local/Users/me/a%20b.mp4", "darwin")).toBe("/Users/me/a b.mp4");
    expect(parseMementoMediaFilePath("memento-media://users/me/v.mp4", "darwin")).toBe("/users/me/v.mp4");
    expect(parseMementoMediaFilePath("memento-media://local/C:/Users/me/v.mp4", "win32")).toBe("C:/Users/me/v.mp4");
    // Git Bash paths from agents on Windows, and names with "#" / "?" encoded per segment
    expect(parseMementoMediaFilePath("memento-media://local/c/Users/me/v.mp4", "win32")).toBe("C:/Users/me/v.mp4");
    expect(parseMementoMediaFilePath("memento-media://local/C%3A/Users/me/a%23b%3F.png", "win32")).toBe("C:/Users/me/a#b?.png");
    expect(parseMementoMediaFilePath("memento-media://local/Users/me/a.png?remote=x", "darwin")).toBe("/Users/me/a.png");
  });

  it("falls back only to the device-file routes of memento's own server", () => {
    const relay = "https://mem.ihasy.com/api/devices/abc/files/stream/a.png?path=%2Fx%2Fa.png&token=t";
    const url = (remote: string) => `memento-media://local/x/a.png?remote=${encodeURIComponent(remote)}`;
    expect(mediaRemoteUrl(url(relay), ["https://mem.ihasy.com"])).toBe(relay);
    expect(mediaRemoteUrl(url(relay), ["https://other.example"])).toBeNull();
    expect(mediaRemoteUrl(url("https://mem.ihasy.com/api/auth/me"), ["https://mem.ihasy.com"])).toBeNull();
    expect(mediaRemoteUrl("memento-media://local/x/a.png", ["https://mem.ihasy.com"])).toBeNull();
    expect(mediaRemoteUrl(url("not a url"), ["https://mem.ihasy.com"])).toBeNull();
  });

  it("types by extension", () => {
    expect(getMediaMimeType("/a/B.MOV")).toBe("video/quicktime");
    expect(getMediaMimeType("/a/sub.vtt")).toBe("text/vtt; charset=utf-8");
    expect(getMediaMimeType("/a/noext")).toBe("application/octet-stream");
  });
});

describe("desktop notifications", () => {
  it("the same one twice within the window is shown once, with or without its prefix", () => {
    let t = 0;
    const dup = createNotificationDeduper(120_000, () => t);
    expect(dup("Memento", "任务完成：部署好了")).toBe(false);
    expect(dup("Memento", "任务完成：部署好了")).toBe(true);
    expect(dup("Memento", "部署好了")).toBe(true);
    t = 121_000;
    expect(dup("Memento", "任务完成：部署好了")).toBe(false);
  });
});

describe("app usage", () => {
  it("names apps one way and drops system shells", () => {
    expect(normalizeDesktopAppName("Code")).toBe("VS Code");
    expect(normalizeDesktopAppName("Google Chrome Helper")).toBe("Google Chrome");
    expect(normalizeDesktopAppName("loginwindow")).toBe("");
    expect(normalizeDesktopAppName("  ")).toBe("");
    expect(normalizeDesktopAppName("iTerm2")).toBe("iTerm2");
  });

  it("keys a day by local date", () => {
    expect(getTodayKey(new Date(2026, 9, 7, 23, 59))).toBe("2026-10-07");
  });
});

describe("page menus shown as system menus", () => {
  it("keeps plain labelled items and tidy separators", () => {
    expect(
      normalizeMenuItems([
        { type: "separator" },
        { id: "export", label: "  导出 Markdown " },
        { type: "separator" },
        { type: "separator" },
        { id: "select", label: "多选", checked: true },
        { id: "x", label: "" },
        null,
        { id: "off", label: "不可用", enabled: false },
        { type: "separator" },
      ]),
    ).toEqual([
      { id: "export", label: "导出 Markdown" },
      { id: "", label: "", type: "separator" },
      { id: "select", label: "多选", checked: true },
      { id: "off", label: "不可用", enabled: false },
    ]);
  });

  it("rejects what isn't a list and caps its size", () => {
    expect(normalizeMenuItems("x")).toEqual([]);
    expect(normalizeMenuItems(Array.from({ length: 100 }, (_, i) => ({ id: String(i), label: `项 ${i}` }))).length).toBe(40);
    expect(normalizeMenuItems([{ label: "a".repeat(500) }])[0]?.label.length).toBe(120);
  });
});
