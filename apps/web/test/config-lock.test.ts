import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conversationConfigLocked } from "../src/lib/ask/config-lock";

const page = readFileSync(join(__dirname, "../src/app/ask/page.tsx"), "utf8");

describe("a started conversation keeps its agent, device, project and session", () => {
  it("is locked once it has a turn, open to any choice before", () => {
    expect(conversationConfigLocked([])).toBe(false);
    expect(conversationConfigLocked([{ role: "user", content: "hi" }])).toBe(true);
  });

  it("the agent, device, code device, project, session and folder can't be switched; model and effort still can", () => {
    for (const handler of ["handleSelectMode", "handleDeviceChange", "handleCodeDeviceChange"]) {
      expect(page).toMatch(new RegExp(`const ${handler} = \\([^)]*\\) => \\{\\n\\s*if \\(configLockedRef\\.current\\) return;`));
    }
    expect(page).toContain('].filter((m) => !configLocked || m.id === executionMode)');
    expect(page).toContain("value={selectedProjectId}\n                    disabled={configLocked}");
    expect(page).toContain("disabled={loadingSessions || configLocked}");
    expect(page).toContain("readOnly={configLocked}");
    expect(page).toContain('onExit={configLocked ? undefined : () => handleSelectSession("")}');
    // The model picker stays as it was
    expect(page).not.toMatch(/value=\{selectedModel\}\s*\n\s*disabled=\{configLocked\}/);
  });

  it("says why, with a way to a new chat", () => {
    expect(page).toContain("{t.ask.configLocked}");
    expect(page).toMatch(/configLocked && \(\s*<div\s*role="note"[\s\S]{0,1600}onClick=\{startNewChat\}/);
  });
});
