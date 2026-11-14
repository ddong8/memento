// BUSINESS_BLUEPRINT.md (src/blueprint/business.ts): entries parsed from the file, checked against the code,
// the generated regions rewritten in place, and commits mapped to the entries they reach.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECK_END,
  CHECK_START,
  INDEX_START,
  checkBusinessBlueprint,
  blockSpan,
  findSymbol,
  looksLikePath,
  parseBusinessBlueprint,
  refreshBusinessText,
} from "../src/blueprint/business.js";
import { buildBlueprintContent } from "../src/blueprint/content.js";
import { main } from "../src/blueprint/cli.js";

let root: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

const BLUEPRINT = [
  "# Business Blueprint: demo",
  "",
  "> intro",
  "",
  "## 1. 术语",
  "",
  "### T-WORKDIR 工作目录",
  "- 定义: the folder the user picked",
  "- 代码: `src/runner.ts#projectForFolder`",
  "",
  "## 2. 流程",
  "",
  "### F-RUN 跑一个任务",
  "1. pick the project — `src/runner.ts#projectForFolder`",
  "2. start it — `src/start.ts`",
  "",
  "## 3. 规则",
  "",
  "### R-WORKDIR 选了哪个目录就在哪个目录干活",
  "- 来源: 用户 2026-11-14「选的是 A 怎么开的是 B」",
  "- 代码: `src/runner.ts#projectForFolder`",
  "- 测试: `test/runner.test.ts#takes the project of the folder`",
  "- 禁止: `lastCreatedProjectId` @ `src/`",
  "- 要求: `ANTIGRAVITY_PROJECT_ID = ` @ `src/runner.ts`",
  "",
  "### R-NOTEST 没有保证的规则",
  "- 来源: 用户",
  "- 代码: `src/start.ts`",
  "",
  "## 4. 状态",
  "",
  "### S-PROJECT 项目",
  "- 事实源: `src/store.ts#ProjectStore`",
  "",
].join("\n");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bizbp-")));
  git("init", "-q");
  write(
    "src/runner.ts",
    [
      "// The app's lastCreatedProjectId put tasks in the wrong folder: not used any more",
      "export async function projectForFolder(dir: string) {",
      "  process.env.ANTIGRAVITY_PROJECT_ID = dir;",
      "}",
      "",
    ].join("\n"),
  );
  write("src/start.ts", "export const start = () => 1;\n");
  write("src/store.ts", "export class ProjectStore {}\n");
  write("test/runner.test.ts", 'it("takes the project of the folder, not the one made last", () => {});\n');
  write("BUSINESS_BLUEPRINT.md", BLUEPRINT);
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parsing", () => {
  it("reads entries by their ID letter, with anchors, tests, checks and sources", () => {
    const entries = parseBusinessBlueprint(BLUEPRINT);
    expect(entries.map((e) => [e.id, e.kind])).toEqual([
      ["T-WORKDIR", "term"],
      ["F-RUN", "flow"],
      ["R-WORKDIR", "rule"],
      ["R-NOTEST", "rule"],
      ["S-PROJECT", "state"],
    ]);
    const rule = entries[2]!;
    expect(rule.anchors.map((a) => [a.path, a.symbol])).toEqual([["src/runner.ts", "projectForFolder"]]);
    expect(rule.tests[0]).toMatchObject({ path: "test/runner.test.ts", symbol: "takes the project of the folder" });
    expect(rule.forbidden).toEqual([{ pattern: "lastCreatedProjectId", paths: ["src/"], hits: [], ok: true }]);
    expect(rule.sources).toHaveLength(1);
    expect(entries[1]!.anchors.map((a) => a.ref)).toEqual(["src/runner.ts#projectForFolder", "src/start.ts"]);
  });

  it("tells paths from code and words", () => {
    expect(looksLikePath("src/a.ts#fn")).toBe(true);
    expect(looksLikePath("package.json")).toBe(true);
    expect(looksLikePath("lastCreatedProjectId")).toBe(false);
    expect(looksLikePath("ANTIGRAVITY_PROJECT_ID = ")).toBe(false);
    expect(looksLikePath("https://example.com/x")).toBe(false);
  });

  it("skips what's inside the generated regions and code fences", () => {
    const text = `${BLUEPRINT}\n${CHECK_START}\n### R-GHOST from the old results\n${CHECK_END}\n\`\`\`\n### R-FENCED an example\n\`\`\`\n`;
    expect(parseBusinessBlueprint(text).map((e) => e.id)).not.toContain("R-GHOST");
    expect(parseBusinessBlueprint(text).map((e) => e.id)).not.toContain("R-FENCED");
  });
});

