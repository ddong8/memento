// Antigravity 2.34's desktop app keeps its language server's CSRF token to the processes it starts (no
// --csrf_token argument, an empty csrfToken in its page), so agentapi calls from the daemon come back
// "missing CSRF token": tasks go to Google's agy CLI then, not round every model tier.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  antigravityCliHasConversation,
  antigravityDesktopHasConversation,
  antigravityDesktopTranscriptContext,
  getAntigravitySessionInfo,
  isAppAuthRejection,
  updateAntigravitySessionTitle,
} from "../src/antigravity.js";
import { sqliteRun } from "../src/sqlite.js";
import { isSessionNotFound } from "../src/task-adapters.js";

it("tells the language server's CSRF rejection from other failures", () => {
  const reply =
    '{ "response": {}, "error": "failed to fetch available models: rpc error: code = Unauthenticated desc = unauthenticated: missing CSRF token" }';
  expect(isAppAuthRejection(reply)).toBe(true);
  expect(isAppAuthRejection("rpc error: code = Unauthenticated desc = invalid CSRF token")).toBe(true);
  expect(isAppAuthRejection("No capacity available for model claude-opus-5-5-high (code 503)")).toBe(false);
  expect(isAppAuthRejection("conversation not found")).toBe(false);
});

it("treats agy CLI trajectory-not-found errors as session-not-found", () => {
  expect(
    isSessionNotFound("error: failed to send message: not_found: trajectory not found: 4ff9e5c4-d996-4f5e-b804-ea6c72eea91d: not found"),
  ).toBe(true);
});

it("detects desktop-only vs CLI Antigravity conversations and extracts clean desktop context", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-bridge-"));
  const deskSid = "4ff9e5c4-d996-4f5e-b804-ea6c72eea91d";
  const cliSid = "bb9866e5-3f62-49fa-83e4-e678502d1722";
  try {
    const deskLogs = join(home, ".gemini", "antigravity", "brain", deskSid, ".system_generated", "logs");
    const cliConvs = join(home, ".gemini", "antigravity-cli", "conversations");
    mkdirSync(deskLogs, { recursive: true });
    mkdirSync(cliConvs, { recursive: true });
    writeFileSync(join(cliConvs, `${cliSid}.db`), "sqlite-bytes");
    writeFileSync(
      join(deskLogs, "transcript.jsonl"),
      [
        JSON.stringify({
          type: "USER_INPUT",
          source: "USER_EXPLICIT",
          content: "<USER_REQUEST>\n优化客户端卡顿\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ts</ADDITIONAL_METADATA>",
        }),
        JSON.stringify({
          type: "USER_INPUT",
          source: "SYSTEM",
          content: "<SYSTEM_MESSAGE>background task finished</SYSTEM_MESSAGE>",
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          source: "MODEL",
          content: "已完成渲染优化并发布 v1.0.148。",
        }),
      ].join("\n") + "\n",
    );

    expect(antigravityDesktopHasConversation(deskSid, home)).toBe(true);
    expect(antigravityCliHasConversation(deskSid, home)).toBe(false);
    expect(antigravityCliHasConversation(cliSid, home)).toBe(true);

    const ctx = antigravityDesktopTranscriptContext(deskSid, home);
    expect(ctx).toContain("续接自 Antigravity 桌面会话 4ff9e5c4");
    expect(ctx).toContain("用户: 优化客户端卡顿");
    expect(ctx).toContain("助手: 已完成渲染优化并发布 v1.0.148。");
    expect(ctx).not.toContain("SYSTEM_MESSAGE");
    expect(ctx).not.toContain("ADDITIONAL_METADATA");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("reads and updates Antigravity session titles in both desktop and official CLI SQLite stores", () => {
  const home = mkdtempSync(join(tmpdir(), "agy-cli-title-"));
  const cliSid = "bb9866e5-3f62-49fa-83e4-e678502d1722";
  try {
    const cliDir = join(home, ".gemini", "antigravity-cli");
    mkdirSync(cliDir, { recursive: true });
    const dbPath = join(cliDir, "conversation_summaries.db");
    const created = sqliteRun(
      dbPath,
      "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, status TEXT DEFAULT 'active')",
    );
    if (!created) return; // skip if sqlite3 unavailable in minimal env
    sqliteRun(
      dbPath,
      "INSERT INTO conversation_summaries (conversation_id, title, workspace_uris, status) VALUES (?, ?, ?, 'active')",
      [cliSid, "", '["file:///Users/test/dev/memento"]'],
    );
    expect(updateAntigravitySessionTitle(cliSid, "客户端性能优化", home)).toBe(true);
    const info = getAntigravitySessionInfo(cliSid, home);
    expect(info?.title).toBe("客户端性能优化");
    expect(info?.projectName).toBe("memento");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
