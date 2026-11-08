// The generator itself (src/blueprint, bundled as scripts/project_blueprint.mjs): what it finds in a
// repo, and the hooks, exclude entry and records it sets up and takes back. blueprint-auto.test.ts
// runs the bundle the way the daemon does.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildBlueprintContent, generateMermaidDiagram } from "../src/blueprint/content.js";
import { toPosix } from "../src/blueprint/files.js";
import { BLUEPRINT_SCRIPT_VERSION, HEAD_MARKER, HOOK_MARKER_START, MANAGED_GIT_HOOKS } from "../src/blueprint/meta.js";
import {
  EXCLUDE_MARK,
  ensureAgentGuidanceAnchor,
  installGitHook,
  uninstallGitHook,
  uninstallRepo,
  writeBlueprint,
} from "../src/blueprint/repo.js";
import {
  ABOUT_MAX_CHARS,
  detectProjectAbout,
  detectTechStack,
  detectVerificationCommands,
  generateErDiagram,
  scanApiRoutes,
  scanSubsystems,
} from "../src/blueprint/scan.js";

let base: string;
let home: string;
let root: string;
let savedHome: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

const hook = (name: string) => join(root, ".git", "hooks", name);
const r = () => toPosix(root);

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "memento_bpgen_")));
  home = join(base, "home");
  root = join(base, "repo");
  mkdirSync(home);
  mkdirSync(root);
  // State and the global copy of the script go to a throwaway home, not the real ~/.memento
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(base, { recursive: true, force: true });
});

