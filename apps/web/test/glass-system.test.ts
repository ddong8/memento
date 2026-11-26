import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORM_SCRIPT } from "../src/lib/platform-script";

describe("frosted glass architecture", () => {
  it("sets data-glass and data-native-glass before first paint in PLATFORM_SCRIPT", () => {
    expect(PLATFORM_SCRIPT).toContain("dr_glass");
    expect(PLATFORM_SCRIPT).toContain("data-glass");
    expect(PLATFORM_SCRIPT).toContain("data-native-glass");
    expect(PLATFORM_SCRIPT).toContain("nativeGlass");
  });

  it("defines partitioned desktop native vibrancy, selective mobile glass chrome, solid toggle, and floating tabbar inset", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const css = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/globals.css"), "utf8");

    // Desktop native vibrancy / Mica makes root transparent while main pane stays crisp opaque
    expect(css).toContain('html[data-client="desktop"][data-native-glass="1"][data-glass="on"]');
    expect(css).toContain(".memento-main-pane");
    // Mobile keeps list cards blur-free while unlocking .memento-glass-chrome
    expect(css).toContain('html[data-glass="on"] .memento-glass-chrome');
    // User toggle off cleanly disables blur
    expect(css).toContain('html[data-glass="off"] .memento-glass-chrome');
    // Floating mobile glass tabbar reserves live bottom inset
    expect(css).toContain("html.memento-glass-tabbar .memento-scroll-main");
    expect(css).toContain("--memento-tabbar-inset");
  });

  it("wires desktop vibrancy/mica IPC and glass toggle in UserMenu", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const desktopMain = fs.readFileSync(path.join(repoRoot, "apps/desktop/src/main.ts"), "utf8");
    const desktopPreload = fs.readFileSync(path.join(repoRoot, "apps/desktop/src/preload.ts"), "utf8");
    const userMenu = fs.readFileSync(path.join(repoRoot, "apps/web/src/components/UserMenu.tsx"), "utf8");

    expect(desktopMain).toContain('setVibrancy("sidebar")');
    expect(desktopMain).toContain('setBackgroundMaterial("mica")');
    expect(desktopMain).toContain('handle("app:set-glass"');
    expect(desktopPreload).toContain('setGlass:');
    expect(desktopPreload).toContain("nativeGlass");
    expect(userMenu).toContain("毛玻璃质感");
  });
});
