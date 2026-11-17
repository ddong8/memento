import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cancelSourceExec, checkDir, executorDenyReason, readOnSource, executorOnlyEdits, execOnSource, relCwd, SourceExecBridge, sourceExecHint } from "../src/source-exec.js";
import { packPatch } from "../src/workspace.js";
import type { WorkspaceRun } from "../src/workspace-sync.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

/** The user's repository on the source: a.txt committed, node_modules and .env ignored and present. */
function sourceRepo() {
  const root = mkdtempSync(join(tmpdir(), "src-repo-"));
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.env\ndist/\n");
  writeFileSync(join(root, "a.txt"), "one\n");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.txt"), "b\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "installed\n");
  writeFileSync(join(root, ".env"), "SECRET=here\n");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "out.js"), "built\n");
  return { root, snapshot: git(root, "rev-parse", "HEAD") };
}

/** a.txt changed the way the agent would on the executor, as the patch it sends. */
function patchOf(root: string, text: string): Buffer {
  const before = readFileSync(join(root, "a.txt"));
  writeFileSync(join(root, "a.txt"), text);
  const patch = execFileSync("git", ["diff", "--binary"], { cwd: root, env });
  writeFileSync(join(root, "a.txt"), before);
  return patch;
}

describe("the agent's commands on the device the code is on", () => {
  it("a slow command takes one checkout; other commands, of any task, run beside it in another", async () => {
    if (process.platform === "win32") return;
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Like a scan of the home folder that ran for 10 minutes and held every later command
    const slow = execOnSource(root, { snapshot, rel: "", command: "sleep 60", task_id: "A", exec_id: "a1" }, { home, env });
    await pause(1500);
    const started = Date.now();
    const sameTask = await execOnSource(root, { snapshot, rel: "", command: "echo a-again", task_id: "A", exec_id: "a2" }, { home, env });
    const otherTask = await execOnSource(root, { snapshot, rel: "", command: "echo b-ran", task_id: "B", exec_id: "b1" }, { home, env });
    expect(sameTask.stdout).toContain("a-again");
    expect(otherTask.stdout).toContain("b-ran");
    expect(otherTask.stderr).not.toContain("等了");
    expect(Date.now() - started).toBeLessThan(15_000);

    // Stopping task A kills its slow command, and a command it still sends is not run
    expect(cancelSourceExec("A")).toBe(1);
    const h = await slow;
    expect(h.exit_code).not.toBe(0);
    expect(h.stderr).toContain("任务已停止");
    const late = await execOnSource(root, { snapshot, rel: "", command: "echo should-not-run", task_id: "A", exec_id: "a3" }, { home, env });
    expect(late.exit_code).toBe(130);
    expect(late.stdout).toBe("");
  }, 30_000);

  it("get finds a file a task's command made in whichever checkout it ran in", async () => {
    if (process.platform === "win32") return;
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // Task C's command runs in a spare checkout because D's holds the first one
    const busy = execOnSource(root, { snapshot, rel: "", command: "sleep 5", task_id: "D", exec_id: "d1" }, { home, env });
    await pause(1000);
    const made = await execOnSource(root, { snapshot, rel: "", command: "echo shot > out.txt", task_id: "C", exec_id: "c1" }, { home, env });
    expect(made.exit_code).toBe(0);
    const got = await readOnSource(root, { file: "out.txt", rel: "", task_id: "C" }, { home, env });
    expect(Buffer.from(got.data_b64, "base64").toString()).toBe("shot\n");
    expect(got.path).not.toBe(join(checkDir(realpathSync(root), home), "out.txt"));
    // An old executor sends no task id: the newest copy in any checkout
    const anyCopy = await readOnSource(root, { file: "out.txt", rel: "" }, { home, env });
    expect(anyCopy.path).toBe(got.path);
    await busy;
  }, 30_000);

  it("a timed-out command's children die with it and don't hold up the queue by keeping its output open", async () => {
    if (process.platform === "win32") return;
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    // Like `brew list | grep x; find ~ -name x`: the shell's children, not the shell, are what hang
    const marker = `held-${Date.now()}`;
    const started = Date.now();
    const slow = await execOnSource(root, { snapshot, rel: "", command: `sleep 120 | cat; echo ${marker}`, timeout_ms: 1500, task_id: "D", exec_id: "d1" }, { home, env });
    expect(slow.exit_code).toBe(124);
    const next = await execOnSource(root, { snapshot, rel: "", command: "echo after", task_id: "E", exec_id: "e1" }, { home, env });
    expect(next.stdout).toContain("after");
    expect(Date.now() - started).toBeLessThan(15_000);
    // Nothing of it is left running
    await new Promise((r) => setTimeout(r, 1500));
    const left = execFileSync("sh", ["-c", "ps -Ao command | grep 'sleep 120' | grep -v grep || true"], { encoding: "utf8" });
    expect(left.trim()).toBe("");
  }, 30_000);

  it("giving up on one command stops just that one; the task's next command still runs", async () => {
    if (process.platform === "win32") return;
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    const hung = execOnSource(root, { snapshot, rel: "", command: "sleep 60", task_id: "C", exec_id: "c1" }, { home, env });
    await new Promise((r) => setTimeout(r, 1500));
    expect(cancelSourceExec("C", "c1")).toBe(1);
    expect((await hung).exit_code).not.toBe(0);
    const next = await execOnSource(root, { snapshot, rel: "", command: "echo next", task_id: "C", exec_id: "c2" }, { home, env });
    expect(next.exit_code).toBe(0);
    expect(next.stdout).toContain("next");
  }, 30_000);

  it("run on the snapshot plus the agent's changes, in a checkout of their own, with dependencies linked in", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    const patch_b64 = await packPatch(patchOf(root, "two\n"));
    const r = await execOnSource(root, { snapshot, patch_b64, rel: "", command: "cat a.txt; cat node_modules/dep/index.js; cat .env; pwd; ls dist 2>&1 || true" }, { home, env });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("two");
    expect(r.stdout).toContain("installed");
    expect(r.stdout).toContain("SECRET=here");
    expect(r.stdout).toContain(checkDir(realpathSync(root), home));
    // Build output isn't linked: a build there doesn't write into the user's checkout
    expect(r.stdout).not.toContain("out.js");
    // The user's working tree is untouched
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(git(root, "status", "--porcelain")).toBe("");

    // Each run starts from the snapshot again; the exit code comes back; a subfolder works
    const again = await execOnSource(root, { snapshot, rel: "sub", command: "cat ../a.txt; cat b.txt; exit 3" }, { home, env });
    expect(again.exit_code).toBe(3);
    expect(again.stdout).toBe("one\nb\n");
  }, 30_000);

  it("refuses paths out of the repository, an unknown snapshot, and a patch that doesn't apply", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    await expect(execOnSource(root, { snapshot, rel: "../x", command: "ls" }, { home, env })).rejects.toThrow(/工作目录不对/);
    await expect(execOnSource(root, { snapshot: "f".repeat(40), command: "ls" }, { home, env })).rejects.toThrow(/找不到同步时的快照/);
    const bad = await packPatch(Buffer.from("diff --git a/zz.txt b/zz.txt\n--- a/zz.txt\n+++ b/zz.txt\n@@ -1 +1 @@\n-nope\n+x\n"));
    await expect(execOnSource(root, { snapshot, patch_b64: bad, command: "ls" }, { home, env })).rejects.toThrow(/打不上/);
  }, 30_000);

  it("the working directory maps to the same place in the repository", () => {
    const mirror = { root: "/ws/repo", workDir: "/ws/repo/app" };
    expect(relCwd(mirror, "/ws/repo/app/src")).toBe("app/src");
    expect(relCwd(mirror, "/ws/repo")).toBe("");
    expect(relCwd(mirror, "/tmp")).toBe("app");
    expect(relCwd(mirror, "")).toBe("app");
  });

  it("memento-source on the executor sends the agent's changes and prints what the command printed, with its exit code", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "exec-home-"));
    // The executor's clone, changed by the agent
    const mirrorRoot = join(mkdtempSync(join(tmpdir(), "mirror-")), "repo");
    execFileSync("git", ["clone", "-q", root, mirrorRoot], { env });
    writeFileSync(join(mirrorRoot, "a.txt"), "changed on the executor\n");
    const run = {
      spec: { sourceDeviceId: "mac", sourcePath: root, sourceName: "Mac" },
      mirror: { root: mirrorRoot, workDir: mirrorRoot, baseTree: git(mirrorRoot, "rev-parse", "HEAD^{tree}"), snapshot, head: snapshot, branch: "main" },
      release: () => {},
    } as unknown as WorkspaceRun;
    const events: Array<Record<string, unknown>> = [];
    const sourceHome = mkdtempSync(join(tmpdir(), "src-home-"));
    // The server and the source behind it
    const bridge = new SourceExecBridge(
      () => async (op, body) => (op === "exec" ? ((await execOnSource(String(body.path), body, { home: sourceHome, env })) as unknown as Record<string, unknown>) : { error: op }),
      (_t, e) => events.push(e),
      home,
    );
    const cli = await bridge.register("task-1", run);
    expect(cli).not.toBeNull();
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(cli!.command, ["cat a.txt && echo oops >&2 && exit 5"], { cwd: mirrorRoot, env: { ...env, MEMENTO_SOURCE_URL: cli!.url } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (b) => (stdout += b));
      child.stderr.on("data", (b) => (stderr += b));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    expect(out).toEqual({ code: 5, stdout: "changed on the executor\n", stderr: "oops\n" });
    expect(events.map((e) => e.status)).toEqual(["running", "done"]);
    expect(events[1]).toMatchObject({ kind: "source_exec", exit_code: 5, source: "Mac" });
    // Gone with the task: the URL answers nothing any more
    bridge.unregister("task-1");
    const after = await fetch(cli!.url, { method: "POST", body: "{}" });
    expect(after.status).toBe(404);
    bridge.dispose();
  }, 30_000);
});