describe("what the generator finds", () => {
  it("takes the About line from the README, then the manifest, then the docs", () => {
    write(
      "README.md",
      '<div align="center">\n\n# Demo\n\n**化合物检索平台**\n\n' +
        "[![CI](https://x/b.svg)](https://x) [![L](https://x/l.svg)](LICENSE)\n\n" +
        "[快速开始](#a) · [架构](#b)\n\n" +
        "支持名称、[结构](docs/s.md)和属性检索，服务地址 10.255.255.254。\n\n</div>\n\n## 功能\n\n- 列表项\n",
    );
    expect(detectProjectAbout(r())).toBe("化合物检索平台。支持名称、结构和属性检索，服务地址 <internal-ip>。");

    // A template README says nothing: the manifest's description is used
    write("README.md", "# app\n\nThis template should help get you started developing.\n");
    write("package.json", '{"name": "app", "description": "Order routing desk"}');
    expect(detectProjectAbout(r())).toBe("Order routing desk");

    unlinkSync(join(root, "package.json"));
    write("pyproject.toml", '[tool.ruff]\ndescription = "no"\n\n[project]\nname = "x"\ndescription = "Backtest service"\n');
    expect(detectProjectAbout(r())).toBe("Backtest service");

    // backend/ + frontend/ with no root README or manifest: the overview doc
    unlinkSync(join(root, "README.md"));
    unlinkSync(join(root, "pyproject.toml"));
    write("docs/architecture.md", "# 平台 - 架构设计文档\n\n## 1. 系统概述\n本平台提供本地化化合物检索服务。\n\n## 2. 技术栈\n- FastAPI\n");
    expect(detectProjectAbout(r())).toBe("本平台提供本地化化合物检索服务。");

    write("README.md", `# x\n\n${"这是一句很长的介绍。".repeat(30)}\n`);
    const clipped = detectProjectAbout(r());
    expect([...clipped].length).toBeLessThanOrEqual(ABOUT_MAX_CHARS);
    expect(clipped.endsWith("。")).toBe(true);
  });

  it("puts the About line and its own version into the blueprint", () => {
    write("README.md", "# demo\n\nA tiny demo service.\n");
    const content = buildBlueprintContent(r());
    const section0 = content.slice(content.indexOf("## 0."), content.indexOf("## 1."));
    expect(section0).toContain("- 简介 (About): A tiny demo service.");
    expect(content).toContain("- **About**: A tiny demo service.");
    expect(content.trimEnd().split("\n").pop()).toContain(`(v${BLUEPRINT_SCRIPT_VERSION})`);
    expect(content.trimEnd().split("\n").pop()).toContain("`scripts/project_blueprint.mjs`");

    unlinkSync(join(root, "README.md"));
    expect(buildBlueprintContent(r())).not.toContain("About");
  });

  it("detects a Python + Node monorepo's stack", () => {
    write("package.json", '{"name": "test-repo", "workspaces": ["apps/*", "packages/*"], "dependencies": {"next": "14.0", "react": "18.0"}}');
    write("server/pyproject.toml", '[project]\nname = "server"\ndependencies = ["fastapi", "sqlalchemy"]');
    const stack = detectTechStack(r());
    expect(stack.is_monorepo).toBe(true);
    expect(stack.languages).toEqual(expect.arrayContaining(["Python", "TypeScript/JavaScript"]));
    expect(stack.frameworks).toEqual(expect.arrayContaining(["FastAPI", "Next.js"]));
  });

  it("lists a monorepo's subsystems", () => {
    write("apps/web/package.json", '{"name": "@test/web", "description": "Web client app"}');
    write("packages/daemon/package.json", '{"name": "@test/daemon", "description": "Background daemon"}');
    mkdirSync(join(root, "server"));
    const names = scanSubsystems(r()).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["apps/web", "packages/daemon", "server"]));
  });

  it("draws the architecture diagram", () => {
    const subsystems = [
      { name: "apps/web", path: "apps/web", type: "Application", description: "Web" },
      { name: "packages/daemon", path: "packages/daemon", type: "Package", description: "Daemon" },
      { name: "server", path: "server", type: "Backend", description: "Server" },
    ];
    const stack = { project_type: "", is_monorepo: true, languages: ["Python", "TypeScript/JavaScript"], frameworks: ["FastAPI", "React"] };
    const diagram = generateMermaidDiagram(subsystems, stack);
    for (const node of ["flowchart TD", "WEB", "DAEMON", "API", "PG", "REDIS"]) expect(diagram).toContain(node);
  });

  it("writes every section", () => {
    write("package.json", '{"name": "sample", "dependencies": {"react": "18"}}');
    const content = buildBlueprintContent(r());
    for (const heading of [
      "# Project Blueprint: ",
      "## 1. Project Overview & Tech Stack",
      "## 2. High-Level Architecture Topology",
      "## 3. Subsystem Breakdown & Responsibilities",
      "## 8. Development & Verification Commands",
      "## 9. Recent Architectural Evolutions",
    ]) {
      expect(content).toContain(heading);
    }
  });

  it("finds the verification commands of Python and Node projects", () => {
    write("sub_py/pyproject.toml", "[project]\nname='app'\n[tool.pytest]\n");
    write("sub_py/pytest.ini", "[pytest]\n");
    expect(detectVerificationCommands(`${r()}/sub_py`)).toContain("pytest");
    write("sub_node/package.json", '{"scripts": {"test": "jest", "lint": "eslint"}}');
    expect(detectVerificationCommands(`${r()}/sub_node`)).toEqual(expect.arrayContaining(["npm test", "npm run lint"]));
  });

  it("follows include_router prefixes and singularizes ER table names", () => {
    write(
      "app/api/v1/__init__.py",
      "from fastapi import APIRouter\nfrom .algo_trading import router as algo_trading_router\napi_router = APIRouter()\n" +
        'api_router.include_router(algo_trading_router, prefix="/algo-trading")\n',
    );
    write("app/api/v1/algo_trading.py", 'from fastapi import APIRouter\nrouter = APIRouter()\n@router.get("/status")\ndef get_status(): pass\n');
    const routes = scanApiRoutes(r());
    expect(routes).toHaveLength(1);
    expect(routes[0]!.prefix).toBe("/algo-trading");
    expect(routes[0]!.endpoints).toContain("`GET /algo-trading/status`");

    const er = generateErDiagram(["`Account.user_id` ➔ `users.id`", "`Transaction.account_id` ➔ `accounts.id`"]);
    expect(er).toContain('USER ||--o{ ACCOUNT : "user_id"');
    expect(er).toContain('ACCOUNT ||--o{ TRANSACTION : "account_id"');
    expect(er).not.toContain("ACCOUNTS");
  });

  it("sorts subsystems by priority and finds Tauri IPC commands", () => {
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "src"));
    write("app.py", "\"\"\"\n@Time : 2024/08/06\nDo have a faith in what you're doing.\n\"\"\"\n");
    const subs = scanSubsystems(r());
    expect(subs[0]!.name).toBe("src");
    expect(subs.find((s) => s.name === "app.py")!.description.startsWith("Root-level ")).toBe(true);

    write("src-tauri/src/lib.rs", "#[tauri::command]\npub async fn launch_gateway() {}\n");
    expect(scanApiRoutes(r()).some((x) => x.endpoints.includes("`IPC tauri:launch_gateway`"))).toBe(true);
  });
});

