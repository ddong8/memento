import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TaskWorktree } from "../src/worktree.js";

describe("TaskWorktree & Cache Garbage Collection", () => {
  it("cleans up stale cache entries older than threshold", async () => {
    const testDir = join(process.cwd(), ".tmp-test-gc-" + Math.random().toString(36).slice(2, 8));
    const cacheDir = join(testDir, ".memento", "cache");
    await mkdir(cacheDir, { recursive: true });

    try {
      // Create a dummy cache file
      const oldFile = join(cacheDir, "old-video-preview.mp4");
      await writeFile(oldFile, "dummy media content");

      // With maxAgeMs = -1 (all files considered expired)
      const cleaned = await TaskWorktree.cleanupStale({ home: testDir, maxAgeMs: -1 });
      expect(cleaned).toBeGreaterThanOrEqual(1);
    } finally {
      await rm(testDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
