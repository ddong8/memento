import { describe, expect, it } from "vitest";

import { emitDeepLinkTarget, normalizeDeepLinkTarget, parseDeepLinkAction, subscribeDeepLinkTarget } from "../src/lib/deeplink";
import { createNotifyDedupe } from "../src/lib/notify-dedupe";

describe("deep links", () => {
  it("custom schemes, wrapped targets and bare paths become a web path", () => {
    expect(normalizeDeepLinkTarget("memento://ask?id=abc&scroll=bottom")).toBe("/ask?id=abc&scroll=bottom");
    expect(normalizeDeepLinkTarget("com.ihasy.memento://tasks")).toBe("/tasks");
    expect(normalizeDeepLinkTarget("memento:///?target=%2Fask%3Fid%3Dabc")).toBe("/ask?id=abc");
    expect(normalizeDeepLinkTarget("ask?id=1")).toBe("/ask?id=1");
    expect(normalizeDeepLinkTarget("https://mem.ihasy.com/ask")).toBe("https://mem.ihasy.com/ask");
  });

  it("the app's own root and not-found screens lead nowhere", () => {
    for (const v of [null, "", "  ", "memento://", "/", "/index", "/+not-found"]) expect(normalizeDeepLinkTarget(v)).toBeNull();
  });

  it("an island action names the conversation", () => {
    expect(parseDeepLinkAction("memento://ask?action=Cancel&conversationId=c1")).toEqual({
      action: "cancel",
      conversationId: "c1",
      targetPath: "/ask?action=Cancel&conversationId=c1",
    });
    expect(parseDeepLinkAction("memento://ask")).toBeNull();
  });

  it("a link that arrives before the web view listens is kept for it; login links are ignored", () => {
    expect(emitDeepLinkTarget("memento://login")).toBeNull();
    expect(emitDeepLinkTarget("memento://ask?id=late")).toBe("/ask?id=late");
    const got: string[] = [];
    const off = subscribeDeepLinkTarget((p) => got.push(p));
    emitDeepLinkTarget("memento://tasks");
    off();
    emitDeepLinkTarget("memento://daily");
    expect(got).toEqual(["/ask?id=late", "/tasks"]);
  });
});

describe("notification dedupe", () => {
  it("drops a repeat by id or by title + body within the window", () => {
    let t = 0;
    const d = createNotifyDedupe(60_000, () => t);
    d.markAsNotified("任务完成", "部署好了", "n1");
    expect(d.isRecentlyNotified("别的标题", "别的内容", "n1")).toBe(true);
    expect(d.isRecentlyNotified(" 任务完成 ", "部署好了 ")).toBe(true);
    expect(d.isRecentlyNotified("任务完成", "另一件事")).toBe(false);
    t = 60_000;
    expect(d.isRecentlyNotified("任务完成", "部署好了", "n1")).toBe(false);
  });
});
