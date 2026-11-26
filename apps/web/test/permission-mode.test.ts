import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSION_MODE_OPTIONS, normalizePermissionMode, permissionModeLabel } from "../src/lib/ask/permission-mode";

describe("permission modes", () => {
  it("offers the four modes, full access first (how memento always ran), and falls back to it", () => {
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.id)).toEqual(["full", "auto_edits", "auto", "supervised"]);
    expect(normalizePermissionMode("supervised")).toBe("supervised");
    expect(normalizePermissionMode("yolo")).toBe("full");
    expect(normalizePermissionMode(undefined)).toBe("full");
    expect(permissionModeLabel("supervised", true)).toBe("每步都问");
  });

  it("is sent with every ask, restored with the conversation and shown in the summary bar when it asks", () => {
    const ask = fs.readFileSync(path.join(__dirname, "../src/app/ask/page.tsx"), "utf8");
    expect(ask).toContain("permission_mode: permissionMode,");
    expect(ask).toContain("setPermissionMode(normalizePermissionMode(data.permission_mode ?? cfg.permission_mode));");
    expect(ask).toContain('data-testid="ask-permission-mode"');
    expect(ask).toContain('supportsPermissionModes(executionMode) && permissionMode !== "full"');
  });
});