describe("the executor only edits code", () => {
  it("turns down tests, builds, installs, commits and pushes run there, and lets memento-source and reading through", () => {
    for (const cmd of [
      "npm test",
      "cd apps/web && npx tsc --noEmit",
      "pnpm install",
      "./server/.venv/bin/pytest server/tests -q",
      "uv run pytest",
      "python -m pytest -x",
      "pip install requests",
      "git commit -am x",
      "git -C repo push origin main",
      "cargo test",
      "xcodebuild -scheme App archive",
      "./gradlew assembleRelease",
      "FOO=1 make build",
      "adb devices",
      "python3 test_calc.py",
      "ls && cat calc.py && python3 test_calc.py",
      "node scripts/build.mjs --prod",
      "./gradlew build",
      "bash deploy.sh",
      "java -jar app.jar",
    ]) {
      expect(executorOnlyEdits(cmd), cmd).toBeTruthy();
    }
    for (const cmd of [
      'memento-source "npm test"',
      "cd app && /home/opc/.memento/bin/memento-source commit -m x",
      "git status",
      "git diff HEAD~1",
      "git log --oneline -5",
      "rg makefile src",
      "cat package.json",
      "ls node_modules",
      'echo "make sure tests pass"',
      "sed -n 1,40p src/make.ts",
      'python3 -c "print(1)"',
      "node -e 'console.log(1)'",
      "cat ./calc.py",
      "grep -n add calc.py",
    ]) {
      expect(executorOnlyEdits(cmd), cmd).toBeUndefined();
    }
    const why = executorDenyReason("测试、构建和运行", "/h/.memento/bin/memento-source", "Mac mini");
    expect(why).toContain("Mac mini");
    expect(why).toContain('/h/.memento/bin/memento-source commit -m "说明"');
  });

  it("tells the agent where everything but editing happens", () => {
    const hint = sourceExecHint("/h/bin/memento-source", "Mac mini");
    for (const s of ["只用来读和改代码", "TestFlight", "commit -m", "--push", "get <文件>", "已拦截"]) expect(hint).toContain(s);
  });
});

