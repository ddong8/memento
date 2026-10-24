import { describe, expect, it } from "vitest";
import type { DeviceSummary } from "../src/lib/api-client";
import { AGENT_TOOL_ID, cascadeOf, configHas, usableDevice } from "../src/lib/ask/cascade";

const mini = { device_id: "tok-mini", name: "haixingdeMac-mini.local (Darwin)" } as DeviceSummary;

describe("device / project / session cascade", () => {
  it("takes every field from the conversation, empty ones included", () => {
    // Opening a conversation without a project or session must not keep the previous one's
    expect(cascadeOf({ executionMode: "claude", cwd: "/w" })).toEqual({
      device: "auto",
      cwd: "/w",
      projectId: "",
      projectTitle: "",
      sessionId: "",
    });
    expect(cascadeOf(undefined).device).toBe("auto");
    expect(
      cascadeOf({ selectedDevice: "tok-mini", selectedProjectId: "p1", selectedProjectTitle: "memento", selectedSessionId: "s1" })
    ).toMatchObject({ device: "tok-mini", projectId: "p1", projectTitle: "memento", sessionId: "s1" });
  });

  it("treats a device that is no longer registered as auto, once the list is known", () => {
    expect(usableDevice("tok-mini", [mini])).toBe("tok-mini");
    // An old conversation's merged / removed machine: the selector showed its raw id with empty lists
    expect(usableDevice("c74d3432-1660-4c0e-9a1b-000000000000", [mini])).toBe("auto");
    // Before the list arrives nothing can be told
    expect(usableDevice("c74d3432-1660-4c0e-9a1b-000000000000", [])).toBe("c74d3432-1660-4c0e-9a1b-000000000000");
    expect(usableDevice("ask_only", [mini])).toBe("ask_only");
    expect(usableDevice("", [mini])).toBe("auto");
  });

  it("tells a cleared project or session from one never saved", () => {
    expect(configHas({ session_id: "" }, "session_id")).toBe(true);
    expect(configHas({ execution_mode: "claude" }, "session_id")).toBe(false);
    expect(configHas(undefined, "session_id")).toBe(false);
  });

  it("only agent modes have projects and sessions", () => {
    expect(AGENT_TOOL_ID.claude).toBe("claude_code");
    expect(AGENT_TOOL_ID.shell).toBeUndefined();
    expect(AGENT_TOOL_ID.ai).toBeUndefined();
  });
});
