import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { applyGuards, curlConfigPath, hookCommand, stopScriptPath, withStopHook, type GuardTarget } from "../src/guard-inject.js";
import type { GuardTool } from "../src/guard.js";

let home: string;
let targets: Record<GuardTool, GuardTarget>;
let statePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guard_inject_"));
  mkdirSync(join(home, ".claude"));
  mkdirSync(join(home, ".codex"));
  targets = {
    claude_code: { toolHome: join(home, ".claude"), file: join(home, ".claude", "settings.json") },
    codex: { toolHome: join(home, ".codex"), file: join(home, ".codex", "hooks.json") },
  };
  statePath = join(home, ".memento", "guard_inject.json");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Record<string, any>;

it("adds one Stop entry next to the user's own hooks, and takes only it out again", () => {
  const script = "/h/.memento/hooks/stop-check.sh";
  const command = hookCommand(script, "claude_code");
  const mine = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }], PreToolUse: [{ matcher: "Bash", hooks: [] }] } };
  const on = withStopHook(mine, script, command, true)!;
  expect((on.hooks as any).Stop).toHaveLength(2);
  expect(withStopHook(on, script, command, true)).toBeNull();
  const off = withStopHook(on, script, command, false)!;
  expect(off).toEqual(mine);
  expect(withStopHook(off, script, command, false)).toBeNull();
  // A stale copy of ours (old command) is replaced, not duplicated
  const stale = { hooks: { Stop: [{ hooks: [{ type: "command", command: `sh ${script} old`, timeout: 5 }] }] } };
  expect(((withStopHook(stale, script, command, true)!.hooks as any).Stop as unknown[]).length).toBe(1);
});

it("installs the script and both hooks, trusts the Codex one, then removes everything it created", async () => {
  writeFileSync(targets.claude_code.file, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say hi" }] }] } }));
  const trust = vi.fn(async () => "trusted");
  const on = await applyGuards({ tools: ["claude_code", "codex"], home, targets, statePath, trustCodex: trust, platform: "darwin" });
  expect(on).toEqual({ claude_code: "written", codex: "written", codex_trust: "trusted" });
  expect(statSync(stopScriptPath(home)).mode & 0o777).toBe(0o700);
  expect(readFileSync(stopScriptPath(home), "utf8")).toContain(curlConfigPath(home));
  const claude = readJson(targets.claude_code.file);
  expect(claude.model).toBe("opus");
  expect(claude.hooks.Stop).toHaveLength(2);
  expect(existsSync(`${targets.claude_code.file}.memento.bak`)).toBe(true);
  expect(trust).toHaveBeenCalledWith(targets.codex.file, hookCommand(stopScriptPath(home), "codex"));

  // Converged: nothing rewritten, Codex not asked again
  const again = await applyGuards({ tools: ["claude_code", "codex"], home, targets, statePath, trustCodex: trust, platform: "darwin" });
  expect(again).toEqual({ claude_code: "unchanged", codex: "unchanged" });
  expect(trust).toHaveBeenCalledTimes(1);

  const off = await applyGuards({ tools: [], home, targets, statePath, trustCodex: trust, platform: "darwin" });
  expect(off).toEqual({ claude_code: "removed", codex: "removed" });
  expect(readJson(targets.claude_code.file)).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say hi" }] }] } });
  expect(existsSync(targets.codex.file)).toBe(false);
  expect(existsSync(stopScriptPath(home))).toBe(false);
});

it("leaves a broken settings file alone, skips tools that aren't installed, reports a failed trust", async () => {
  writeFileSync(targets.claude_code.file, "{ not json");
  rmSync(targets.codex.toolHome, { recursive: true });
  const r = await applyGuards({ tools: ["claude_code", "codex"], home, targets, statePath, platform: "darwin" });
  expect(r.claude_code).toMatch(/^error: /);
  expect(r.codex).toBe("absent");
  expect(readFileSync(targets.claude_code.file, "utf8")).toBe("{ not json");

  mkdirSync(targets.codex.toolHome);
  const failed = await applyGuards({
    tools: ["codex"],
    home,
    targets,
    statePath,
    platform: "darwin",
    trustCodex: async () => {
      throw new Error("找不到 codex 命令");
    },
  });
  expect(failed).toEqual({ codex: "written", codex_trust: "error: 找不到 codex 命令" });
});

it("does nothing on Windows", async () => {
  expect(await applyGuards({ tools: ["claude_code"], home, targets, statePath, platform: "win32" })).toEqual({ claude_code: "unsupported" });
  expect(existsSync(targets.claude_code.file)).toBe(false);
});
