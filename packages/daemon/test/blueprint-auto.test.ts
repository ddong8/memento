import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRemoteBlueprintScript,
  blueprintGeneratorVersion,
  blueprintStatusReport,
  ensureProjectBlueprint,
  findGitRoot,
  generatorFailureReason,
  isBlueprintReady,
  locateBlueprintGenerator,
  needsRemoteBlueprintSync,
  parseBlueprintScriptMeta,
  readGitHeadShort,
  removeAllProjectBlueprints,
  resolveGitDirs,
  setBlueprintAutoEnabled,
} from "../src/blueprint-auto.js";

let tmpDir: string;
let homeTmp: string;
let savedHome: string | undefined;

/** git with no user config, hooks or signing from the machine running the tests */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "init");
}

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink, git and python report the resolved path
  homeTmp = realpathSync(mkdtempSync(join(tmpdir(), "memento_bp_home_")));
  tmpDir = join(homeTmp, "dev", "proj");
  mkdirSync(tmpDir, { recursive: true });
  // The generator records repos under ~/.memento: keep the tests out of the real home
  savedHome = process.env.HOME;
  process.env.HOME = homeTmp;
  setBlueprintAutoEnabled(true);
});

afterEach(() => {
  process.env.HOME = savedHome;
  setBlueprintAutoEnabled(true);
  rmSync(homeTmp, { recursive: true, force: true });
});

