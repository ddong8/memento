import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Regression guard: Web, Desktop (Electron), iOS and Android share apps/web's ClientLayout.
// A browser-style top progress bar across the top edge (removed 2026-11-28) made every client
// feel like a web page reloading and could get stuck at 80% on query-only links (?id= / ?tab=).
describe("no browser-style top progress bar", () => {
  const root = resolve(__dirname, "..");

  it("does not keep TopProgressBar component or mount it in ClientLayout", () => {
    expect(existsSync(resolve(root, "src/components/layout/TopProgressBar.tsx"))).toBe(false);
    const layoutSrc = readFileSync(resolve(root, "src/app/client-layout.tsx"), "utf8");
    expect(layoutSrc).not.toContain("TopProgressBar");
    expect(layoutSrc).not.toContain("top-progress");
  });

  it("does not dispatch memento:route-start from Sidebar and strips query params before comparing path", () => {
    const sidebarSrc = readFileSync(resolve(root, "src/components/layout/Sidebar.tsx"), "utf8");
    expect(sidebarSrc).not.toContain("memento:route-start");
    expect(sidebarSrc).toContain("targetHref.split(/[?#]/)");
  });
});
