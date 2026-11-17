import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
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
import { commitOnSource, readOnSource, SourceExecBridge, writeOnSource } from "../src/source-exec.js";
import {
  finishWorkspace,
  flushPendingPatches,
  parseWorkspaceSpec,
  prepareWorkspace,
  toSourcePaths,
  type Relay,
  type WorkspaceRun,
} from "../src/workspace-sync.js";

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
        left_behind: r.leftBehind,
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
    if (op === "commit") return (await commitOnSource(src, body, { env, home: srcHome })) as unknown as Record<string, unknown>;
    if (op === "get") return readOnSource(src, body, { env, home: srcHome });
    if (op === "put") return writeOnSource(src, body, { env, home: srcHome });
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

    // The agent edits, deletes, adds (a binary file too) and commits, on the source
    write(w, "a.txt", "one\nuncommitted\nagent\n");
    rmSync(join(w, "b.txt"));
    write(w, "img.bin", Buffer.from([0, 1, 2, 255, 254, 0]));
    expect((await agentRuns(run, relay, exeHome, "1234abcd-0000", { action: "commit", message: "agent work" })).sha).toBeTruthy();

    const out = await finishWorkspace(run, "1234abcd-0000", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(read(src, "a.txt")).toBe("one\nuncommitted\nagent\n");
    expect(existsSync(join(src, "b.txt"))).toBe(false);
    expect([...readFileSync(join(src, "img.bin"))]).toEqual([0, 1, 2, 255, 254, 0]);
    // The commit is on the branch, made on the source as the user; the user's own untracked file stays out of it
    expect(git(src, "log", "--format=%s|%an", "-n", "1")).toBe("agent work|t");
    expect(git(src, "status", "--porcelain")).toBe("?? new.txt");
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

  it("leaves an untracked file too big to send on the source instead of failing, and says which", async () => {
    const src = sourceRepo();
    const big = "上海源叶产品目录 -非危化品.xlsx";
    write(src, big, "");
    truncateSync(join(src, big), 60 * 1024 * 1024); // sparse: instant, no real 60MB written
    const relay = fakeRelay(src, tmp("srchome"));
    const events: Record<string, unknown>[] = [];
    const run = await prepareWorkspace(spec(src), relay, { env, home: tmp("exehome"), emit: (e) => events.push(e) });
    const w = run.mirror.workDir;
    expect(existsSync(join(w, big))).toBe(false);
    expect(read(w, "new.txt")).toBe("untracked\n");
    expect(events[0]).toMatchObject({ status: "synced", left_behind: [{ path: big, size: 60 * 1024 * 1024 }] });

    write(w, "a.txt", "agent\n");
    const out = await finishWorkspace(run, "5678abcd-0000", "apply", relay, { env, home: tmp("exehome2") });
    expect(out.status).toBe("applied");
    expect(read(src, "a.txt")).toBe("agent\n");
    // Still there on the source, untouched
    expect(readFileSync(join(src, big)).length).toBe(60 * 1024 * 1024);
    expect(out.files?.map((f) => f.path)).toEqual(["a.txt"]);
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

/** What `memento-source <args>` does for the agent on the executor: posted to the task's bridge, answered by the source. */
async function agentRuns(run: WorkspaceRun, relay: Relay, exeHome: string, taskId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bridge = new SourceExecBridge(() => relay, () => {}, exeHome);
  const cli = (await bridge.register(taskId, run))!;
  try {
    const res = await fetch(cli.url, { method: "POST", body: JSON.stringify({ cwd: run.mirror.workDir, ...body }) });
    return JSON.parse(await res.text()) as Record<string, unknown>;
  } finally {
    bridge.dispose();
  }
}

/** The user's hooks on the source: trailing spaces trimmed from what is committed, "BAD" refused. */
function withHooks(src: string): void {
  const hook = join(src, ".git", "hooks", "pre-commit");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      'if git diff --cached | grep -q "^+.*BAD"; then echo "lint: BAD 不能提交" >&2; exit 1; fi',
      "for f in $(git diff --cached --name-only --diff-filter=AM); do",
      '  sed "s/[[:space:]]*$//" "$f" > "$f.tmp" && mv "$f.tmp" "$f" && git add "$f"',
      "done",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

describe("the agent's commits and pushes (made on the source)", () => {
  it("commits on the source with its hooks, takes in what they changed, and lands the commits on the branch", async () => {
    const src = sourceRepo();
    withHooks(src);
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const w = run.mirror.workDir;
    // The executor doesn't commit: its hooks send the agent to memento-source
    write(w, "x.txt", "one   \n");
    git(w, "add", "x.txt");
    expect(() => git(w, "commit", "-q", "-m", "here")).toThrow(/memento-source commit/);
    git(w, "reset", "-q");

    const first = await agentRuns(run, relay, exeHome, "c0ffee01-aaaa", { action: "commit", message: "feat: 第一个\n\n正文" });
    expect(first).toMatchObject({ exit_code: 0, subject: "feat: 第一个", files: ["x.txt"] });
    expect(String(first.stdout)).toContain("同步到这里");
    // The source's formatter ran, and its change is here too
    expect(read(w, "x.txt")).toBe("one\n");
    write(w, "x.txt", "one\ntwo\n");
    const second = await agentRuns(run, relay, exeHome, "c0ffee01-aaaa", { action: "commit", message: "fix: 第二个" });
    expect(second.exit_code).toBe(0);
    write(w, "y.txt", "not committed\n");
    // The user's uncommitted a.txt didn't go into the agent's commits
    expect(git(src, "show", "--format=", "--name-only", String(first.sha))).toBe("x.txt");

    const out = await finishWorkspace(run, "c0ffee01-aaaa", "apply", relay, { env, home: exeHome });
    expect(out).toMatchObject({ status: "applied", committed: "branch", commit_branch: "main" });
    expect(out.commits?.map((c) => c.subject)).toEqual(["fix: 第二个", "feat: 第一个"]);
    expect(git(src, "rev-parse", "main")).toBe(second.sha);
    expect(git(src, "log", "--format=%b", "-n", "1", "main~1")).toBe("正文");
    expect(read(src, "x.txt")).toBe("one\ntwo\n");
    expect(git(src, "status", "--porcelain").split("\n").map((l) => l.trim()).sort()).toEqual(["?? new.txt", "?? y.txt", "M a.txt"]);
    expect(git(src, "diff", "--cached", "--name-only")).toBe("");
    // The ref that held the commits is gone once they landed
    expect(git(src, "for-each-ref", "refs/memento/local")).toBe("");
    expect(out.push).toBeUndefined();
  });

  it("hands a failing hook's output back to the agent and commits nothing", async () => {
    const src = sourceRepo();
    withHooks(src);
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "BAD\n");
    const r = await agentRuns(run, relay, exeHome, "abad0010", { action: "commit", message: "feat: x" });
    expect(r.exit_code).toBe(1);
    expect(String(r.stderr)).toContain("lint: BAD 不能提交");
    expect(r.sha).toBeUndefined();
    expect(run.local?.count).toBe(0);
    expect(await agentRuns(run, relay, exeHome, "abad0010", { action: "commit", message: "" })).toMatchObject({ error: expect.stringContaining("说明是空的") });
  });

  it("commits only the paths given", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "x\n");
    write(run.mirror.workDir, "y.txt", "y\n");
    const r = await agentRuns(run, relay, exeHome, "abad0011", { action: "commit", message: "only x", paths: ["x.txt"] });
    expect(r.files).toEqual(["x.txt"]);
    expect(await agentRuns(run, relay, exeHome, "abad0011", { action: "commit", message: "x again", paths: ["x.txt"] })).toMatchObject({
      exit_code: 1,
      stderr: expect.stringContaining("没有要提交的改动"),
    });
  });

  it("keeps the commits on a memento/ branch when the source's HEAD moved meanwhile", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    await agentRuns(run, relay, exeHome, "beef0002", { action: "commit", message: "agent", push: true });
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

  it("pushes from the source when asked", async () => {
    const { src, remote } = trackedRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const w = run.mirror.workDir;
    expect(git(w, "status", "-sb").split("\n")[0]).toBe("## main...origin/main");
    write(w, "x.txt", "agent\n");
    await agentRuns(run, relay, exeHome, "abad0003", { action: "commit", message: "feat: 推送", push: true });
    expect(() => git(w, "push", "-q")).toThrow();

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
    write(run.mirror.workDir, "x.txt", "agent\n");
    await agentRuns(run, relay, exeHome, "abad0004", { action: "commit", message: "feat: 变基" });
    await agentRuns(run, relay, exeHome, "abad0004", { action: "push" });
    remoteCommit(remote, "deploy.txt", "tag 2\n");

    const out = await finishWorkspace(run, "abad0004", "apply", relay, { env, home: exeHome });
    expect(out.push).toMatchObject({ status: "pushed", rebased: 1 });
    expect(git(remote, "log", "--format=%s", "main")).toBe("feat: 变基\nci: deploy.txt\ninit");
    expect(git(src, "rev-parse", "main")).toBe(git(remote, "rev-parse", "main"));
    expect(out.commits?.[0]?.sha).toBe(git(src, "rev-parse", "main"));
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
    await agentRuns(run, relay, exeHome, "abad0005", { action: "commit", message: "feat: x", push: true });
    remoteCommit(remote, "a.txt", "ci edit\n");

    const out = await finishWorkspace(run, "abad0005", "apply", relay, { env, home: exeHome });
    expect(out.push?.status).toBe("rejected");
    expect(out.push?.detail).toContain("a.txt");
    expect(out.committed).toBe("branch");
    expect(read(src, "a.txt")).toBe("one\nuncommitted\n");
    expect(git(remote, "log", "--format=%s", "-n", "1", "main")).toBe("ci: a.txt");
  });

  it("pushes commits the source already had when the agent only asked to push", async () => {
    const { src, remote } = trackedRepo();
    write(src, "local.txt", "x\n");
    git(src, "add", "local.txt");
    git(src, "commit", "-q", "-m", "local, not pushed");
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    expect(git(run.mirror.workDir, "status", "-sb").split("\n")[0]).toBe("## main...origin/main [ahead 1]");
    await agentRuns(run, relay, exeHome, "abad0006", { action: "push" });

    const out = await finishWorkspace(run, "abad0006", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(out.push?.status).toBe("pushed");
    expect(git(remote, "log", "--format=%s", "-n", "1", "main")).toBe("local, not pushed");
  });

  it("only files come back when the agent forced a commit through on the executor", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    git(run.mirror.workDir, "add", "x.txt");
    git(run.mirror.workDir, "commit", "-q", "--no-verify", "-m", "here anyway");

    const out = await finishWorkspace(run, "abad0007", "apply", relay, { env, home: exeHome });
    expect(out.status).toBe("applied");
    expect(out.commits_error).toContain("绕过了拦截");
    expect(read(src, "x.txt")).toBe("agent\n");
    expect(git(src, "log", "--oneline").split("\n")).toHaveLength(1);
  });

  it("queues the commits with the patch while the source is offline", async () => {
    const src = sourceRepo();
    const relay = fakeRelay(src, tmp("srchome"));
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    write(run.mirror.workDir, "x.txt", "agent\n");
    await agentRuns(run, relay, exeHome, "abad0008", { action: "commit", message: "offline commit" });
    const offline: Relay = async () => {
      throw new WorkspaceError("Mac 不在线", "source_unavailable");
    };
    expect((await finishWorkspace(run, "abad0008", "apply", offline, { env, home: exeHome })).status).toBe("pending");
    expect((await listPending(exeHome))[0]?.commits).toMatchObject({ onSource: true });

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
    await agentRuns(run, relay, exeHome, "abad0009", { action: "commit", message: "half" });
    const out = await finishWorkspace(run, "abad0009", "save", relay, { env, home: exeHome });
    expect(out).toMatchObject({ status: "saved", committed: "kept", commit_branch: "memento/abad0009" });
    expect(existsSync(join(src, "x.txt"))).toBe(false);
    expect(git(src, "log", "--format=%s", "-n", "1", "memento/abad0009")).toBe("half");
  });

  it("edits a file on the source outside the project: get it, change it here, put it back, the old one backed up", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const relay = fakeRelay(src, srcHome);
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const other = join(tmp("other-repo"), "config.yaml");
    writeFileSync(other, "port: 1\n");
    const got = await agentRuns(run, relay, exeHome, "abad0013", { action: "get", file: other });
    const here = String(got.stdout).trim();
    writeFileSync(here, "port: 2\n");
    const put = await agentRuns(run, relay, exeHome, "abad0013", { action: "put", file: here, dest: other });
    expect(put.exit_code).toBe(0);
    expect(readFileSync(other, "utf8")).toBe("port: 2\n");
    const backup = /原文件备份在 (.+)）/.exec(String(put.stdout))?.[1];
    expect(backup && readFileSync(backup, "utf8")).toBe("port: 1\n");
    // A new file, with its folders
    const fresh = join(tmp("other-new"), "a", "b.txt");
    expect((await agentRuns(run, relay, exeHome, "abad0013", { action: "put", file: here, dest: fresh })).stdout).toContain("新文件");
    expect(readFileSync(fresh, "utf8")).toBe("port: 2\n");
    // The project's own files go back with the task's changes instead
    expect(await agentRuns(run, relay, exeHome, "abad0013", { action: "put", file: here, dest: join(src, "a.txt") })).toMatchObject({
      error: expect.stringContaining("任务项目里的文件"),
    });
    expect(await agentRuns(run, relay, exeHome, "abad0013", { action: "put", file: here, dest: "relative.txt" })).toMatchObject({
      error: expect.stringContaining("绝对路径"),
    });
  });

  it("brings back a file the agent's commands made on the source", async () => {
    const src = sourceRepo();
    const srcHome = tmp("srchome");
    const relay = fakeRelay(src, srcHome);
    const exeHome = tmp("exehome");
    const run = await prepareWorkspace(spec(src), relay, { env, home: exeHome });
    const shot = join(tmp("shots"), "page.png");
    writeFileSync(shot, Buffer.from([137, 80, 78, 71, 0, 1]));
    const r = await agentRuns(run, relay, exeHome, "abad0012", { action: "get", file: shot });
    expect(r.exit_code).toBe(0);
    expect([...readFileSync(String(r.stdout).trim())]).toEqual([137, 80, 78, 71, 0, 1]);
    expect(await agentRuns(run, relay, exeHome, "abad0012", { action: "get", file: "nope.png" })).toMatchObject({ error: expect.stringContaining("没有") });
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
