/**
 * Tests the `bump` step in `.github/workflows/deploy.yml`:
 * - Pins the built images cleanly
 * - Recovers when a cancelled run already pushed the same line
 * - Never rolls production back to an older commit
 * - Stops when GitHub compare cannot tell which commit is newer
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, "..", "..", ".github", "workflows", "deploy.yml");
const IMAGES = ["memento-server", "memento-web"] as const;

const KUSTOMIZATION =
  "images:\n" +
  IMAGES.map((i) => `- name: ghcr.io/ddong8/${i}\n  newName: ghcr.io/ddong8/${i}\n  newTag: 000000000000\n`).join("");

const STUBS: Record<string, string> = {
  docker: "#!/bin/bash\nexit 0\n",
  kustomize: `#!/bin/bash
spec="$4"; name="\${spec%%=*}"; tag="\${spec##*:}"
awk -v n="$name" -v t="$tag" '$1=="-" && $2=="name:" {cur=$3} $1=="newTag:" && cur==n {sub(/newTag: .*/, "newTag: " t)} {print}' \\
  kustomization.yaml > k.tmp && mv k.tmp kustomization.yaml
`,
  gh: `#!/bin/bash
[ -n "$GH_BROKEN" ] && exit 1
c="\${2##*/compare/}"; base="\${c%%...*}"; head="\${c##*...}"
cd "$SIM_ORIGIN" || exit 1
b=$(git rev-parse -q --verify "$base^{commit}") || exit 1; h=$(git rev-parse -q --verify "$head^{commit}") || exit 1
if [ "$b" = "$h" ]; then echo identical
elif git merge-base --is-ancestor "$b" "$h"; then echo ahead
elif git merge-base --is-ancestor "$h" "$b"; then echo behind
else echo diverged; fi
`,
};

function extractBumpScript(): string {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const pinIdx = lines.findIndex((l) => /^\s+id:\s*pin\s*$/.test(l));
  assert.ok(pinIdx >= 0, "bump pin step not found in deploy.yml");
  const runIdx = lines.findIndex((l, i) => i > pinIdx && /^\s+run:\s*\|\s*$/.test(l));
  assert.ok(runIdx >= 0, "run block not found under pin step");
  const runIndent = lines[runIdx]!.match(/^(\s*)/)![1]!.length;
  const body: string[] = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.match(/^(\s*)/)![1]!.length;
    if (indent <= runIndent) break;
    body.push(line.slice(runIndent + 2));
  }
  return body.join("\n") + "\n";
}

const SKIP = process.platform === "win32";

describe("deploy.yml bump race protection", { skip: SKIP }, () => {
  let tmp = "";
  let origin = "";
  let seed = "";
  let env: Record<string, string> = {};
  let runSeq = 0;

  function git(args: string[], cwd = seed): string {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  }

  function commit(msg: string): string {
    writeFileSync(join(seed, "code.txt"), msg + "\n", { flag: "a" });
    git(["add", "code.txt"]);
    git(["commit", "-qm", msg]);
    git(["push", "-q", "origin", "main"]);
    return git(["rev-parse", "HEAD"]);
  }

  function botPin(image: string, sha: string): void {
    git(["pull", "-q", "--rebase", "origin", "main"]);
    execFileSync(
      "kustomize",
      ["edit", "set", "image", `ghcr.io/ddong8/${image}=ghcr.io/ddong8/${image}:${sha.slice(0, 12)}`],
      { cwd: join(seed, "deploy", "k8s"), env },
    );
    git(["commit", "-qam", `bot ${image} -> ${sha.slice(0, 12)}`]);
    git(["push", "-q", "origin", "main"]);
  }

  function runBump(
    sha: string,
    opts: { server: boolean; web: boolean; extraEnv?: Record<string, string> },
  ): { code: number; outputs: Record<string, string>; log: string } {
    runSeq += 1;
    const runDir = join(tmp, `run-${runSeq}`);
    git(["clone", "-q", origin, runDir], tmp);
    git(["checkout", "-q", "-B", "main", sha], runDir);
    git(["branch", "-q", "-u", "origin/main"], runDir);
    const outFile = join(runDir, "github_output");
    writeFileSync(outFile, "");
    const p = spawnSync("bash", ["-eo", "pipefail", join(tmp, "bump.sh")], {
      cwd: runDir,
      encoding: "utf8",
      env: {
        ...env,
        SHA: sha,
        SERVER: String(opts.server),
        WEB: String(opts.web),
        GITHUB_OUTPUT: outFile,
        ...(opts.extraEnv ?? {}),
      },
    });
    const outputs: Record<string, string> = {};
    for (const line of readFileSync(outFile, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { code: p.status ?? 1, outputs, log: `${p.stdout ?? ""}${p.stderr ?? ""}` };
  }

  function tagsOnMain(): Record<string, string> {
    const text = git(["show", "main:deploy/k8s/kustomization.yaml"], origin);
    const tags: Record<string, string> = {};
    let cur = "";
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === "-" && parts[1] === "name:" && parts[2]) {
        cur = parts[2].split("/").pop() ?? "";
      } else if (parts[0] === "newTag:" && cur && parts[1]) {
        tags[cur] = parts[1];
      }
    }
    return tags;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bump-"));
    const stubs = join(tmp, "stubs");
    mkdirSync(stubs);
    for (const [name, body] of Object.entries(STUBS)) {
      const p = join(stubs, name);
      writeFileSync(p, body);
      chmodSync(p, 0o755);
    }
    writeFileSync(join(tmp, "bump.sh"), extractBumpScript());
    origin = join(tmp, "origin.git");
    env = {
      ...(process.env as Record<string, string>),
      HOME: tmp,
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: `${stubs}:${process.env.PATH ?? ""}`,
      SIM_ORIGIN: origin,
      REGISTRY: "ghcr.io",
      OWNER: "ddong8",
      GITHUB_REPOSITORY: "ddong8/memento",
      GH_TOKEN: "t",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    git(["init", "-q", "--bare", "-b", "main", origin], tmp);
    seed = join(tmp, "seed");
    git(["clone", "-q", origin, seed], tmp);
    mkdirSync(join(seed, "deploy", "k8s"), { recursive: true });
    writeFileSync(join(seed, "deploy", "k8s", "kustomization.yaml"), KUSTOMIZATION);
    git(["add", "-A"]);
    git(["commit", "-qm", "base"]);
    git(["push", "-q", "origin", "main"]);
    const base = git(["rev-parse", "HEAD"]);
    for (const image of IMAGES) botPin(image, base);
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("pins the images it built", () => {
    const c1 = commit("c1");
    const { code, outputs, log } = runBump(c1, { server: true, web: true });
    assert.equal(code, 0, log);
    assert.deepEqual(tagsOnMain(), { "memento-server": c1.slice(0, 12), "memento-web": c1.slice(0, 12) });
    assert.deepEqual(outputs, { server: "true", web: "true" });
  });

  it("goes through when a cancelled run pushed the same line first", () => {
    const c1 = commit("c1");
    const c2 = commit("c2");
    botPin("memento-server", c1);
    const { code, outputs, log } = runBump(c2, { server: true, web: true });
    assert.equal(code, 0, log);
    assert.deepEqual(tagsOnMain(), { "memento-server": c2.slice(0, 12), "memento-web": c2.slice(0, 12) });
    assert.deepEqual(outputs, { server: "true", web: "true" });
  });

  it("a late older run never moves production back", () => {
    const c1 = commit("c1");
    const c2 = commit("c2");
    botPin("memento-server", c2);
    let res = runBump(c1, { server: true, web: true });
    assert.equal(res.code, 0, res.log);
    assert.deepEqual(tagsOnMain(), { "memento-server": c2.slice(0, 12), "memento-web": c1.slice(0, 12) });
    assert.deepEqual(res.outputs, { server: "false", web: "true" });

    botPin("memento-web", c2);
    res = runBump(c1, { server: true, web: true });
    assert.equal(res.code, 0, res.log);
    assert.deepEqual(tagsOnMain(), { "memento-server": c2.slice(0, 12), "memento-web": c2.slice(0, 12) });
    assert.deepEqual(res.outputs, { server: "false", web: "false" });
  });

  it("stops when it cannot tell which commit is newer", () => {
    const c1 = commit("c1");
    const c2 = commit("c2");
    botPin("memento-server", c1);
    const { code, log } = runBump(c2, { server: true, web: false, extraEnv: { GH_BROKEN: "1" } });
    assert.notEqual(code, 0, log);
    assert.equal(tagsOnMain()["memento-server"], c1.slice(0, 12));
  });
});
