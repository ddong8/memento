import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { checkStop, claudeSteps, codexSteps, commandSteps, decide, findClaim, readTail } from "../src/guard.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "guard_"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// ---- Claude Code transcript helpers ----
let n = 0;
const prompt = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const call = (name: string, input: Record<string, unknown>) => {
  const id = `tu_${++n}`;
  return { id, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }) };
};
const result = (id: string, isError = false) =>
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "out", is_error: isError }] } });
const bash = (command: string, isError = false) => {
  const c = call("Bash", { command });
  return [c.line, result(c.id, isError)];
};
const edit = (file: string) => {
  const c = call("Edit", { file_path: file, old_string: "a", new_string: "b" });
  return [c.line, result(c.id)];
};

it("finds claims, not negations, questions, conditions or quotes", () => {
  expect(findClaim("已部署并验证：/health 返回新版本。")).toContain("已部署");
  expect(findClaim("三处都改好了。")).toContain("改好了");
  expect(findClaim("全部完成，下面逐项说明")).toContain("全部完成");
  expect(findClaim("The fix is deployed and verified.")).toContain("deployed");
  expect(findClaim("还没部署，等 CI 通过后再推。")).toBeNull();
  expect(findClaim("尚未修复，原因见下。")).toBeNull();
  expect(findClaim("完成了吗？")).toBeNull();
  expect(findClaim("部署完成后要看 /health 的版本号。")).toBeNull();
  expect(findClaim("如果都修好了就发版")).toBeNull();
  expect(findClaim("用户说“已经上线了”，但线上没变")).toBeNull();
  expect(findClaim("```\n已完成\n```\n下面是日志")).toBeNull();
  expect(findClaim("这个函数读取配置并返回结果")).toBeNull();
});

it("classifies commands: edits, shipping, checks, compound commands in order", () => {
  expect(commandSteps("sed -i '' 's/a/b/' src/x.ts", true, true).map((s) => s.kind)).toEqual(["edit"]);
  expect(commandSteps("cd server && uv run pytest -q", true, true).map((s) => s.kind)).toEqual(["verify"]);
  expect(commandSteps("git push origin main && gh run watch", true, true).map((s) => s.kind)).toEqual(["ship", "verify"]);
  expect(commandSteps("git status && git log -3", true, true).map((s) => s.kind)).toEqual(["other"]);
  expect(commandSteps("curl -s https://x/health > /tmp/h.json", true, true).map((s) => s.kind)).toEqual(["verify"]);
  expect(commandSteps("cat > src/a.ts <<'EOF'\nx\nEOF", true, true).map((s) => s.kind)).toEqual(["edit"]);
});

it("blocks a done claim with no check after the last edit", () => {
  const lines = [prompt("修一下"), ...bash("npx vitest run"), ...edit("/repo/src/a.ts")];
  const v = decide({ last_assistant_message: "已修复。" }, claudeSteps(lines));
  expect(v.block).toBe(true);
  expect(v.outcome).toBe("no_evidence");
  expect(v.reason).toContain("最后一次改动之后没有运行过任何验证");
});

it("lets a done claim through when a check passed after the last edit", () => {
  const lines = [prompt("修一下"), ...edit("/repo/src/a.ts"), ...bash("npx vitest run")];
  const v = decide({ last_assistant_message: "已修复，测试全部通过。" }, claudeSteps(lines));
  expect(v).toMatchObject({ block: false, outcome: "verified" });
  expect(v.check).toContain("vitest");
});

it("blocks when the latest check failed", () => {
  const lines = [prompt("修一下"), ...edit("/repo/src/a.ts"), ...bash("npx vitest run", true)];
  const v = decide({ last_assistant_message: "改好了" }, claudeSteps(lines));
  expect(v).toMatchObject({ block: true, outcome: "failed_check" });
});

it("a deploy claim needs a check after the push, not just tests before it", () => {
  const before = [prompt("发版"), ...edit("/repo/src/a.ts"), ...bash("uv run pytest"), ...bash("git push origin main")];
  expect(decide({ last_assistant_message: "已上线。" }, claudeSteps(before)).block).toBe(true);
  const after = [...before, ...bash("curl -s https://mem.example/health")];
  expect(decide({ last_assistant_message: "已上线。" }, claudeSteps(after)).outcome).toBe("verified");
});

