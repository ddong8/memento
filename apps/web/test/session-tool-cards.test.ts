import { describe, expect, it } from "vitest";

import { cleanToolOutput, parseToolInput, sessionMessagesToTurns, toolCallDetail } from "@/lib/ask/sessions";

// As collected from an Antigravity session on Windows (2026-11-14), Python repr with JSON-string values
const AGY_RUN =
  "{'CommandLine': '\"Select-String -Path \\\\\"d:\\\\\\\\dev\\\\\\\\style.css\\\\\" -Pattern \\\\\"hero-title\\\\\"\"', 'WaitMsBeforeAsync': '5000', 'toolSummary': '\"Inspect typography\"'}";
const AGY_READ = "{'EndLine': '440', 'Path': '\"d:/dev/eln/TemplateLibraryModal.vue\"', 'StartLine': '390'}";

describe("collected tool calls", () => {
  it("reads Antigravity's Python-repr args", () => {
    const args = parseToolInput(AGY_RUN);
    expect(args?.CommandLine).toBe('Select-String -Path "d:\\dev\\style.css" -Pattern "hero-title"');
    expect(args?.WaitMsBeforeAsync).toBe("5000");
    expect(toolCallDetail(AGY_READ)).toBe("d:/dev/eln/TemplateLibraryModal.vue:390-440");
  });

  it("summarises JSON input and keeps what it can't read", () => {
    expect(toolCallDetail('{"command":"ls -la","description":"list"}')).toBe("ls -la");
    expect(toolCallDetail('{"file_path":"/a/b.ts","old_string":"x"}')).toBe("/a/b.ts");
    expect(toolCallDetail("npm test")).toBe("npm test");
    expect(
      toolCallDetail("{'Arguments': '{\"query\":\"system-ui-fonts\"}', 'ServerName': '\"memento-memory\"', 'ToolName': '\"memory_skill\"'}"),
    ).toBe('memento-memory/memory_skill  {"query":"system-ui-fonts"}');
    expect(toolCallDetail("{'Action': '\"status\"', 'TaskId': '\"t-1\"', 'toolSummary': '\"x\"'}")).toBe("Action: status  TaskId: t-1");
  });

  it("drops Antigravity's step header from the output", () => {
    const out = cleanToolOutput(
      "Created At: 2026-11-14T10:42:57+08:00\nCompleted At: 2026-11-14T10:43:02+08:00\nCommand exited with code 1.\n\nCommand output:\n\r\nLineNumber Line\r\n35 --user-bubble\n",
    );
    expect(out).toEqual({ stdout: "LineNumber Line\n35 --user-bubble", exitCode: 1 });
    expect(cleanToolOutput("Created At: x\nCompleted At: y\nShowing lines 1-60 of 227\n1: <template>").stdout).toBe(
      "Showing lines 1-60 of 227\n1: <template>",
    );
  });

  it("puts the cleaned call and output on the card", () => {
    const turns = sessionMessagesToTurns([
      { role: "user", content: "字体优化一下" },
      { role: "tool", raw_type: "tool_call", tool_name: "run_command", tool_input: AGY_RUN },
      { role: "tool", content: "Created At: a\nCompleted At: b\nCommand exited with code 0.\n\nCommand output:\nok" },
    ]);
    const call = turns[1].toolCalls?.[0];
    expect(call?.args).toEqual({ command: 'Select-String -Path "d:\\dev\\style.css" -Pattern "hero-title"' });
    expect(call?.result).toMatchObject({ stdout: "ok", exit_code: 0, status: "succeeded" });
  });
});