describe("checking", () => {
  it("finds a symbol at its definition, as a whole word", () => {
    const text = "const x = projectForFolderX;\nfoo(projectForFolder);\nexport async function projectForFolder() {}\n";
    expect(findSymbol(text, "projectForFolder")).toBe(3);
    expect(findSymbol(text, "projectFor")).toBe(0);
    expect(findSymbol("class A {\n  run() {}\n}\n", "A.run")).toBe(2);
    expect(findSymbol("a = 1\n", "B.run")).toBe(0);
    expect(findSymbol('x("续: ")\n', '"续: "')).toBe(1);
  });

  it("passes a rule whose code, test and checks hold; a comment naming the old way isn't the old way", () => {
    const r = checkBusinessBlueprint(root)!;
    const rule = r.entries.find((e) => e.id === "R-WORKDIR")!;
    expect(rule.verdict).toBe("ok");
    expect(rule.anchors[0]!.line).toBe(2);
    expect(r.rules).toEqual({ ok: 1, warn: 1, fail: 0 });
    expect(r.entries.find((e) => e.id === "R-NOTEST")!.problems).toEqual(["没有测试或检查保证"]);
  });

  it("fails a rule when its function is gone, its test renamed, the bug's pattern is back or the fix's is missing", () => {
    write("src/runner.ts", "export function pickProject() {\n  const id = storage.lastCreatedProjectId;\n}\n");
    write("test/runner.test.ts", 'it("something else", () => {});\n');
    const rule = checkBusinessBlueprint(root)!.entries.find((e) => e.id === "R-WORKDIR")!;
    expect(rule.verdict).toBe("fail");
    expect(rule.problems.join("\n")).toContain("找不到 projectForFolder");
    expect(rule.problems.join("\n")).toContain("测试里找不到");
    expect(rule.problems.join("\n")).toContain("src/runner.ts:2");
    expect(rule.problems.join("\n")).toContain("缺少要求的写法");
  });

  it("fails a missing file and a duplicated ID", () => {
    write("BUSINESS_BLUEPRINT.md", BLUEPRINT.replace("`src/store.ts#ProjectStore`", "`src/gone.ts#ProjectStore`") + "\n### R-NOTEST again\n- 代码: `src/start.ts`\n");
    const r = checkBusinessBlueprint(root)!;
    expect(r.entries.find((e) => e.id === "S-PROJECT")!.problems[0]).toContain("文件不存在");
    expect(r.duplicates).toEqual(["R-NOTEST"]);
    expect(r.fails).toBeGreaterThanOrEqual(2);
  });
});

describe("generated regions", () => {
  it("puts an index after the title and the results at the end, and rewriting it changes nothing", () => {
    const once = refreshBusinessText(root, BLUEPRINT)!.text;
    const lines = once.split("\n");
    expect(lines[2]).toBe(INDEX_START);
    expect(lines.at(-2)).toBe(CHECK_END);
    expect(refreshBusinessText(root, once)!.text).toBe(once);
    // Every index row points at its heading
    for (const m of once.matchAll(/^\| (.+?) \| L(\d+)-L(\d+) \|$/gm)) {
      expect(lines[Number(m[2]) - 1]).toBe(`## ${m[1]}`);
    }
    expect(once).toContain("规则 2（✅ 1 · ⚠️ 1 · ❌ 0）");
  });

  it("leaves everything written by hand as it was", () => {
    const once = refreshBusinessText(root, BLUEPRINT)!.text;
    const lines = once.split("\n");
    const a = lines.indexOf(INDEX_START);
    const b = lines.findIndex((l) => l.startsWith("<!-- memento:business-index:end"));
    const c = lines.indexOf(CHECK_START);
    const stripped = [...lines.slice(0, a), ...lines.slice(b + 1, c)].join("\n");
    expect(stripped.trim()).toBe(BLUEPRINT.trim());
  });
});