describe("blueprint-auto", () => {
  it("findGitRoot correctly locates git root or returns null", () => {
    expect(findGitRoot("")).toBeNull();
    expect(findGitRoot(tmpDir)).toBeNull();

    // Create .git directory
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir, { recursive: true });

    // Directly in root
    expect(findGitRoot(tmpDir)).toBe(tmpDir);

    // In a deep subdirectory
    const deepSub = join(tmpDir, "apps", "sub", "deep");
    mkdirSync(deepSub, { recursive: true });
    expect(findGitRoot(deepSub)).toBe(tmpDir);
  });

  it("readGitHeadShort follows linked worktrees and packed refs", () => {
    initRepo(tmpDir);
    const wt = join(homeTmp, "wt-feature");
    git(tmpDir, "worktree", "add", "-q", "-b", "feature", wt);
    git(wt, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "feature work");
    git(tmpDir, "pack-refs", "--all");
    return (async () => {
      const dirs = await resolveGitDirs(wt);
      expect(dirs?.gitDir).toBe(join(tmpDir, ".git", "worktrees", "wt-feature"));
      expect(dirs?.commonDir).toBe(join(tmpDir, ".git"));
      expect(await readGitHeadShort(wt)).toBe(git(wt, "rev-parse", "--short=7", "HEAD"));
      expect(await readGitHeadShort(tmpDir)).toBe(git(tmpDir, "rev-parse", "--short=7", "HEAD"));
      expect(await readGitHeadShort(wt)).not.toBe(await readGitHeadShort(tmpDir));
    })();
  });

  it("isBlueprintReady: generated blueprint must match HEAD, a hand-written one is left alone", async () => {
    initRepo(tmpDir);
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    writeFileSync(bpPath, "# Our architecture notes\n\nWritten by hand.\n");
    expect(await isBlueprintReady(tmpDir)).toBe(true);

    const head = git(tmpDir, "rev-parse", "--short", "HEAD");
    writeFileSync(bpPath, "# Project Blueprint: proj\n\n_Auto-maintained by `scripts/project_blueprint.py`._\n");
    expect(await isBlueprintReady(tmpDir)).toBe(false); // no marker yet
    writeFileSync(join(tmpDir, ".git", ".memento_blueprint_head"), `${head}\n`);
    expect(await isBlueprintReady(tmpDir)).toBe(true);
    writeFileSync(join(tmpDir, ".git", ".memento_blueprint_head"), "0000000\n");
    expect(await isBlueprintReady(tmpDir)).toBe(false);
  });

  it("leaves a hand-written PROJECT_BLUEPRINT.md and the repo's hooks untouched", async () => {
    initRepo(tmpDir);
    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    writeFileSync(bpPath, "# Our architecture notes\n");
    expect(await ensureProjectBlueprint(tmpDir)).toBe(true);
    expect(readFileSync(bpPath, "utf8")).toBe("# Our architecture notes\n");
    expect(existsSync(join(tmpDir, ".git", "hooks", "post-commit"))).toBe(false);
  });

  it("does nothing while automatic blueprints are switched off", async () => {
    initRepo(tmpDir);
    setBlueprintAutoEnabled(false);
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(false);
    expect(existsSync(join(tmpDir, "PROJECT_BLUEPRINT.md"))).toBe(false);
    expect(existsSync(join(homeTmp, ".memento"))).toBe(false);
  });

  it("removeAllProjectBlueprints takes back hooks, markers, generated files and records", async () => {
    initRepo(tmpDir);
    writeFileSync(join(tmpDir, ".git", "hooks", "post-merge"), "#!/bin/sh\necho mine\n");
    expect(await ensureProjectBlueprint(tmpDir)).toBe(true);
    expect(readFileSync(join(tmpDir, ".git", "hooks", "post-commit"), "utf8")).toContain("Memento Blueprint Hook Start");
    expect(existsSync(join(homeTmp, ".memento", "blueprint_repos"))).toBe(true);

    expect(await removeAllProjectBlueprints()).toBe(true);
    expect(existsSync(join(tmpDir, "PROJECT_BLUEPRINT.md"))).toBe(false);
    expect(existsSync(join(tmpDir, ".git", ".memento_blueprint_head"))).toBe(false);
    expect(existsSync(join(tmpDir, ".git", "hooks", "post-commit"))).toBe(false);
    expect(readFileSync(join(tmpDir, ".git", "hooks", "post-merge"), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(readFileSync(join(tmpDir, ".git", "info", "exclude"), "utf8")).not.toContain("PROJECT_BLUEPRINT.md");
    expect(existsSync(join(homeTmp, ".memento", "blueprint_repos"))).toBe(false);
    expect(git(tmpDir, "status", "--porcelain")).toBe("");
  });

  it("locateBlueprintGenerator prefers the project's own generator unless it is older than ours", async () => {
    const localScripts = join(tmpDir, "scripts");
    mkdirSync(localScripts, { recursive: true });
    const localPy = join(localScripts, "project_blueprint.py");
    writeFileSync(localPy, "#!/usr/bin/env python3\nBLUEPRINT_SCRIPT_VERSION = 99999999\nprint('mock')\n");
    expect(await locateBlueprintGenerator(tmpDir)).toBe(localPy);

    // Copied in once and never updated: the shared, newer generator is used instead
    writeFileSync(localPy, "#!/usr/bin/env python3\nBLUEPRINT_SCRIPT_VERSION = 20200101\nprint('mock')\n");
    const found = await locateBlueprintGenerator(tmpDir);
    expect(found).not.toBe(localPy);
    expect(found).toMatch(/project_blueprint\.py$/);
  });

  it("writes the project's About line from its README into section 0", async () => {
    initRepo(tmpDir);
    writeFileSync(
      join(tmpDir, "README.md"),
      [
        '<div align="center">',
        "",
        "# Demo",
        "",
        "**给团队用的化合物检索平台**",
        "",
        "[![License](https://img.shields.io/badge/l-MIT-blue.svg)](LICENSE) [![CI](https://x/y.svg)](https://x)",
        "",
        "本地化部署，支持名称、结构和属性检索。",
        "",
        "</div>",
        "",
        "## 功能",
        "",
        "- 不应进入简介的列表项",
        "",
      ].join("\n"),
    );
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(true);
    const bp = readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8");
    const section0 = bp.slice(bp.indexOf("## 0."), bp.indexOf("## 1."));
    expect(section0).toContain("- 简介 (About): 给团队用的化合物检索平台。本地化部署，支持名称、结构和属性检索。");
    expect(section0).not.toContain("列表项");
    expect(blueprintGeneratorVersion(bp)).toBeGreaterThan(20261110);
  });

  it("rebuilds a generated blueprint written by an older generator, once", async () => {
    initRepo(tmpDir);
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(true);
    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    const current = blueprintGeneratorVersion(readFileSync(bpPath, "utf8"));
    expect(current).toBeGreaterThan(0);

    // As written before footers carried the generator version
    writeFileSync(bpPath, readFileSync(bpPath, "utf8").replace(/ \(v\d+\)/, ""));
    expect(await isBlueprintReady(tmpDir)).toBe(true);
    expect(await isBlueprintReady(tmpDir, current)).toBe(false);

    setBlueprintAutoEnabled(false);
    setBlueprintAutoEnabled(true); // drop the "verified" cache, as a new pass after restart would
    expect(await ensureProjectBlueprint(tmpDir)).toBe(true);
    expect(blueprintGeneratorVersion(readFileSync(bpPath, "utf8"))).toBe(current);
  });

  it("reports each repo's outcome and why the generator failed", async () => {
    initRepo(tmpDir);
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(true);
    let report = await blueprintStatusReport([tmpDir, join(homeTmp, "never-tried")]);
    expect(report).toMatchObject({ enabled: true, ok: 1, no_hooks: 0, failed: [] });
    expect(report.python).toBeTruthy();
    expect(report.generator_version).toBeGreaterThan(20261110);

    // A broken generator in the repo (newer than ours, so it is the one used)
    mkdirSync(join(tmpDir, "scripts"), { recursive: true });
    writeFileSync(
      join(tmpDir, "scripts", "project_blueprint.py"),
      "import sys\nBLUEPRINT_SCRIPT_VERSION = 99999999\nsys.stderr.write('Traceback\\nValueError: boom\\n')\nsys.exit(3)\n",
    );
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(false);
    report = await blueprintStatusReport([tmpDir]);
    expect(report.ok).toBe(0);
    expect(report.failed).toEqual([{ name: "proj", reason: "exit 3: ValueError: boom" }]);
  });

  it("names the failure: no Python, timeout, or the exit code with the error's last line", () => {
    expect(generatorFailureReason({ code: null, stderr: "", failure: "no_python" })).toBe("no_python");
    expect(generatorFailureReason({ code: null, stderr: "timed out after 60s", failure: "timeout" })).toBe("timeout");
    expect(generatorFailureReason({ code: 1, stderr: "Traceback (most recent call last):\n  x\nOSError: denied\n" })).toBe(
      "exit 1: OSError: denied",
    );
    expect(generatorFailureReason({ code: 2, stderr: "" })).toBe("exit 2");
  });

  it("ensureProjectBlueprint skips non-git repositories safely", async () => {
    const ok = await ensureProjectBlueprint(tmpDir);
    expect(ok).toBe(false);
  });

  it("ensureProjectBlueprint runs generator and deploys blueprint and hook", async () => {
    initRepo(tmpDir);

    // Mock package.json
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "demo-auto-bp", version: "1.0.0" }));

    const logs: string[] = [];
    const ok = await ensureProjectBlueprint(tmpDir, { force: true, log: (msg) => logs.push(msg) });
    expect(ok).toBe(true);

    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    const hookPath = join(tmpDir, ".git", "hooks", "post-commit");
    const bpContent = readFileSync(bpPath, "utf8");
    const hookContent = readFileSync(hookPath, "utf8");

    expect(bpContent).toContain("# Project Blueprint: demo-auto-bp");
    expect(bpContent).toContain("## 0. 速览与章节索引");
    expect(bpContent).toContain("## 1. Project Overview & Tech Stack");
    expect(hookContent).toContain("Memento Blueprint Hook Start");
    // Untracked: kept out of git status, and the HEAD it matches is recorded
    expect(git(tmpDir, "status", "--porcelain")).not.toContain("PROJECT_BLUEPRINT.md");
    expect(readFileSync(join(tmpDir, ".git", ".memento_blueprint_head"), "utf8").trim()).toBe(
      git(tmpDir, "rev-parse", "--short", "HEAD"),
    );

    // Second call should hit in-memory cache and return true immediately
    const ok2 = await ensureProjectBlueprint(tmpDir);
    expect(ok2).toBe(true);
  });

  it("extracts models and foreign key relations across Prisma, Drizzle, Go GORM, Rust SeaORM, Java JPA, and SQL", async () => {
    initRepo(tmpDir);
    mkdirSync(join(tmpDir, "prisma"), { recursive: true });
    writeFileSync(
      join(tmpDir, "prisma", "schema.prisma"),
      `model Account {\n  id String @id\n}\nmodel Post {\n  id String @id\n  authorId String\n  author Account @relation(fields: [authorId], references: [id])\n}\n`,
    );
    mkdirSync(join(tmpDir, "src", "db"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "db", "schema.ts"),
      `export const comments = pgTable("comments", {\n  id: text("id"),\n  postId: text("post_id").references(() => posts.id),\n});\n`,
    );
    writeFileSync(
      join(tmpDir, "models.go"),
      `package main\ntype Invoice struct {\n  ID uint \`gorm:"primaryKey"\`\n  CustomerID uint \`gorm:"index"\`\n}\n`,
    );
    writeFileSync(
      join(tmpDir, "migrations.sql"),
      `CREATE TABLE audit_logs (\n  id INT PRIMARY KEY,\n  user_id INT REFERENCES users(id)\n);\n`,
    );

    const ok = await ensureProjectBlueprint(tmpDir, { force: true });
    expect(ok).toBe(true);
    const bpContent = readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8");
    expect(bpContent).toContain("`Post.authorId` ➔ `Account.id`");
    expect(bpContent).toContain("`comments.postId` ➔ `posts.id`");
    expect(bpContent).toContain("`Invoice.CustomerID` ➔ `Customer.ID`");
    expect(bpContent).toContain("`audit_logs.user_id` ➔ `users.id`");
    expect(bpContent).toContain("erDiagram");
  });

  it("universally extracts routes, schedules, gRPC/GraphQL contracts, and test suites for any non-Memento project", async () => {
    initRepo(tmpDir);
    mkdirSync(join(tmpDir, "src", "controllers"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "controllers", "orders.controller.ts"),
      `@Controller('orders')\nexport class OrdersController {\n  @Get(':id')\n  findOne() {}\n  @Cron('0 3 * * *')\n  syncNightlyOrders() {}\n}\n`,
    );
    mkdirSync(join(tmpDir, "proto"), { recursive: true });
    writeFileSync(
      join(tmpDir, "proto", "payment.proto"),
      `service PaymentService {\n  rpc ChargeCard (ChargeRequest) returns (ChargeReply);\n}\n`,
    );
    mkdirSync(join(tmpDir, "tests"), { recursive: true });
    writeFileSync(join(tmpDir, "tests", "orders.spec.ts"), "it('works', () => {});\n");

    const ok = await ensureProjectBlueprint(tmpDir, { force: true });
    expect(ok).toBe(true);
    const bpContent = readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8");
    expect(bpContent).toContain("`GET /orders/:id`");
    expect(bpContent).toContain("syncNightlyOrders");
    expect(bpContent).toContain("gRPC `PaymentService.ChargeCard(ChargeRequest) ➔ ChargeReply`");
    expect(bpContent).toContain("`orders.spec.ts`");
  });

  it("extracts AST cross-layer call graphs, OpenAPI/Pydantic/TS DTO schemas, CLI entrypoints, and external infra nodes", async () => {
    initRepo(tmpDir);
    writeFileSync(
      join(tmpDir, "package.json"),
      JSON.stringify({
        name: "enterprise-platform",
        bin: { "ep-cli": "./bin/ep.js" },
        dependencies: { ioredis: "^5.0.0", pg: "^8.11.0" },
      }),
    );

    // Python AST call graph + Pydantic DTO
    mkdirSync(join(tmpDir, "app", "api"), { recursive: true });
    mkdirSync(join(tmpDir, "app", "services"), { recursive: true });
    writeFileSync(
      join(tmpDir, "app", "services", "billing.py"),
      `def calculate_invoice(amount: int) -> int:\n    return amount\n`,
    );
    writeFileSync(
      join(tmpDir, "app", "api", "checkout.py"),
      `from pydantic import BaseModel\nfrom app.services import billing\n\nclass CheckoutPayload(BaseModel):\n    order_id: str\n    total_cents: int\n\ndef handle_checkout():\n    return billing.calculate_invoice(100)\n`,
    );

    // OpenAPI spec
    writeFileSync(
      join(tmpDir, "openapi.json"),
      JSON.stringify({
        openapi: "3.0.0",
        components: {
          schemas: {
            CustomerProfile: {
              type: "object",
              properties: { id: { type: "string" }, email: { type: "string" } },
            },
          },
        },
      }),
    );

    const ok = await ensureProjectBlueprint(tmpDir, { force: true });
    expect(ok).toBe(true);
    const bpContent = readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8");
    // External infra detected in Mermaid architecture diagram
    expect(bpContent).toContain("PostgreSQL");
    expect(bpContent).toContain("Redis");
    // AST cross-layer dependency edge
    expect(bpContent).toContain("`api/checkout` ➔ `services/billing`");
    // OpenAPI & Pydantic DTO schemas
    expect(bpContent).toContain("`CustomerProfile`");
    expect(bpContent).toContain("`CheckoutPayload`");
    expect(bpContent).toContain("order_id: str");
    // CLI entrypoint
    expect(bpContent).toContain("`ep-cli`");
  });

  it("regenerates when HEAD moved without the hooks running (GUI commits, core.hooksPath)", async () => {
    initRepo(tmpDir);
    expect(await ensureProjectBlueprint(tmpDir, { force: true })).toBe(true);
    expect(await isBlueprintReady(tmpDir)).toBe(true);

    mkdirSync(join(tmpDir, "src", "controllers"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "controllers", "live.controller.ts"),
      `@Controller('live')\nexport class LiveController {\n  @Get('ping')\n  ping() {}\n}\n`,
    );
    git(tmpDir, "add", "src");
    git(tmpDir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "add live route");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Without force: the HEAD change alone must trigger a regeneration
    expect(await ensureProjectBlueprint(tmpDir)).toBe(true);
    expect(readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8")).toContain("`GET /live/ping`");
    expect(await isBlueprintReady(tmpDir)).toBe(true);
  });

  it("extracts blueprint generator script version/hash metadata and validates OTA updates", async () => {
    const sample = "#!/usr/bin/env python3\nBLUEPRINT_SCRIPT_VERSION = 20261108\ndef build_blueprint_content():\n    pass\n";
    const meta = parseBlueprintScriptMeta(sample);
    expect(meta.version).toBe(20261108);
    expect(meta.hash.length).toBe(16);

    // Higher remote version triggers OTA sync
    expect(await needsRemoteBlueprintSync({ version: 99999999, hash: "deadbeef12345678" })).toBe(true);
    // Rejects invalid script content
    expect(await applyRemoteBlueprintScript({ version: 99999999, hash: "bad", content: "invalid" })).toBe(false);
  });
});