describe("files the agent's commands make on the source", () => {
  it("stay there for get across commands, while files the last patch added are taken away", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    // A patch adding new.txt, and a command that writes a screenshot next to it
    writeFileSync(join(root, "new.txt"), "added by the agent\n");
    execFileSync("git", ["add", "-N", "new.txt"], { cwd: root, env });
    const added = await packPatch(execFileSync("git", ["diff", "--binary"], { cwd: root, env }));
    execFileSync("git", ["rm", "-q", "--cached", "new.txt"], { cwd: root, env });
    const first = await execOnSource(root, { snapshot, patch_b64: added, command: "cat new.txt && echo png > shot.png" }, { home, env });
    expect(first.exit_code).toBe(0);
    // The next command without that patch: new.txt is gone, the screenshot isn't
    const next = await execOnSource(root, { snapshot, command: "ls" }, { home, env });
    expect(next.stdout).toContain("shot.png");
    expect(next.stdout).not.toContain("new.txt");
    const got = await readOnSource(root, { file: "shot.png", rel: "" }, { home, env });
    expect(Buffer.from(got.data_b64, "base64").toString()).toBe("png\n");
  });
});

describe("the source's checkout", () => {
  it("starts over when the repository was deleted and created again at the same path", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    expect((await execOnSource(root, { snapshot, command: "cat a.txt" }, { home, env })).stdout).toBe("one\n");
    // Gone and back: same path, a new repository (the old checkout points at metadata that no longer exists)
    rmSync(join(root, ".git"), { recursive: true, force: true });
    git(root, "init", "-q");
    writeFileSync(join(root, "a.txt"), "again\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-q", "-m", "again");
    const again = await execOnSource(root, { snapshot: git(root, "rev-parse", "HEAD"), command: "cat a.txt" }, { home, env });
    expect(again).toMatchObject({ exit_code: 0, stdout: "again\n" });
  });
});

