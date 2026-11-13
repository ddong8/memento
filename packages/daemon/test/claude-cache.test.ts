import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeBuilds, idleCompactPolicy, IdleCompactor, matchingBuild, sessionVersion } from "../src/claude-cache.js";

const isWin = process.platform === "win32";
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "claude_cache_"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake claude that answers --version with `version`. */
function fakeClaude(dir: string, version: string, name = "claude"): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  chmodSync(file, 0o755);
  return file;
}

const entry = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", entrypoint: "claude-vscode", version, message: { role: "assistant", content: [] }, ...extra });

describe("the build a session goes on with", () => {
  it("reads the build that wrote to the session last", async () => {
    const file = join(tmp, "s.jsonl");
    writeFileSync(file, [entry("2.1.300"), entry("2.1.322"), JSON.stringify({ type: "summary", version: "9.9.9" }), ""].join("\n"));
    expect(await sessionVersion(file)).toBe("2.1.322");
    expect(await sessionVersion(join(tmp, "missing.jsonl"))).toBeUndefined();
  });

  it.skipIf(isWin)("finds the builds on PATH, in ~/.local/bin and bundled with editors, and picks the session's", async () => {
    const pathBin = fakeClaude(join(tmp, "brew"), "2.1.311");
    fakeClaude(join(tmp, "home", ".local", "bin"), "2.1.283");
    const ext = fakeClaude(join(tmp, "home", ".vscode", "extensions", "anthropic.claude-code-2.1.322-darwin-arm64", "resources", "native-binary"), "2.1.322");
    const env = { PATH: join(tmp, "brew") };
    const builds = await claudeBuilds(env, join(tmp, "home"));
    expect(builds.map((b) => [b.version, b.source]).sort()).toEqual([
      ["2.1.283", "~/.local/bin"],
      ["2.1.311", "PATH"],
      ["2.1.322", "vscode 扩展"],
    ]);

    const session = join(tmp, "s.jsonl");
    writeFileSync(session, entry("2.1.322") + "\n");
    const pick = await matchingBuild(pathBin, session, env, join(tmp, "home"));
    expect(pick).toMatchObject({ path: ext, version: "2.1.322", had: "2.1.311" });

    // already the default's build, or a build that isn't here: the default
    writeFileSync(session, entry("2.1.311") + "\n");
    expect(await matchingBuild(pathBin, session, env, join(tmp, "home"))).toBeNull();
    writeFileSync(session, entry("2.1.999") + "\n");
    expect(await matchingBuild(pathBin, session, env, join(tmp, "home"))).toBeNull();
  });
});

describe("idle compaction", () => {
  it("follows the user's Claude Code settings", async () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    expect(await idleCompactPolicy({}, home)).toEqual({ on: true, minTokens: 200_000 });
    expect(await idleCompactPolicy({ CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "120000" }, home)).toEqual({ on: true, minTokens: 120_000 });
    expect((await idleCompactPolicy({ DISABLE_COMPACT: "1" }, home)).on).toBe(false);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ idleCompaction: false }));
    expect((await idleCompactPolicy({}, home)).on).toBe(false);
  });

  it.skipIf(isWin)("compacts an idle session with its build and model, and leaves one somebody went on with", async () => {
    const home = join(tmp, "home");
    const argsLog = join(tmp, "args.txt");
    const stdinLog = join(tmp, "stdin.txt");
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const exe = join(bin, "claude");
    const compacted = JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: 250000, post_tokens: 9000 } });
    writeFileSync(
      exe,
      `#!/bin/sh\necho "$@" >> "${argsLog}"\nIFS= read -r line; printf '%s\\n' "$line" >> "${stdinLog}"\nprintf '%s\\n' '${compacted}'\nprintf '%s\\n' '{"type":"result","is_error":false}'\ncat > /dev/null\n`,
    );
    chmodSync(exe, 0o755);
    const s1 = join(tmp, "s1.jsonl");
    const s2 = join(tmp, "s2.jsonl");
    writeFileSync(s1, entry("2.1.322") + "\n");
    writeFileSync(s2, entry("2.1.322") + "\n");
    const files: Record<string, string> = { s1, s2 };
    const logs: string[] = [];
    const c = new IdleCompactor((m) => logs.push(m), { afterMs: 150, home, findSession: async (id) => files[id] });
    const job = { cwd: tmp, exe, model: "claude-opus-5-5", env: { PATH: process.env.PATH ?? "" }, contextTokens: 250_000 };
    await c.schedule({ ...job, sessionId: "s1" });
    await c.schedule({ ...job, sessionId: "s2" });
    // s2 gets another write before it's due: somebody went on with it
    const later = new Date(Date.now() + 5000);
    utimesSync(s2, later, later);
    // too small to compact: not scheduled at all
    await c.schedule({ ...job, sessionId: "s3", contextTokens: 50_000 });
    await new Promise((r) => setTimeout(r, 1500));

    const { readFileSync } = await import("node:fs");
    const args = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(args).toHaveLength(1);
    expect(args[0]).toContain("-r s1");
    expect(args[0]).toContain("--model claude-opus-5-5");
    expect(JSON.parse(readFileSync(stdinLog, "utf8").trim()).message.content).toBe("/compact");
    expect(logs.some((l) => l.includes("s1: 250000 → 9000"))).toBe(true);
    c.dispose();
  });

  it("a run of the session cancels its pending compaction", async () => {
    const s = join(tmp, "s.jsonl");
    writeFileSync(s, entry("2.1.322") + "\n");
    const logs: string[] = [];
    const c = new IdleCompactor((m) => logs.push(m), { afterMs: 100, home: join(tmp, "home"), findSession: async () => s });
    await c.schedule({ sessionId: "s", cwd: tmp, exe: join(tmp, "no-such-claude"), env: {}, contextTokens: 300_000 });
    c.cancel("s");
    await new Promise((r) => setTimeout(r, 300));
    expect(logs).toEqual([]);
  });
});
