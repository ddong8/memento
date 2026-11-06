import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureProjectBlueprint,
  findGitRoot,
  isBlueprintReady,
  locateBlueprintGenerator,
} from "../src/blueprint-auto.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memento_bp_test_"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("blueprint-auto", () => {
  it("findGitRoot correctly locates git root or returns null", () => {
    expect(findGitRoot("")).toBeNull();
    expect(findGitRoot(tmpDir)).toBeNull();

    // Create .git directory
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir, { recursive: true });

    // Directly in root
    expect(findGitRoot(tmpDir)).toBe(tmpDir);

    // In a deep subdirectory
    const deepSub = join(tmpDir, "apps", "sub", "deep");
    mkdirSync(deepSub, { recursive: true });
    expect(findGitRoot(deepSub)).toBe(tmpDir);
  });

  it("isBlueprintReady checks both blueprint doc and post-commit hook", async () => {
    const gitDir = join(tmpDir, ".git", "hooks");
    mkdirSync(gitDir, { recursive: true });

    // Nothing created yet
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add dummy blueprint
    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    writeFileSync(bpPath, "# Dummy Blueprint Header with sufficient size for check");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add dummy hook without memento signature
    const hookPath = join(gitDir, "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho test\n");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add valid hook signature
    writeFileSync(hookPath, "#!/bin/sh\n# Auto-update PROJECT_BLUEPRINT.md upon commit\npython3 scripts/project_blueprint.py\n");
    expect(await isBlueprintReady(tmpDir)).toBe(true);
  });

  it("locateBlueprintGenerator finds local project generator if present", async () => {
    const localScripts = join(tmpDir, "scripts");
    mkdirSync(localScripts, { recursive: true });
    const localPy = join(localScripts, "project_blueprint.py");
    writeFileSync(localPy, "#!/usr/bin/env python3\nprint('mock')\n");

    const found = await locateBlueprintGenerator(tmpDir);
    expect(found).toBe(localPy);
  });

  it("ensureProjectBlueprint skips non-git repositories safely", async () => {
    const ok = await ensureProjectBlueprint(tmpDir);
    expect(ok).toBe(false);
  });

  it("ensureProjectBlueprint runs generator and deploys blueprint and hook", async () => {
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir, { recursive: true });

    // Mock package.json
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "demo-auto-bp", version: "1.0.0" }));

    const logs: string[] = [];
    const ok = await ensureProjectBlueprint(tmpDir, { force: true, log: (msg) => logs.push(msg) });
    expect(ok).toBe(true);

    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    const bpContent = readFileSync(bpPath, "utf8");
    const hookContent = readFileSync(hookPath, "utf8");

    expect(bpContent).toContain("# Project Blueprint: demo-auto-bp");
    expect(bpContent).toContain("## 1. Project Overview & Tech Stack");
    expect(hookContent).toContain("Memento Blueprint Hook Start");

    // Second call should hit in-memory cache and return true immediately
    const ok2 = await ensureProjectBlueprint(tmpDir);
    expect(ok2).toBe(true);
  });
});
