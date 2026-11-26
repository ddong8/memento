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

  it("floats Ask footer over full-bleed scroll container with live --ask-footer-h clearance and mobile pill fit", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const askPage = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/ask/page.tsx"), "utf8");
    const composer = fs.readFileSync(path.join(repoRoot, "apps/web/src/components/ask/AskComposer.tsx"), "utf8");

    expect(askPage).toContain("--ask-footer-h");
    expect(askPage).toContain("pointer-events-none");
    // Strip trailing OS parenthetical before .local in Target Device Badge
    const deviceBadgeSlice = askPage.slice(askPage.indexOf("Target Device Badge"), askPage.indexOf("Associated Project Badge"));
    expect(deviceBadgeSlice.indexOf('.replace(/\\s*\\([^)]*\\)$/, "")')).toBeGreaterThan(-1);
    expect(deviceBadgeSlice.indexOf('.replace(/\\s*\\([^)]*\\)$/, "")')).toBeLessThan(
      deviceBadgeSlice.indexOf('.replace(/\\.local$/i, "")'),
    );
    expect(deviceBadgeSlice).toContain("Mac-mini");
    expect(composer).toContain("compactPlaceholderText");
    expect(composer).toContain("w-9 h-9 sm:w-10 sm:h-10");
  });

  it("adapts 3D cognitive stage pages (/memory, /memory/persona, /skills) to --memento-tabbar-inset", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const css = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/globals.css"), "utf8");
    const layout = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/client-layout.tsx"), "utf8");
    const memory = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/memory/page.tsx"), "utf8");
    const persona = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/memory/persona/page.tsx"), "utf8");
    const skills = fs.readFileSync(path.join(repoRoot, "apps/web/src/app/skills/page.tsx"), "utf8");

    expect(css).toContain("html.memento-glass-tabbar .memento-stage-shell");
    expect(css).toContain("html.memento-glass-tabbar .memento-stage-main");
    expect(layout).toContain("memento-stage-main");
    expect(memory).toContain("memento-stage-shell");
    expect(persona).toContain("memento-stage-shell");
    expect(skills).toContain("memento-stage-shell");
  });

  it("keeps drawers and full-screen panels clear of the mobile app's floating tab bar", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const read = (f: string) => fs.readFileSync(path.join(repoRoot, "apps/web/src", f), "utf8");
    // Sidebar drawer: the user card / version row sits above the tab bar
    expect(read("components/layout/Sidebar.tsx")).toContain("env(safe-area-inset-bottom, 0.625rem)) + var(--memento-tabbar-inset, 0px))");
    // History drawer: the last conversation can scroll above it
    expect(read("components/ask/HistoryDrawer.tsx")).toContain('paddingBottom: "calc(10px + var(--memento-tabbar-inset, 0px))"');
    // Media viewer drawer on phones
    expect(read("components/viewers/MediaInspectorPanel.tsx")).toContain("max-lg:pb-[calc(env(safe-area-inset-bottom,0px)+var(--memento-tabbar-inset,0px))]");
    // Full-screen consoles hide the running-agents chip that would cover their back button / title
    expect(read("app/memory/page.tsx")).toContain("memento-fullscreen-panel");
    expect(read("app/skills/page.tsx")).toContain("memento-fullscreen-panel");
    // ...and are opaque on phones, so the page underneath doesn't bleed through their tabs
    expect(read("app/memory/page.tsx")).toContain("memento-fullscreen-panel lg:col-span-7 h-full flex flex-col min-h-0 bg-[var(--aurora-surface)] max-lg:bg-[var(--aurora-surface-solid)]");
    expect(read("app/skills/page.tsx")).toContain("max-lg:bg-[var(--aurora-surface-solid)]");
    expect(read("components/agent/ActiveRunsMonitor.tsx")).toContain("memento-active-runs-dock");
    expect(read("app/globals.css")).toContain("body:has(.memento-fullscreen-panel) .memento-active-runs-dock");
  });
});

