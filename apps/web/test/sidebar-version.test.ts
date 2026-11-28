import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatVersionTag, parseMobileAppVersion } from "../src/components/layout/Sidebar";

describe("sidebar client version resolution", () => {
  it("parses the real installed mobile app version from MementoMobile/<version> UA", () => {
    expect(
      parseMobileAppVersion(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 MementoMobile/1.0.172",
      ),
    ).toBe("1.0.172");
    expect(
      parseMobileAppVersion(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36 MementoMobile/1.0.175",
      ),
    ).toBe("1.0.175");
    expect(parseMobileAppVersion("Mozilla/5.0 MementoMobile/0")).toBeNull();
    expect(parseMobileAppVersion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBeNull();
    expect(parseMobileAppVersion(undefined)).toBeNull();
  });

  it("normalizes version labels with a single v prefix", () => {
    expect(formatVersionTag("1.0.172")).toBe("v1.0.172");
    expect(formatVersionTag("v1.0.172")).toBe("v1.0.172");
    expect(formatVersionTag(" 1.0.172 ")).toBe("v1.0.172");
  });

  it("reads mobile UA version and restricts desktop update checks to Electron", () => {
    const sidebarSrc = readFileSync(join(__dirname, "../src/components/layout/Sidebar.tsx"), "utf8");
    expect(sidebarSrc).toContain("parseMobileAppVersion(navigator.userAgent)");
    expect(sidebarSrc).toContain("if (!d) return;");
  });

  it("keeps apps/web/package.json version synced with desktop/mobile release version", () => {
    const webPkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8")) as { version: string };
    const desktopPkgPath = join(__dirname, "../../desktop/package.json");
    const mobilePkgPath = join(__dirname, "../../mobile/package.json");
    if (existsSync(desktopPkgPath)) {
      const desktopPkg = JSON.parse(readFileSync(desktopPkgPath, "utf8")) as { version: string };
      expect(webPkg.version).toBe(desktopPkg.version);
    }
    if (existsSync(mobilePkgPath)) {
      const mobilePkg = JSON.parse(readFileSync(mobilePkgPath, "utf8")) as { version: string };
      expect(webPkg.version).toBe(mobilePkg.version);
    }
  });
});
