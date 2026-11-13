import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkDir, execOnSource, relCwd, SourceExecBridge } from "../src/source-exec.js";
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
  it("run on the snapshot plus the agent's changes, in a checkout of their own, with dependencies linked in", async () => {
    const { root, snapshot } = sourceRepo();
    const home = mkdtempSync(join(tmpdir(), "src-home-"));
    const patch_b64 = await packPatch(patchOf(root, "two\n"));
    const r = await execOnSource(root, { snapshot, patch_b64, rel: "", command: "cat a.txt; cat node_modules/dep/index.js; cat .env; pwd; ls dist 2>&1 || true" }, { home, env });
    expect(r.exit_code).toBe(0);
    expect(r.stdout).toContain("two");
    expect(r.stdout).toContain("installed");
    expect(r.stdout).toContain("SECRET=here");
    expect(r.stdout).toContain(checkDir(root, home));
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
