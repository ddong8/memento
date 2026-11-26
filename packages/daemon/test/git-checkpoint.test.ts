import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  TurnCheckpoint,
  deliverGitChanges,
  getGitDiff,
  parseUnifiedDiff,
  restoreGitCheckpoint,
} from "../src/git-checkpoint.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=test@memento.local", "-c", "user.name=MementoTest", ...args], {
    cwd,
    encoding: "utf8",
  });

let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "memento-git-cp-"));
  repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const v = 1;\nexport const keep = true;\n");
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "chore: init");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("git-checkpoint", () => {
  it("captures hidden refs on tracked + untracked edits without touching HEAD or branches", async () => {
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const cp = await TurnCheckpoint.start(repo, "task-cp-001");
    expect(cp).not.toBeNull();

    writeFileSync(join(repo, "src", "app.ts"), "export const v = 2;\nexport const keep = true;\n");
    writeFileSync(join(repo, "src", "new-file.ts"), "export const added = 42;\n");

    const ev = await cp!.finish();
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe("checkpoint");
    expect(ev!.status).toBe("created");
    expect(ev!.branch).toBe("main");
    expect(ev!.before_ref.startsWith("refs/memento/checkpoints/")).toBe(true);
    expect(ev!.after_ref.startsWith("refs/memento/checkpoints/")).toBe(true);
    expect(ev!.files_changed).toBe(2);
    expect(ev!.insertions).toBe(2);
    expect(ev!.deletions).toBe(1);

    // HEAD and branches must remain completely untouched
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(repo, "branch", "--list").trim()).toBe("* main");

    // Diff between checkpoint before/after refs renders both tracked & new file
    const diff = await getGitDiff({ cwd: repo, baseRef: ev!.before_ref, targetRef: ev!.after_ref });
    expect(diff.ok).toBe(true);
    expect(diff.total_files).toBe(2);
    expect(diff.files?.map((f) => f.path).sort()).toEqual(["src/app.ts", "src/new-file.ts"]);
    expect(diff.checkpoints?.some((c) => c.id === ev!.id)).toBe(true);
    expect(diff.recent_commits?.length).toBeGreaterThanOrEqual(1);
    expect(diff.recent_commits?.[0]?.subject).toBe("chore: init");

    // Root commit inspection works with empty baseRef + commit targetRef
    const rootCommit = diff.recent_commits![0]!;
    const commitDiff = await getGitDiff({ cwd: repo, baseRef: rootCommit.parent_sha, targetRef: rootCommit.sha });
    expect(commitDiff.ok).toBe(true);
    expect(commitDiff.total_files).toBe(2);
  });

  it("drops hidden refs cleanly when a turn makes no file changes", async () => {
    const cp = await TurnCheckpoint.start(repo, "task-noop");
    expect(cp).not.toBeNull();
    const ev = await cp!.finish();
    expect(ev).toBeNull();
    const refs = git(repo, "for-each-ref", "refs/memento/checkpoints/").trim();
    expect(refs).toBe("");
  });

  it("includes live working-tree tracked edits AND untracked files in getGitDiff", async () => {
    writeFileSync(join(repo, "src", "app.ts"), "export const v = 99;\nexport const keep = true;\n");
    writeFileSync(join(repo, "notes-中文.md"), "第一行\n第二行\n");

    const diff = await getGitDiff({ cwd: repo });
    expect(diff.ok).toBe(true);
    expect(diff.is_dirty).toBe(true);
    const paths = (diff.files ?? []).map((f) => f.path).sort();
    expect(paths).toEqual(["notes-中文.md", "src/app.ts"]);
    const untracked = diff.files?.find((f) => f.path === "notes-中文.md");
    expect(untracked?.status).toBe("A");
    expect(untracked?.additions).toBe(2);
    expect(untracked?.hunks[0]?.lines.map((l) => l.content)).toEqual(["第一行", "第二行"]);
  });

  it("safely restores modified, deleted, and newly created files to a hidden checkpoint while creating a safety backup", async () => {
    const headBefore = git(repo, "rev-parse", "HEAD").trim();
    const cp = await TurnCheckpoint.start(repo, "task-revert-01");
    expect(cp).not.toBeNull();

    // Agent modifies one file, deletes another, and creates a brand-new file
    writeFileSync(join(repo, "src", "app.ts"), "export const v = 999;\n");
    rmSync(join(repo, "README.md"));
    writeFileSync(join(repo, "src", "temp-generated.ts"), "console.log('oops');\n");

    const ev = await cp!.finish();
    expect(ev).not.toBeNull();

    const restored = await restoreGitCheckpoint({ cwd: repo, targetRef: ev!.before_ref });
    expect(restored.ok).toBe(true);
    expect(restored.backup_ref?.startsWith("refs/memento/checkpoints/revert-")).toBe(true);
    expect(restored.files_removed).toBe(1);
    expect(restored.files_restored).toBe(2);

    // Original files are restored, new file removed, HEAD & branch untouched
    expect(readFileSync(join(repo, "src", "app.ts"), "utf8")).toBe("export const v = 1;\nexport const keep = true;\n");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# Demo\n");
    expect(existsSync(join(repo, "src", "temp-generated.ts"))).toBe(false);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(headBefore);
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("rejects non-checkpoint refs and shell-like injection in restoreGitCheckpoint", async () => {
    const bad1 = await restoreGitCheckpoint({ cwd: repo, targetRef: "HEAD~1" });
    expect(bad1.ok).toBe(false);
    const bad2 = await restoreGitCheckpoint({ cwd: repo, targetRef: "refs/memento/checkpoints/a;rm -rf /" });
    expect(bad2.ok).toBe(false);
  });

  it("commits selected files and pushes to a remote via deliverGitChanges", async () => {
    const bare = join(tmp, "origin.git");
    mkdirSync(bare);
    git(bare, "init", "--bare", "-q");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "config", "user.email", "dev@memento.local");
    git(repo, "config", "user.name", "MementoDev");

    writeFileSync(join(repo, "src", "app.ts"), "export const v = 3;\nexport const keep = true;\n");
    writeFileSync(join(repo, "scratch.txt"), "do not stage\n");

    const delivered = await deliverGitChanges({
      cwd: repo,
      message: "feat: bump version to 3",
      files: ["src/app.ts"],
      push: true,
    });
    expect(delivered.ok).toBe(true);
    expect(delivered.pushed).toBe(true);
    expect(delivered.commit_sha).toBeTruthy();

    // Only src/app.ts was committed; scratch.txt remains untracked
    expect(git(repo, "status", "--porcelain").trim()).toBe("?? scratch.txt");
    const remoteHead = git(bare, "rev-parse", "refs/heads/main").trim();
    expect(remoteHead).toBe(delivered.commit_sha);
  });

  it("parses unified diffs with line numbers accurately", () => {
    const raw = [
      "diff --git a/foo.ts b/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old2",
      "+new2",
      " line3",
    ].join("\n");
    const parsed = parseUnifiedDiff(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.additions).toBe(1);
    expect(parsed[0]!.deletions).toBe(1);
    expect(parsed[0]!.hunks[0]!.lines).toEqual([
      { type: "context", old_line: 1, new_line: 1, content: "line1" },
      { type: "del", old_line: 2, new_line: null, content: "old2" },
      { type: "add", old_line: null, new_line: 2, content: "new2" },
      { type: "context", old_line: 3, new_line: 3, content: "line3" },
    ]);
  });
});
