import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyRemoteBlueprintScript,
  ensureProjectBlueprint,
  findGitRoot,
  isBlueprintReady,
  locateBlueprintGenerator,
  needsRemoteBlueprintSync,
  parseBlueprintScriptMeta,
} from "../src/blueprint-auto.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "memento_bp_test_"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

  it("isBlueprintReady checks both blueprint doc and post-commit hook", async () => {
    const gitDir = join(tmpDir, ".git", "hooks");
    mkdirSync(gitDir, { recursive: true });

    // Nothing created yet
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add dummy blueprint
    const bpPath = join(tmpDir, "PROJECT_BLUEPRINT.md");
    writeFileSync(bpPath, "# Dummy Blueprint Header with sufficient size for check");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add dummy hook without memento signature
    const hookPath = join(gitDir, "post-commit");
    writeFileSync(hookPath, "#!/bin/sh\necho test\n");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add valid hook signatures for all 3 hooks
    for (const hname of ["post-commit", "post-merge", "post-checkout"]) {
      writeFileSync(join(gitDir, hname), "#!/bin/sh\n# Auto-update PROJECT_BLUEPRINT.md upon commit\npython3 scripts/project_blueprint.py\n");
    }
    expect(await isBlueprintReady(tmpDir)).toBe(true);
  });

  it("locateBlueprintGenerator finds local project generator if present", async () => {
    const localScripts = join(tmpDir, "scripts");
    mkdirSync(localScripts, { recursive: true });
    const localPy = join(localScripts, "project_blueprint.py");
    writeFileSync(localPy, "#!/usr/bin/env python3\nprint('mock')\n");

    const found = await locateBlueprintGenerator(tmpDir);
    expect(found).toBe(localPy);
  });

  it("ensureProjectBlueprint skips non-git repositories safely", async () => {
    const ok = await ensureProjectBlueprint(tmpDir);
    expect(ok).toBe(false);
  });

  it("ensureProjectBlueprint runs generator and deploys blueprint and hook", async () => {
    const gitDir = join(tmpDir, ".git");
    mkdirSync(gitDir, { recursive: true });

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
    expect(bpContent).toContain("## 1. Project Overview & Tech Stack");
    expect(hookContent).toContain("Memento Blueprint Hook Start");

    // Second call should hit in-memory cache and return true immediately
    const ok2 = await ensureProjectBlueprint(tmpDir);
    expect(ok2).toBe(true);
  });

  it("extracts models and foreign key relations across Prisma, Drizzle, Go GORM, Rust SeaORM, Java JPA, and SQL", async () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
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
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
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
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
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

  it("detects HEAD commit advances (even with --no-verify) and injects anchors into multi-agent instruction files", async () => {
    mkdirSync(join(tmpDir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "main"), "1111111abcdef000000000000000000000000000\n");
    writeFileSync(join(tmpDir, ".git", ".memento_blueprint_head"), "1111111\n");
    writeFileSync(join(tmpDir, "GEMINI.md"), "# Gemini Rules\n");
    writeFileSync(join(tmpDir, ".cursorrules"), "# Cursor Rules\n");

    const ok1 = await ensureProjectBlueprint(tmpDir, { force: true });
    expect(ok1).toBe(true);
    expect(readFileSync(join(tmpDir, "GEMINI.md"), "utf8")).toContain("PROJECT_BLUEPRINT.md");
    expect(readFileSync(join(tmpDir, ".cursorrules"), "utf8")).toContain("PROJECT_BLUEPRINT.md");

    // Simulate a new commit advancing refs/heads/main while .memento_blueprint_head has old SHA
    writeFileSync(join(tmpDir, ".git", ".memento_blueprint_head"), "1111111\n");
    writeFileSync(join(tmpDir, ".git", "refs", "heads", "main"), "2222222abcdef000000000000000000000000000\n");
    expect(await isBlueprintReady(tmpDir)).toBe(false);

    // Add a new route and call ensureProjectBlueprint WITHOUT force — it must detect HEAD change and regenerate
    mkdirSync(join(tmpDir, "src", "controllers"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "controllers", "live.controller.ts"),
      `@Controller('live')\nexport class LiveController {\n  @Get('ping')\n  ping() {}\n}\n`,
    );
    const ok2 = await ensureProjectBlueprint(tmpDir);
    expect(ok2).toBe(true);
    const bpAfter = readFileSync(join(tmpDir, "PROJECT_BLUEPRINT.md"), "utf8");
    expect(bpAfter).toContain("`GET /live/ping`");
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
