import { describe, expect, it } from "vitest";
import { PLATFORM_SCRIPT } from "../src/lib/platform-script";

/** Runs the head script against a fake page and returns the <html> attributes it set. */
function run(ua: string, win: Record<string, unknown> = {}, maxTouchPoints = 0): Record<string, string> {
  const attrs: Record<string, string> = {};
  const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  const navigator = { userAgent: ua, maxTouchPoints };
  new Function("document", "navigator", "window", PLATFORM_SCRIPT)(document, navigator, win);
  return attrs;
}

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

describe("platform markers before the first paint", () => {
  it("tells the desktop app, the mobile app and a browser apart", () => {
    expect(run(MAC, { mementoDesktop: { isDesktop: true } })).toEqual({ "data-client": "desktop", "data-os": "mac" });
    expect(run(WIN, { mementoDesktop: { isDesktop: true } })).toEqual({ "data-client": "desktop", "data-os": "windows" });
    expect(run("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 MementoMobile/1.0.125")).toEqual({
      "data-client": "mobile",
      "data-os": "ios",
    });
    expect(run("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36", { ReactNativeWebView: {} })).toEqual({
      "data-client": "mobile",
      "data-os": "android",
    });
    expect(run("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36")).toEqual({ "data-client": "web", "data-os": "linux" });
  });

  it("knows HarmonyOS and an iPad that reports itself as a Mac", () => {
    expect(run("Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00) AppleWebKit/537.36 Chrome/114 Mobile Safari/537.36")["data-os"]).toBe("harmony");
    expect(run("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", {}, 5)["data-os"]).toBe("ios");
  });
});
