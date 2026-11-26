import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const glassSrc = readFileSync(join(__dirname, "../src/components/GlassSurface.tsx"), "utf8");
const indexSrc = readFileSync(join(__dirname, "../src/app/index.tsx"), "utf8");

// Pure resolver mirrors GlassSurface.tsx logic without pulling react-native runtime in node vitest
function resolveMobileGlassMode(platform: string, liquidGlassAvailable: boolean, enabled: boolean) {
  if (!enabled) return "solid";
  if (platform === "ios") return liquidGlassAvailable ? "liquid-glass" : "ios-blur";
  if (platform === "android") return "android-blur";
  return "solid";
}

describe("mobile native glass surface", () => {
  it("selects liquid glass on iOS 26+, BlurView on older iOS & Android, and solid when disabled", () => {
    expect(resolveMobileGlassMode("ios", true, true)).toBe("liquid-glass");
    expect(resolveMobileGlassMode("ios", false, true)).toBe("ios-blur");
    expect(resolveMobileGlassMode("android", false, true)).toBe("android-blur");
    expect(resolveMobileGlassMode("ios", true, false)).toBe("solid");
    expect(resolveMobileGlassMode("android", false, false)).toBe("solid");
  });

  it("uses expo-glass-effect GlassView and Expo SDK 57 BlurTargetView + dimezisBlurViewSdk31Plus", () => {
    expect(glassSrc).toContain("expo-glass-effect");
    expect(glassSrc).toContain("isLiquidGlassAvailable");
    expect(glassSrc).toContain('blurMethod="dimezisBlurViewSdk31Plus"');
    expect(glassSrc).toContain("blurTarget={blurTarget}");
    // Official Apple/Expo guard: never hide GlassView with opacity: 0
    expect(glassSrc).not.toContain("opacity: 0");

    expect(indexSrc).toContain("<BlurTargetView");
    expect(indexSrc).toContain("GlassSurface");
    expect(indexSrc).toContain("memento-glass-tabbar");
    expect(indexSrc).toContain("--memento-tabbar-inset");
    // Shadow must live on an outer wrapper (not clipped by GlassSurface overflow: hidden)
    expect(indexSrc).toContain("styles.tabBarShadow");
    // Compact <-> full dock must remount with mutually exclusive styles so RN Fabric/Yoga never keeps a stale 46px width
    expect(indexSrc).toContain('key={compactTabBar ? "tabbar-compact" : "tabbar-full"}');
    expect(indexSrc).toContain("styles.tabBarDockWrapFull");
    expect(indexSrc).toContain("styles.tabBarDockWrapCompact");
    // Tab bar uses crisp high-opacity surface tint (never muddy 0.22 clear glass over raw text)
    expect(glassSrc).not.toContain("rgba(255, 255, 255, 0.22)");
    expect(glassSrc).not.toContain("rgba(255, 255, 255, 0.50)");
    // Active tab color must follow page theme (`dark`), never OS color scheme (`t.accent`)
    expect(indexSrc).not.toContain("isActive ? t.accent");
    // Sub-tabs like /skills, /tasks, /devices map back to their parent bottom tab
    expect(indexSrc).toContain("matchTabForPath");
    expect(indexSrc).toContain('"/skills"');
  });
});