describe("recent commits", () => {
  it("takes a definition's lines up to where the code comes back to its indentation", () => {
    const lines = ["export function a() {", "  x();", "}", "export const b = 1;", "class C:", "    def run(self):", "        pass", "    def other(self):", "        pass"];
    expect(blockSpan(lines, 1)).toEqual([1, 3]);
    expect(blockSpan(lines, 4)).toEqual([4, 4]);
    expect(blockSpan(lines, 6)).toEqual([6, 7]);
  });

  it("names the entries a change reached: by the symbol it touched, not just the file", () => {
    write("src/runner.ts", readFileSync(join(root, "src/runner.ts"), "utf8") + "\nexport const unrelated = 2;\n");
    git("commit", "-qam", "unrelated change in the same file");
    write("src/runner.ts", readFileSync(join(root, "src/runner.ts"), "utf8").replace("process.env.ANTIGRAVITY_PROJECT_ID = dir;", "process.env.ANTIGRAVITY_PROJECT_ID = dir; // picked"));
    git("commit", "-qam", "change inside projectForFolder");
    git("commit", "-q", "--allow-empty", "-m", "ci(deploy): image bump [skip ci]");
    const impact = checkBusinessBlueprint(root)!.impact;
    const byCommit = Object.fromEntries(impact.map((i) => [i.subject, i.ids]));
    expect(byCommit["change inside projectForFolder"]).toEqual(expect.arrayContaining(["T-WORKDIR", "F-RUN", "R-WORKDIR"]));
    expect(byCommit["unrelated change in the same file"]).toBeUndefined();
    expect(byCommit["ci(deploy): image bump [skip ci]"]).toBeUndefined();
  });
});

describe("the generator", () => {
  it("adds section 11 and a summary line to PROJECT_BLUEPRINT.md", () => {
    const content = buildBlueprintContent(root);
    expect(content).toContain("## 11. 业务蓝图核对 (Business Blueprint Check)");
    expect(content).toMatch(/- 业务蓝图 \(Business\): `BUSINESS_BLUEPRINT.md` · 规则 2/);
  });

  it("--business exits 1 on a broken rule and 0 when they hold; --business-init writes a starting file", () => {
    expect(main(["--business", "--root", root, "--quiet"])).toBe(0);
    expect(readFileSync(join(root, "BUSINESS_BLUEPRINT.md"), "utf8")).toContain(CHECK_START);
    write("src/runner.ts", "export const x = 1;\n");
    expect(main(["--business", "--root", root, "--quiet"])).toBe(1);

    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "bizbp-init-")));
    try {
      expect(main(["--business-init", "--root", fresh, "--quiet"])).toBe(0);
      const text = readFileSync(join(fresh, "BUSINESS_BLUEPRINT.md"), "utf8");
      expect(parseBusinessBlueprint(text).map((e) => e.kind)).toEqual(["term", "flow", "rule", "state"]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("the commit hook stages a refreshed business blueprint only when it has no edits of its own", () => {
    const hook = spawnSync("node", ["-e", "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))", join(__dirname, "../src/blueprint/repo.ts")], { encoding: "utf8" }).stdout;
    expect(hook).toContain("git diff --quiet -- BUSINESS_BLUEPRINT.md");
    expect(hook).toContain("git add BUSINESS_BLUEPRINT.md");
  });
});
