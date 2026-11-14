// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasNativeMenu, popupNativeMenu } from "../src/lib/native-menu";

const w = window as unknown as { mementoDesktop?: unknown };

describe("action menus as the system's menu", () => {
  afterEach(() => {
    delete w.mementoDesktop;
  });

  it("is undefined outside the desktop app and on older ones, so the page opens its own menu", async () => {
    expect(hasNativeMenu()).toBe(false);
    expect(await popupNativeMenu([{ id: "a", label: "A" }])).toBeUndefined();
    w.mementoDesktop = { isDesktop: true };
    expect(hasNativeMenu()).toBe(false);
    expect(await popupNativeMenu([{ id: "a", label: "A" }])).toBeUndefined();
  });

  it("opens under the anchor and returns the choice, null when closed without one", async () => {
    const popupMenu = vi.fn().mockResolvedValueOnce("export").mockResolvedValueOnce(null);
    w.mementoDesktop = { isDesktop: true, popupMenu };
    const anchor = document.createElement("button");
    anchor.getBoundingClientRect = () => ({ left: 100.4, bottom: 40, top: 10, right: 130, width: 30, height: 30, x: 100, y: 10, toJSON: () => ({}) });
    expect(hasNativeMenu()).toBe(true);
    expect(await popupNativeMenu([{ id: "export", label: "导出" }], anchor)).toBe("export");
    expect(popupMenu).toHaveBeenLastCalledWith([{ id: "export", label: "导出" }], { x: 100, y: 44 });
    expect(await popupNativeMenu([{ id: "export", label: "导出" }], anchor)).toBeNull();
  });

  it("falls back to the page's menu when the app can't show one", async () => {
    w.mementoDesktop = { isDesktop: true, popupMenu: vi.fn().mockRejectedValue(new Error("not allowed")) };
    expect(await popupNativeMenu([{ id: "a", label: "A" }])).toBeUndefined();
  });
});
