import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyWorkspaceRequest,
  exportWorkspace,
  listPending,
  mirrorBase,
  mirrorHave,
  mirrorPatch,
  packPatch,
  prepareMirror,
  unpackPatch,
  WorkspaceError,
} from "../src/workspace.js";
import { finishWorkspace, flushPendingPatches, parseWorkspaceSpec, prepareWorkspace, toSourcePaths, type Relay } from "../src/workspace-sync.js";

const dirs: string[] = [];
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `mws-${name}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (dir: string, file: string, text: string | Buffer) => writeFileSync(join(dir, file), text);
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

/** A source repository: one commit, then an uncommitted edit and an untracked file. */
function sourceRepo(): string {
  const src = tmp("src");
  git(src, "init", "-q", "-b", "main");
  write(src, "a.txt", "one\n");
  write(src, "b.txt", "keep\n");
  write(src, ".gitignore", "node_modules/\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "init");
  write(src, "a.txt", "one\nuncommitted\n");
  write(src, "new.txt", "untracked\n");
  return src;
}

/** The server and the source device, in process: the relay the executor talks to. */
function fakeRelay(src: string, srcHome: string): Relay & { calls: string[] } {
  const bundles = new Map<string, { path: string; size: number }>();
  const calls: string[] = [];
  const relay = (async (op: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push(op);
    if (op === "export") {
      const r = await exportWorkspace(src, (body.have as string[]) ?? [], { env, home: srcHome });
      const token = r.upToDate ? "" : `t${bundles.size}`;
      if (token) bundles.set(token, { path: r.bundle, size: r.size });
      return {
        token,
        size: r.size,
        head: r.head,
        branch: r.branch,
        snapshot: r.snapshot,
        tree: r.tree,
        root: r.root,
        rel: r.rel,
        up_to_date: r.upToDate,
        upstream: r.upstream,
        user_name: r.userName,
        user_email: r.userEmail,
      };
    }
    if (op === "chunk") {
      const b = bundles.get(String(body.token))!;
      const length = Math.min(Number(body.length), b.size - Number(body.offset));
      const fh = await open(b.path, "r");
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, Number(body.offset));
      await fh.close();
      return { data_b64: buf.toString("base64"), bytes_read: length };
    }
    if (op === "apply") return (await applyWorkspaceRequest(src, body, { env, home: srcHome })).reply;
    throw new Error(`unknown op ${op}`);
  }) as Relay & { calls: string[] };
  relay.calls = calls;
  return relay;
}

const spec = (src: string) => parseWorkspaceSpec({ source_device_id: "tok-mac", source_path: src, source_name: "Mac" })!;

describe("workspace on another device", () => {
  it("brings the source's working tree over, uncommitted and untracked files included, and the changes back", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, srcHome);
    const events: Record<string, unknown>[] = [];

    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome, emit: (e) => events.push(e) });
    const w = run.mirror.workDir;
    expect(read(w, "a.txt")).toBe("one\nuncommitted\n");
    expect(read(w, "new.txt")).toBe("untracked\n");
    // Same git state as on the source: on main, the edit uncommitted, the new file untracked
    expect(git(w, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(w, "status", "--porcelain")).toBe("M a.txt\n?? new.txt");
    expect(events[0]).toMatchObject({ kind: "workspace", status: "synced", source: "Mac", branch: "main" });

    // The agent edits, deletes, adds (a binary file too) and even commits
    write(w, "a.txt", "one\nuncommitted\nagent\n");
    rmSync(join(w, "b.txt"));
    write(w, "img.bin", Buffer.from([0, 1, 2, 255, 254, 0]));
    git(w, "add", "-A");
    git(w, "commit", "-q", "-m", "agent work");

    const out = await finishWorkspace(run, "1234abcd-0000", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(read(src, "a.txt")).toBe("one\nuncommitted\nagent\n");
    expect(existsSync(join(src, "b.txt"))).toBe(false);
    expect([...readFileSync(join(src, "img.bin"))]).toEqual([0, 1, 2, 255, 254, 0]);
    // The commit came along as it was made: on the branch, nothing left uncommitted or staged
    expect(git(src, "log", "--format=%s|%an", "-n", "1")).toBe("agent work|t");
    expect(git(src, "status", "--porcelain")).toBe("");
    expect(out).toMatchObject({ committed: "branch", commit_branch: "main" });
    expect(out.commits?.map((c) => c.subject)).toEqual(["agent work"]);
    expect(out.files?.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["A img.bin", "D b.txt", "M a.txt"]);
    expect(out.patch_path && existsSync(out.patch_path)).toBeTruthy();
  });

  it("sends only what the executor lacks the next time, and nothing when nothing changed", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, srcHome);

    const first = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const firstRoot = first.mirror.root;
    expect((await finishWorkspace(first, "t1", "apply", relay, { env, home: exeHome })).status).toBe("unchanged");
    expect(await mirrorHave(mirrorBase("tok-mac", src, exeHome), env)).toContain(first.mirror.snapshot);

    // Same working tree: same snapshot, no bundle at all
    relay.calls.length = 0;
    const again = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(relay.calls).toEqual(["export"]);
    expect(again.mirror.root).toBe(firstRoot);
    again.release();

    // A new commit on the source: the clone gets it and keeps ignored files (node_modules) of the last run
    write(again.mirror.root, "node_modules", "");
    rmSync(join(again.mirror.root, "node_modules"));
    execFileSync("mkdir", ["-p", join(again.mirror.root, "node_modules")]);
    write(join(again.mirror.root, "node_modules"), "dep.js", "x");
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", "second");
    const third = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(git(third.mirror.root, "log", "--format=%s")).toBe("second\ninit");
    expect(existsSync(join(third.mirror.root, "node_modules", "dep.js"))).toBe(true);
    expect(git(third.mirror.root, "status", "--porcelain")).toBe("");
    third.release();
  });

  it("keeps the changes on a branch instead of overwriting files the user changed meanwhile", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, srcHome);

    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "a.txt", "agent rewrote it\n");
    // Meanwhile on the source
    write(src, "a.txt", "the user rewrote it\n");

    const out = await finishWorkspace(run, "feedbeef-1", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("conflict");
    expect(out.branch).toBe("memento/feedbeef");
    expect(read(src, "a.txt")).toBe("the user rewrote it\n");
    // The branch holds the agent's result on top of the source's HEAD
    expect(git(src, "show", "memento/feedbeef:a.txt")).toBe("agent rewrote it");
    expect(git(src, "rev-parse", "memento/feedbeef^")).toBe(git(src, "rev-parse", "HEAD"));
  });

  it("only keeps the patch of a task that failed or was stopped", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, srcHome);

    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "b.txt", "half done\n");
    const out = await finishWorkspace(run, "abad1dea", "save", relay, { env, home: exeHome });
    expect(out.status).toBe("saved");
    expect(read(src, "b.txt")).toBe("keep\n");
    expect(out.files?.map((f) => f.path)).toEqual(["b.txt"]);
    // The kept patch applies by hand
    git(src, "apply", out.patch_path!);
    expect(read(src, "b.txt")).toBe("half done\n");
  });

  it("queues the patch while the source is offline and delivers it once it is back", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, srcHome);

    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "a.txt", "offline edit\n");
    const offline: Relay = async () => {
      throw new WorkspaceError("Mac 不在线", "source_unavailable");
    };
    const out = await finishWorkspace(run, "cafe0001", "apply", offline, { env, home: exeHome });
    expect(out.status).toBe("pending");
    expect(await listPending(exeHome)).toHaveLength(1);
    expect(read(src, "a.txt")).toBe("one\nuncommitted\n");

    expect(await flushPendingPatches(offline, () => {}, exeHome)).toBe(0);
    expect(await listPending(exeHome)).toHaveLength(1);
    expect(await flushPendingPatches(relay, () => {}, exeHome)).toBe(1);
    expect(read(src, "a.txt")).toBe("offline edit\n");
    expect(await listPending(exeHome)).toHaveLength(0);
  });

  it("runs the agent in the subdirectory the task was sent to", async () => {
    const src = sourceRepo();
    execFileSync("mkdir", ["-p", join(src, "pkg", "lib")]);
    write(join(src, "pkg", "lib"), "x.ts", "export {}\n");
    const exeHome = tmp("exehome");
    const relay = fakeRelay(join(src, "pkg"), tmp("srchome"));
    const run = await prepareWorkspace(spec(join(src, "pkg")), relay, { env, home: exeHome });
    expect(run.mirror.workDir).toBe(join(run.mirror.root, "pkg"));
    expect(read(run.mirror.workDir, "lib/x.ts")).toBe("export {}\n");
    run.release();
  });

  it("gives a second task on the same directory a clone of its own", async () => {
    const src = sourceRepo();
    const exeHome = tmp("exehome");
    const relay = fakeRelay(src, tmp("srchome"));
    const a = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const b = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(b.mirror.root).not.toBe(a.mirror.root);
    a.release();
    b.release();
    const c = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(c.mirror.root).toBe(a.mirror.root);
    c.release();
  });

  it("says what is wrong with a directory it can't take", async () => {
    const home = tmp("home");
    const plain = tmp("plain");
    await expect(exportWorkspace(plain, [], { env, home })).rejects.toMatchObject({ code: "not_git" });
    git(plain, "init", "-q");
    await expect(exportWorkspace(plain, [], { env, home })).rejects.toMatchObject({ code: "no_commit" });
    await expect(exportWorkspace(join(plain, "nope"), [], { env, home })).rejects.toMatchObject({ code: "not_found" });
  });

  it("packs patches losslessly", async () => {
    const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x00, 0xff]);
    expect([...(await unpackPatch(await packPatch(bytes)))]).toEqual([...bytes]);
  });

  it("refetches everything when the clone lacks the commits the bundle builds on", async () => {
    const src = sourceRepo();
    const exeHome = tmp("exehome");
    const inner = fakeRelay(src, tmp("srchome"));
    const head = git(src, "rev-parse", "HEAD");
    let first = true;
    // The first ask claims a commit the (empty) clone doesn't hold: the bundle leaves it out and can't be fetched
    const relay: Relay = (op, body, t) => {
      if (op === "export" && first) {
        first = false;
        return inner(op, { ...body, have: [head] }, t);
      }
      return inner(op, body, t);
    };
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(inner.calls.filter((c) => c === "export")).toHaveLength(2);
    expect(read(run.mirror.workDir, "a.txt")).toBe("one\nuncommitted\n");
    run.release();
  });

  it("prepareMirror refuses a snapshot it doesn't hold", async () => {
    const base = tmp("base");
    await expect(
      prepareMirror(base, { head: "a".repeat(40), branch: "", snapshot: "b".repeat(40), tree: "c".repeat(40), root: "/x/repo", rel: "", upToDate: true }, undefined, { env }),
    ).rejects.toMatchObject({ code: "missing_base" });
  });

  it("mirrorPatch is empty when the agent changed nothing", async () => {
    const src = sourceRepo();
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), fakeRelay(src, tmp("srchome")), { env, home: exeHome });
    const p = await mirrorPatch(run.mirror, { env, home: exeHome });
    expect(p.patch.length).toBe(0);
    run.release();
  });
});

/** A source whose main tracks a remote (a bare repository standing in for GitHub). */
function trackedRepo(): { src: string; remote: string } {
  const src = sourceRepo();
  const remote = tmp("remote");
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(src, "remote", "add", "origin", remote);
  git(src, "push", "-q", "-u", "origin", "main");
  return { src, remote };
}

/** Someone else (CI, say) pushes a commit to the remote meanwhile. */
function remoteCommit(remote: string, file: string, text: string): void {
  const other = tmp("other");
  git(other, "clone", "-q", remote, ".");
  write(other, file, text);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", `ci: ${file}`);
  git(other, "push", "-q", "origin", "main");
}

describe("the agent's commits and pushes", () => {
  it("lands the commits on the source's branch as they were made, leaving the user's edits uncommitted", async () => {
    const src = sourceRepo();
    git(src, "config", "user.name", "董");
    git(src, "config", "user.email", "me@example.com");
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const w = run.mirror.workDir;
    // Commits as the user on the source
    expect(git(w, "config", "user.name")).toBe("董");
    write(w, "x.txt", "one\n");
    git(w, "add", "x.txt");
    git(w, "commit", "-q", "-m", "feat: 第一个", "-m", "正文");
    write(w, "x.txt", "one\ntwo\n");
    git(w, "add", "x.txt");
    git(w, "commit", "-q", "-m", "fix: 第二个");
    write(w, "y.txt", "not committed\n");

    const out = await finishWorkspace(run, "c0ffee01-aaaa", "apply", relay, { env, home: exeHome });
    expect(out).toMatchObject({ status: "applied", committed: "branch", commit_branch: "main" });
    expect(out.commits?.map((c) => c.subject)).toEqual(["fix: 第二个", "feat: 第一个"]);
    expect(git(src, "log", "--format=%s", "-n", "2", "main")).toBe("fix: 第二个\nfeat: 第一个");
    expect(git(src, "log", "--format=%b", "-n", "1", "main~1")).toBe("正文");
    expect(git(src, "rev-parse", "main")).toBe(git(w, "rev-parse", "HEAD"));
    // Only what was uncommitted before (and the agent left uncommitted) shows as such
    expect(git(src, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? new.txt", "?? y.txt", "M a.txt"]);
    expect(git(src, "diff", "--cached", "--name-only")).toBe("");
    expect(out.push).toBeUndefined();
  });

  it("keeps the commits on a memento/ branch when the source's HEAD moved meanwhile", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "-m", "agent");
    git(run.mirror.workDir, "push", "-q");
    write(src, "z.txt", "user\n");
    git(src, "add", "z.txt");
    git(src, "commit", "-q", "-m", "user meanwhile");

    const out = await finishWorkspace(run, "beef0002", "apply", relay, { env, home: exeHome });
    expect(out).toMatchObject({ status: "applied", committed: "kept", commit_branch: "memento/beef0002" });
    expect(git(src, "log", "--format=%s", "-n", "1", "main")).toBe("user meanwhile");
    expect(git(src, "log", "--format=%s", "-n", "1", "memento/beef0002")).toBe("agent");
    expect(read(src, "x.txt")).toBe("agent\n");
    expect(out.push?.status).toBe("skipped");
  });

  it("pushes from the source when the agent pushed to the clone's stand-in remote", async () => {
    const { src, remote } = trackedRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const w = run.mirror.workDir;
    expect(git(w, "status", "-sb").split("\n")[0]).toBe("## main...origin/main");
    write(w, "x.txt", "agent\n");
    git(w, "add", "x.txt");
    git(w, "commit", "-q", "-m", "feat: 推送");
    git(w, "push", "-q");

    const out = await finishWorkspace(run, "abad0003", "apply", relay, { env, home: exeHome });
    expect(out.push).toEqual({ status: "pushed", remote: "origin", branch: "main" });
    expect(git(remote, "log", "--format=%s", "-n", "1", "main")).toBe("feat: 推送");
    expect(git(remote, "rev-parse", "main")).toBe(git(src, "rev-parse", "main"));
  });

  it("puts the commits on top of what the remote got meanwhile, then pushes", async () => {
    const { src, remote } = trackedRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const w = run.mirror.workDir;
    write(w, "x.txt", "agent\n");
    git(w, "add", "x.txt");
    git(w, "commit", "-q", "-m", "feat: 变基");
    git(w, "push", "-q");
    remoteCommit(remote, "deploy.txt", "tag 2\n");

    const out = await finishWorkspace(run, "abad0004", "apply", relay, { env, home: exeHome });
    expect(out.push).toMatchObject({ status: "pushed", rebased: 1 });
    expect(git(remote, "log", "--format=%s", "main")).toBe("feat: 变基\nci: deploy.txt\ninit");
    expect(git(src, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
    expect(out.commits?.[0]?.sha).toBe(git(src, "rev-parse", "main"));
    // The remote's file is here too; the user's edits are as they were
    expect(read(src, "deploy.txt")).toBe("tag 2\n");
    expect(git(src, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? new.txt", "M a.txt"]);
    expect(git(src, "diff", "--cached", "--name-only")).toBe("");
  });

  it("doesn't rebase over files the user is editing, and says so", async () => {
    const { src, remote } = trackedRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "-m", "feat: x");
    git(run.mirror.workDir, "push", "-q");
    remoteCommit(remote, "a.txt", "ci edit\n");

    const out = await finishWorkspace(run, "abad0005", "apply", relay, { env, home: exeHome });
    expect(out.push?.status).toBe("rejected");
    expect(out.push?.detail).toContain("a.txt");
    expect(out.committed).toBe("branch");
    expect(read(src, "a.txt")).toBe("one\nuncommitted\n");
    expect(git(remote, "log", "--format=%s", "-n", "1", "main")).toBe("ci: a.txt");
  });

  it("pushes commits the source already had when the agent only pushed", async () => {
    const { src, remote } = trackedRepo();
    write(src, "local.txt", "x\n");
    git(src, "add", "local.txt");
    git(src, "commit", "-q", "-m", "local, not pushed");
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(git(run.mirror.workDir, "status", "-sb").split("\n")[0]).toBe("## main...origin/main [ahead 1]");
    git(run.mirror.workDir, "push", "-q");

    const out = await finishWorkspace(run, "abad0006", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(out.push?.status).toBe("pushed");
    expect(git(remote, "log", "--format=%s", "-n", "1", "main")).toBe("local, not pushed");
  });

  it("only files come back when the agent rewrote history or switched branches", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    git(run.mirror.workDir, "switch", "-q", "-c", "feat");
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "-m", "on feat");

    const out = await finishWorkspace(run, "abad0007", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(out.commits_error).toContain("feat");
    expect(read(src, "x.txt")).toBe("agent\n");
    expect(git(src, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("queues the commits with the patch while the source is offline", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "-m", "offline commit");
    const offline: Relay = async () => {
      throw new WorkspaceError("Mac 不在线", "source_unavailable");
    };
    expect((await finishWorkspace(run, "abad0008", "apply", offline, { env, home: exeHome })).status).toBe("pending");
    expect((await listPending(exeHome))[0]?.commits?.head).toBeTruthy();

    expect(await flushPendingPatches(relay, () => {}, exeHome)).toBe(1);
    expect(git(src, "log", "--format=%s", "-n", "1")).toBe("offline commit");
    expect(await listPending(exeHome)).toHaveLength(0);
  });

  it("keeps the commits of a task that failed on a branch, touching nothing else", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "-m", "half");
    const out = await finishWorkspace(run, "abad0009", "save", relay, { env, home: exeHome });
    expect(out).toMatchObject({ status: "saved", committed: "kept", commit_branch: "memento/abad0009" });
    expect(existsSync(join(src, "x.txt"))).toBe(false);
    expect(git(src, "log", "--format=%s", "-n", "1", "memento/abad0009")).toBe("half");
  });
});

describe("toSourcePaths", () => {
  const clone = "/home/opc/.memento/workspaces/785722bc73d2/proj";

  it("points the answer's paths and links at the source's directory", () => {
    const text = `已改 [calc.py](file://${clone}/calc.py#L5-L6)，见 ${clone}/src/a.ts 和 \`${clone}\``;
    expect(toSourcePaths(text, clone, "/Users/me/dev/proj")).toBe(
      "已改 [calc.py](file:///Users/me/dev/proj/calc.py#L5-L6)，见 /Users/me/dev/proj/src/a.ts 和 `/Users/me/dev/proj`",
    );
  });

  it("gives a Windows source forward slashes and a file:/// link", () => {
    const text = `[calc.py](file://${clone}/calc.py) ${clone}/lib/b.py`;
    expect(toSourcePaths(text, `${clone}/`, "C:\\Users\\Admin\\dev\\proj")).toBe(
      "[calc.py](file:///C:/Users/Admin/dev/proj/calc.py) C:/Users/Admin/dev/proj/lib/b.py",
    );
  });

  it("leaves paths that only start the same and text without the clone alone", () => {
    expect(toSourcePaths(`${clone}2/x.py`, clone, "/src")).toBe(`${clone}2/x.py`);
    expect(toSourcePaths("nothing here", clone, "/src")).toBe("nothing here");
    expect(toSourcePaths("/x", "/", "/src")).toBe("/x");
  });
});
