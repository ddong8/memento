import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  extractTitleFromTranscript,
  extractUserTitleFromText,
  healAntigravitySession,
  isJunkAntigravityTitle,
  updateAntigravitySessionTitle,
} from "../src/antigravity.js";

describe("Antigravity Title Synchronization and Healing", () => {
  it("detects junk titles correctly", () => {
    expect(isJunkAntigravityTitle("")).toBe(true);
    expect(isJunkAntigravityTitle("   ")).toBe(true);
    expect(isJunkAntigravityTitle("Starting The Conversation")).toBe(true);
    expect(isJunkAntigravityTitle("Starting The Conversation...")).toBe(true);
    expect(isJunkAntigravityTitle("starting conversation")).toBe(true);
    expect(isJunkAntigravityTitle("start")).toBe(true);
    expect(isJunkAntigravityTitle("Untitled")).toBe(true);
    expect(isJunkAntigravityTitle("新对话")).toBe(true);
    expect(isJunkAntigravityTitle("52792607-32d2-4269-9261-4ad32e87108e")).toBe(true);
    expect(isJunkAntigravityTitle("transcript.jsonl")).toBe(true);
    expect(isJunkAntigravityTitle("<user_request>test")).toBe(true);
    expect(isJunkAntigravityTitle("{\"type\":\"step\"}")).toBe(true);

    // Valid business titles
    expect(isJunkAntigravityTitle("测试workbuddy会话执行")).toBe(false);
    expect(isJunkAntigravityTitle("帮我将本机的flutter版本的memento卸载干净吧")).toBe(false);
    expect(isJunkAntigravityTitle("修复标题跨端不一致问题")).toBe(false);
  });

  it("extracts clean title from raw user text with metadata tags", () => {
    const rawWithTags = `<USER_REQUEST>\n帮我将本机的flutter版本的memento卸载干净吧\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-10-01T12:53:14+08:00.\n</ADDITIONAL_METADATA>`;
    const title = extractUserTitleFromText(rawWithTags);
    expect(title).toBe("帮我将本机的flutter版本的memento卸载干净吧");

    const rawPlain = "在吗\n第二行内容\n第三行内容";
    expect(extractUserTitleFromText(rawPlain)).toBe("在吗");
  });

  it("extracts title from transcript jsonl lines", () => {
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "<USER_REQUEST>\n拉一下最新代码吧\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        content: "正在为您拉取最新代码...",
      }),
    ];

    const title = extractTitleFromTranscript(lines);
    expect(title).toBe("拉一下最新代码吧");
  });

  it("extracts title from transcript file with streaming without reading whole file", () => {
    const testDir = mkdtempSync(join(tmpdir(), "memento-test-stream-"));
    try {
      const filePath = join(testDir, "transcript.jsonl");
      const lines = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: "<USER_REQUEST>\n优化流式解析与内存占用\n</USER_REQUEST>",
        }),
        JSON.stringify({
          step_index: 1,
          source: "MODEL",
          type: "PLANNER_RESPONSE",
          content: "正在为您执行优化...",
        }),
      ];
      // Append some trailing dummy lines
      for (let i = 2; i < 100; i++) {
        lines.push(JSON.stringify({ step_index: i, content: "x".repeat(1024) }));
      }
      writeFileSync(filePath, lines.join("\n"), "utf8");

      const title = extractTitleFromTranscript(filePath);
      expect(title).toBe("优化流式解析与内存占用");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("updates SQLite db and annotations file and heals title", () => {
    const testHome = mkdtempSync(join(tmpdir(), "memento-test-agy-"));
    try {
      const agyDir = join(testHome, ".gemini", "antigravity");
      mkdirSync(agyDir, { recursive: true });
      const dbPath = join(agyDir, "conversation_summaries.db");

      // Initialize test sqlite database
      const pyBin = process.platform === "win32" ? "python" : "python3";
      const initScript = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, workspace_uris text, status text);")
conn.execute("INSERT INTO conversation_summaries VALUES ('sess-123', 'Starting The Conversation', 'file:///test', 'active');")
conn.commit()
conn.close()
`;
      execFileSync(pyBin, ["-c", initScript, dbPath]);

      const sessionId = "sess-123";
      const lines = [
        JSON.stringify({
          step_index: 0,
          source: "USER_EXPLICIT",
          type: "USER_INPUT",
          content: "<USER_REQUEST>\n全部实施吧\n</USER_REQUEST>",
        }),
      ];

      // Auto-heal
      const healed = healAntigravitySession(sessionId, lines, "Starting The Conversation", testHome);
      expect(healed).toBe("全部实施吧");

      // Verify annotations file
      const annPath = join(agyDir, "annotations", `${sessionId}.pbtxt`);
      const annContent = readFileSync(annPath, "utf8");
      expect(annContent).toContain('title:"全部实施吧"');

      // Verify sqlite db updated
      const checkScript = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
cursor = conn.execute("SELECT title FROM conversation_summaries WHERE conversation_id = 'sess-123'")
print(cursor.fetchone()[0])
conn.close()
`;
      const output = execFileSync(pyBin, ["-c", checkScript, dbPath], { encoding: "utf8" }).trim();
      expect(output).toBe("全部实施吧");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
});
