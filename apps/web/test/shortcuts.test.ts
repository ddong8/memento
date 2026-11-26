import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_SHORTCUTS, keyLabel } from "../src/components/ask/ShortcutsDialog";

describe("keyboard shortcuts on the AI 执事 page", () => {
  it("lists every shortcut the page handles, with the platform's modifier", () => {
    const ask = fs.readFileSync(path.join(__dirname, "../src/app/ask/page.tsx"), "utf8");
    // each listed combination is handled in the page's keydown handler
    expect(ask).toContain('hasModifier && !e.shiftKey && key === "j"');
    expect(ask).toContain('hasModifier && e.shiftKey && key === "g"');
    expect(ask).toContain('hasModifier && e.shiftKey && key === "a" && supportsPermissionModes(executionModeRef.current)');
    expect(ask).toContain('hasModifier && key === "." && streaming');
    expect(ask).toContain('hasModifier && key === "/"');
    expect(ask).toContain('setGitDiffInit({ tab: "terminal" })');
    expect(ASK_SHORTCUTS.length).toBeGreaterThanOrEqual(9);
    expect(keyLabel("Mod", true)).toBe("⌘");
    expect(keyLabel("Mod", false)).toBe("Ctrl");
    expect(keyLabel("Shift", true)).toBe("⇧");
  });

  it("the code drawer opens on the tab asked for", () => {
    const drawer = fs.readFileSync(path.join(__dirname, "../src/components/ask/GitDiffDrawer.tsx"), "utf8");
    expect(drawer).toContain('setActiveTab(initialScope?.tab ?? "diff")');
  });
});
