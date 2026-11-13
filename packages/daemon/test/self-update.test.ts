import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executorSourceRoot, updateOnce } from "../src/self-update.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "pipe" }).toString();

let base: string;
let upstream: string;
let root: string;

function release(version: string) {
  writeFileSync(join(upstream, "apps", "desktop", "package.json"), JSON.stringify({ version }));
  git(upstream, "commit", "-qam", `v${version}`);
}

/** Stands in for npm ci + build: what a built daemon leaves behind. */
async function fakeBuild(dir: string) {
  mkdirSync(join(dir, "packages", "daemon", "dist"), { recursive: true });
  writeFileSync(join(dir, "packages", "daemon", "dist", "cli.js"), "process.exit(0)\n");
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "self-update-")));
  upstream = join(base, "upstream");
  mkdirSync(join(upstream, "apps", "desktop"), { recursive: true });
  git(upstream, "init", "-q");
  writeFileSync(join(upstream, "apps", "desktop", "package.json"), JSON.stringify({ version: "1.0.1" }));
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "init");
  root = join(base, "home", ".memento", "src", "memento");
  mkdirSync(join(base, "home", ".memento", "src"), { recursive: true });
  git(base, "clone", "-q", "--depth", "1", `file://${upstream}`, root);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("executor self-update", () => {
  it("leaves a daemon on the released version alone, even when main moved", async () => {
    writeFileSync(join(upstream, "README.md"), "x");
    git(upstream, "add", ".");
    git(upstream, "commit", "-qm", "docs");
    const logs: string[] = [];
    const r = await updateOnce({ root, log: (l) => logs.push(l), busy: () => false, build: fakeBuild });
    expect(r).toEqual({ status: "current" });
    expect(existsSync(`${root}.next`)).toBe(false);
  });

  it("builds a new release beside the running one, waits for tasks, then swaps it in", async () => {
    release("1.0.2");
    let busy = 2;
    const logs: string[] = [];
    const r = await updateOnce({ root, log: (l) => logs.push(l), busy: () => busy-- > 0, build: fakeBuild, idlePollMs: 5 });
    expect(r).toEqual({ status: "updated", from: "1.0.1", to: "1.0.2" });
    expect(JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version).toBe("1.0.2");
    expect(existsSync(join(root, "packages", "daemon", "dist", "cli.js"))).toBe(true);
    expect(JSON.parse(readFileSync(join(`${root}.prev`, "apps", "desktop", "package.json"), "utf8")).version).toBe("1.0.1");
    expect(logs.some((l) => l.includes("等正在运行的任务结束"))).toBe(true);
  });

  it("keeps running the current build when the new one fails to build", async () => {
    release("1.0.3");
    const r = await updateOnce({ root, log: () => {}, busy: () => false, build: async () => { throw new Error("npm ci failed"); } });
    expect(r.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(root, "apps", "desktop", "package.json"), "utf8")).version).toBe("1.0.1");
    expect(existsSync(`${root}.next`)).toBe(false);
  });

  it("only runs in an executor's systemd service from ~/.memento/src/memento", () => {
    const self = join(root, "packages", "daemon", "dist", "self-update.js");
    mkdirSync(join(root, "packages", "daemon", "dist"), { recursive: true });
    const home = join(base, "home");
    if (process.platform !== "linux") return;
    expect(executorSourceRoot({ INVOCATION_ID: "x" }, self, home)).toBe(root);
    expect(executorSourceRoot({}, self, home)).toBeUndefined();
    expect(executorSourceRoot({ INVOCATION_ID: "x", MEMENTO_AUTO_UPDATE: "0" }, self, home)).toBeUndefined();
    expect(executorSourceRoot({ INVOCATION_ID: "x" }, join(upstream, "packages", "daemon", "dist", "self-update.js"), home)).toBeUndefined();
  });
});
