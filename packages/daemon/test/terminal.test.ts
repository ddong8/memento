import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultShell, TerminalManager } from "../src/terminal.js";

class FakePty {
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  private dataCb: (d: string) => void = () => {};
  private exitCb: (e: { exitCode: number }) => void = () => {};
  pid = 1;
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows };
  }
  kill() {
    this.killed = true;
  }
  emit(d: string) {
    this.dataCb(d);
  }
  exit(code: number) {
    this.exitCb({ exitCode: code });
  }
}

describe("terminals opened from the web app", () => {
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const ptys: FakePty[] = [];
    const spawn = vi.fn((_file: string, _args: string[], opts: { cols: number; rows: number; cwd: string }) => {
      const p = new FakePty();
      p.size = { cols: opts.cols, rows: opts.rows };
      ptys.push(p);
      return p;
    });
    const mgr = new TerminalManager((m) => sent.push(m), () => ({ spawn }), () => ({ file: "/bin/zsh", args: ["-l"] }));
    return { mgr, sent, ptys, spawn };
  };

  it("streams output in batches under the terminal's id, and passes input and size down", () => {
    const { mgr, sent, ptys, spawn } = setup();
    expect(mgr.open("term-abc12345", "/nope/missing", 120, 40)).toBeNull();
    expect(spawn.mock.calls[0]![2].cwd).not.toBe("/nope/missing"); // a missing folder opens in home instead
    expect(ptys[0]!.size).toEqual({ cols: 120, rows: 40 });

    ptys[0]!.emit("ls\r\n");
    ptys[0]!.emit("a.ts b.ts\r\n");
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(sent).toEqual([{ type: "task_chunk", task_id: "term-abc12345", stream: "stdout", text: "ls\r\na.ts b.ts\r\n", seq: 1 }]);

    mgr.write("term-abc12345", "pwd\r");
    mgr.resize("term-abc12345", 9999, 0);
    expect(ptys[0]!.written).toEqual(["pwd\r"]);
    expect(ptys[0]!.size).toEqual({ cols: 500, rows: 2 });

    // re-opening the same id re-attaches instead of starting a second shell
    expect(mgr.open("term-abc12345", "", 80, 24)).toBeNull();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports the shell exiting and forgets the terminal; close kills it", () => {
    const { mgr, sent, ptys } = setup();
    mgr.open("term-exit0001", "", 80, 24);
    ptys[0]!.exit(0);
    expect(sent.at(-1)).toEqual({ type: "term_exit", term_id: "term-exit0001", exit_code: 0 });
    expect(mgr.count).toBe(0);
    mgr.open("term-kill0001", "", 80, 24);
    mgr.close("term-kill0001");
    expect(ptys[1]!.killed).toBe(true);
    expect(mgr.count).toBe(0);
  });

  it("refuses odd ids, too many terminals, and says so when node-pty isn't there", () => {
    const { mgr } = setup();
    expect(mgr.open("../../etc", "", 80, 24)).toBe("终端编号不合法");
    for (let i = 0; i < 6; i++) expect(mgr.open(`term-many000${i}`, "", 80, 24)).toBeNull();
    expect(mgr.open("term-many0006", "", 80, 24)).toContain("最多开 6 个");
    const none = new TerminalManager(() => {}, () => null);
    expect(none.available).toBe(false);
    expect(none.open("term-nopty001", "", 80, 24)).toContain("node-pty");
  });

  it("idle terminals close themselves", () => {
    const { mgr, ptys } = setup();
    mgr.open("term-idle0001", "", 80, 24);
    vi.advanceTimersByTime(46 * 60_000);
    expect(ptys[0]!.killed).toBe(true);
    expect(mgr.count).toBe(0);
  });

  it("starts the user's own shell", () => {
    expect(defaultShell("win32", {}).file).toMatch(/pwsh\.exe|powershell\.exe/);
    expect(defaultShell("linux", { SHELL: "/definitely/not/here" }).file).toMatch(/^\/bin\/(bash|sh)$/);
  });
});
