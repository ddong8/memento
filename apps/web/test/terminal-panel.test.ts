import { describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
import { INPUT_BATCH_MS, parseSseFrames, terminalStorageKey } from "../src/components/ask/TerminalPanel";

describe("terminal panel", () => {
  it("reads output frames out of the SSE stream, keeping a half frame for the next read", () => {
    const { events, rest } = parseSseFrames('data: {"type":"ready"}\n\n: keepalive\n\ndata: {"type":"output","data":"ls\\r\\n"}\n\ndata: {"type":"out');
    expect(events).toEqual([{ type: "ready" }, { type: "output", data: "ls\r\n" }]);
    expect(rest).toBe('data: {"type":"out');
  });

  it("batches keystrokes briefly and remembers one terminal per device and folder", () => {
    expect(INPUT_BATCH_MS).toBeLessThanOrEqual(16);
    expect(terminalStorageKey("mini", "/repo")).not.toBe(terminalStorageKey("mini", "/other"));
  });

  it("sits in the code drawer as its own tab, loaded only when opened", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const drawer = fs.readFileSync(path.join(__dirname, "../src/components/ask/GitDiffDrawer.tsx"), "utf8");
    expect(drawer).toContain('data-testid="git-tab-terminal"');
    expect(drawer).toContain('dynamic(() => import("@/components/ask/TerminalPanel")');
  });
});
