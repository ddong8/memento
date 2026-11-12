import { expect, it } from "vitest";

import { stripRuntimeWarnings } from "../src/task-runner.js";

it("drops Node's own warnings from an agent's stderr and keeps the rest", () => {
  const stderr =
    "(node:55188) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.\r\n" +
    "(Use `Memento --trace-deprecation ...` to show where the warning was created)\r\n" +
    "Codex app-server exited (1) before the turn finished\n" +
    "(node:12) ExperimentalWarning: something\n";
  expect(stripRuntimeWarnings(stderr)).toBe("Codex app-server exited (1) before the turn finished\n");
  expect(stripRuntimeWarnings("plain error")).toBe("plain error");
});