describe("hooks, exclude entry and records", () => {
  beforeEach(() => {
    git(root, "init", "-q", "-b", "main");
    write("app.py", "print('hi')\n");
    git(root, "add", "app.py");
    git(root, "commit", "-qm", "init", "--no-verify");
  });

  const runHook = (name: string) => spawnSync("sh", [hook(name)], { cwd: root, encoding: "utf8" }).status;

  it("puts its block in every managed hook and takes it back", () => {
    expect(installGitHook(r())).toBe(true);
    for (const name of MANAGED_GIT_HOOKS) {
      const text = readFileSync(hook(name), "utf8");
      expect(text).toContain("project_blueprint.mjs");
      expect(text).toContain("scripts/runtime");
      expect(text).not.toContain("python");
    }
    expect(uninstallGitHook(r())).toBe(true);
    // Hooks holding nothing but our block are removed outright
    for (const name of MANAGED_GIT_HOOKS) expect(existsSync(hook(name))).toBe(false);
  });

  it("a failing pre-commit still stops the commit", () => {
    writeFileSync(hook("pre-commit"), "#!/bin/sh\necho lint failed >&2\nexit 3\n");
    expect(installGitHook(r())).toBe(true);
    const text = readFileSync(hook("pre-commit"), "utf8");
    expect(text).toContain("echo lint failed");
    expect(text).toContain(HOOK_MARKER_START);
    expect(runHook("pre-commit")).toBe(3);

    writeFileSync(hook("pre-commit"), "#!/bin/sh\nexit 0\n");
    installGitHook(r());
    expect(runHook("pre-commit")).toBe(0);
  });

  it("replaces the Python generator's block in a hook", () => {
    const legacy = `#!/bin/sh\necho mine\n\n${HOOK_MARKER_START}\n    PYTHON_BIN=$(command -v python3)\n    "$PYTHON_BIN" "scripts/project_blueprint.py" --root . --quiet\n# <<< Memento Blueprint Hook End >>>\n`;
    writeFileSync(hook("post-commit"), legacy);
    expect(installGitHook(r())).toBe(true);
    const text = readFileSync(hook("post-commit"), "utf8");
    expect(text.startsWith("#!/bin/sh\necho mine\n\n")).toBe(true);
    expect(text).not.toContain("project_blueprint.py");
    expect(text.split(HOOK_MARKER_START)).toHaveLength(2);
  });

  it("leaves hooks of other languages and hook managers alone", () => {
    const pyHook = "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n";
    writeFileSync(hook("pre-commit"), pyHook);
    expect(installGitHook(r())).toBe(true);
    expect(readFileSync(hook("pre-commit"), "utf8")).toBe(pyHook);
    expect(readFileSync(hook("post-commit"), "utf8")).toContain(HOOK_MARKER_START);

    uninstallGitHook(r());
    expect(existsSync(hook("post-commit"))).toBe(false); // nothing but our block was in it
    expect(readFileSync(hook("pre-commit"), "utf8")).toBe(pyHook);

    git(root, "config", "core.hooksPath", ".husky");
    expect(installGitHook(r())).toBe(true);
    expect(existsSync(hook("post-commit"))).toBe(false);
    expect(existsSync(join(root, ".husky"))).toBe(false);
  });

  it("keeps an untracked blueprint out of git status, and uninstall leaves nothing", () => {
    installGitHook(r());
    const [bp, changed] = writeBlueprint(r());
    expect(changed).toBe(true);
    const text = readFileSync(bp, "utf8");
    expect(text.startsWith("# Project Blueprint:")).toBe(true);
    expect(text).toContain("## 0. 速览与章节索引");
    // Kept out of `git status` without touching the repo's .gitignore
    expect(git(root, "status", "--porcelain")).not.toContain("PROJECT_BLUEPRINT.md");
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
    expect(existsSync(join(root, ".git", HEAD_MARKER))).toBe(true);
    expect(existsSync(join(home, ".memento", "blueprint_repos"))).toBe(true);
    // Rewriting identical content is not a change
    expect(writeBlueprint(r())[1]).toBe(false);

    expect(uninstallRepo(r())).toBe(true);
    expect(existsSync(bp)).toBe(false);
    expect(existsSync(join(root, ".git", HEAD_MARKER))).toBe(false);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toContain(EXCLUDE_MARK);
    for (const name of MANAGED_GIT_HOOKS) expect(existsSync(hook(name))).toBe(false);
    expect(existsSync(join(home, ".memento", "blueprint_repos"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("never overwrites a hand-written blueprint", () => {
    const own = "# Our architecture notes\n\nwritten by hand\n";
    write("PROJECT_BLUEPRINT.md", own);
    expect(writeBlueprint(r())[1]).toBe(false);
    uninstallRepo(r());
    expect(readFileSync(join(root, "PROJECT_BLUEPRINT.md"), "utf8")).toBe(own);
  });

  it("updates a blueprint the Python generator wrote", () => {
    write("PROJECT_BLUEPRINT.md", "# Project Blueprint: repo\n\n_Auto-maintained by `scripts/project_blueprint.py` (v20261120)._\n");
    const [bp, changed] = writeBlueprint(r());
    expect(changed).toBe(true);
    expect(readFileSync(bp, "utf8")).toContain("`scripts/project_blueprint.mjs`");
  });

  it("adds the anchor hint only when asked, and takes it back exactly", () => {
    const original = "# Rules\n\n- be brief\n";
    write("CLAUDE.md", original);
    writeBlueprint(r());
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(original); // not without --anchor
    expect(ensureAgentGuidanceAnchor(r())).toEqual(["CLAUDE.md"]);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toContain("「0. 速览与章节索引」");
    uninstallRepo(r());
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(original);
  });

  it("a tracked blueprint survives uninstall", () => {
    writeBlueprint(r());
    git(root, "add", "-f", "PROJECT_BLUEPRINT.md");
    git(root, "commit", "-qm", "bp", "--no-verify");
    installGitHook(r());
    uninstallRepo(r());
    expect(existsSync(join(root, "PROJECT_BLUEPRINT.md"))).toBe(true);
  });
});
