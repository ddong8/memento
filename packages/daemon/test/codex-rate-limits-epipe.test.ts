import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Codex quitting before it reads what it's sent fails the write with EPIPE, but only when the write lands after
// it closed its end, a race a real child rarely loses in a test: make every write to its stdin fail that way
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const child = real.spawn(...args);
      const stdin = child.stdin!;
      stdin.write = (() => {
        process.nextTick(() => stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })));
        return false;
      }) as typeof stdin.write;
      return child;
    },
  };
});

const { readCodexRateLimits, resetCodexRateLimits } = await import("../src/quotas.js");

let dir = "";
afterEach(() => {
  delete process.env.MEMENTO_CODEX_BIN;
  resetCodexRateLimits();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

it("gives up on a Codex whose stdin is closed instead of crashing the daemon", async () => {
  dir = mkdtempSync(join(tmpdir(), "memento-codex-epipe-"));
  const bin = join(dir, "codex");
  writeFileSync(bin, "#!/bin/sh\nsleep 5\n");
  chmodSync(bin, 0o755);
  process.env.MEMENTO_CODEX_BIN = bin;
  const started = Date.now();
  expect(await readCodexRateLimits(4000)).toBeUndefined();
  // Gave up on the error, not on the timeout
  expect(Date.now() - started).toBeLessThan(3000);
});