it("notes, memory and temp files written after the checks don't count as changes", () => {
  const lines = [
    prompt("修一下"),
    ...edit("/repo/src/a.ts"),
    ...bash("npm test"),
    ...edit("/Users/me/.claude/projects/x/memory/notes.md"),
    ...edit("/tmp/scratch.py"),
  ];
  expect(decide({ last_assistant_message: "已完成" }, claudeSteps(lines)).outcome).toBe("verified");
});

it("with no change in sight, the claim must be checked in this turn", () => {
  const earlier = [prompt("看下线上"), ...bash("kubectl get pods"), prompt("完成了吗")];
  expect(decide({ last_assistant_message: "已经完成了" }, claudeSteps(earlier)).block).toBe(true);
  const now = [...earlier, ...bash("curl -s https://mem.example/health")];
  expect(decide({ last_assistant_message: "已经完成了" }, claudeSteps(now)).block).toBe(false);
});

it("saying what wasn't verified is let through, and a follow-up stop is never blocked", () => {
  const lines = [prompt("修一下"), ...edit("/repo/src/a.ts")];
  expect(decide({ last_assistant_message: "已修复。没有验证：本机没有集群权限。" }, claudeSteps(lines))).toMatchObject({
    block: false,
    outcome: "disclosed",
  });
  expect(decide({ last_assistant_message: "已修复。", stop_hook_active: true }, claudeSteps(lines))).toMatchObject({
    block: false,
    outcome: "no_evidence",
    followup: true,
  });
});

it("no claim, no block", () => {
  expect(decide({ last_assistant_message: "原因是缓存没清。要我改吗？" }, []).outcome).toBe("no_claim");
});

it("Codex rollouts: commands with exit codes, file changes, turns", () => {
  const ev = (payload: Record<string, unknown>) => JSON.stringify({ type: "event_msg", payload });
  const lines = [
    ev({ type: "task_started" }),
    ev({ type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "pytest -q"], exit_code: "0", status: "completed" } }),
    ev({ type: "task_started" }),
    ev({ type: "item_completed", item: { type: "FileChange", changes: { "/repo/a.py": { type: "update" } }, status: "completed" } }),
    ev({ type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "pytest -q"], exit_code: 1, status: "failed" } }),
  ];
  const steps = codexSteps(lines);
  expect(steps.map((s) => [s.kind, s.ok, s.turn])).toEqual([
    ["verify", true, false],
    ["edit", null, true],
    ["verify", false, true],
  ]);
  expect(decide({ last_assistant_message: "已修复" }, steps).outcome).toBe("failed_check");
});

it("reads only the tail of a big transcript, as whole lines", async () => {
  const file = join(tmp, "t.jsonl");
  writeFileSync(file, `${"x".repeat(100)}\n${prompt("a")}\n${prompt("b")}\n`);
  const lines = await readTail(file, 60);
  expect(lines.every((l) => l.startsWith("{"))).toBe(true);
  expect(lines.at(-1)).toContain('"b"');
});

it("checkStop reads the transcript; one it can't read blocks nothing", async () => {
  const file = join(tmp, "s.jsonl");
  writeFileSync(file, [prompt("修"), ...edit("/repo/src/a.ts")].join("\n"));
  expect((await checkStop("claude_code", { transcript_path: file, last_assistant_message: "已修复" })).block).toBe(true);
  expect(await checkStop("claude_code", { transcript_path: join(tmp, "missing.jsonl"), last_assistant_message: "已修复" })).toMatchObject({
    block: false,
    outcome: "unread",
  });
  expect((await checkStop("codex", { transcript_path: null, last_assistant_message: "看一下日志" })).outcome).toBe("no_claim");
});

it("heredoc edit scripts, flags before kubectl verbs, docs-only pushes", () => {
  const kinds = (c: string) => commandSteps(c, true, true).map((s) => s.kind);
  expect(kinds("python3 - <<'EOF'\np='src/a.py'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF")).toEqual(["edit"]);
  expect(kinds("python3 - <<'EOF'\nimport json\nprint(json.load(open('x.json')))\nEOF")).toEqual(["verify"]);
  expect(kinds("kubectl -n memento logs deploy/api --tail 50")).toEqual(["verify"]);
  expect(kinds("kubectl -n memento delete configmap api-hotfix")).toEqual(["ship"]);
  expect(kinds("git add CLAUDE.md docs/a.md && git commit -m x && git push")).toEqual(["other"]);
  expect(kinds("git add src/a.ts && git commit -m x && git push")).toEqual(["ship"]);
  expect(kinds("flutter test test/ui")).toEqual(["verify"]);
});
