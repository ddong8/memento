// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Test projects the user doesn't want collected (2026-11-17). The dialog says what goes before
// anything is deleted, and only the confirm button asks the server to exclude it.

const calls: { url: string; method: string; body?: string }[] = [];
vi.mock("@/lib/api-client", () => ({
  getApiBase: () => "",
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method || "GET", body: init?.body as string | undefined });
    if (url.startsWith("/api/collect/exclusions/preview")) {
      return new Response(JSON.stringify({
        key: "demotest", names: ["demo-test"], documents: 3, messages: 1200, memories: 4, skills: 1,
        corrections: 0, todos: 2, profile_rules: 3,
      }));
    }
    return new Response(JSON.stringify({ item: { key: "demotest", name: "demo-test", state: "purging", added_at: "", updated_at: "" } }));
  }),
}));

import { ExcludeProjectDialog, previewLines } from "../src/components/collector/ProjectExclusion";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  calls.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("not collecting a project", () => {
  it("says what is deleted and what is only put aside", () => {
    const lines = previewLines({ key: "x", names: [], documents: 3, messages: 1200, memories: 4, skills: 1, corrections: 0, todos: 2, profile_rules: 3 });
    expect(lines.gone).toEqual(["3 个会话文件（1,200 条消息）"]);
    expect(lines.paused).toEqual(["4 条记忆和避坑", "1 个技能", "2 条自动生成的待办", "画像里 3 条项目规则"]);
  });

  it("shows the preview first and excludes only on confirm", async () => {
    const done = vi.fn();
    await act(async () => {
      root.render(<ExcludeProjectDialog name="demo-test" open onClose={() => {}} onDone={done} />);
    });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("不再采集「demo-test」");
    expect(dialog.textContent).toContain("3 个会话文件");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);

    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent === "不再采集")!;
    await act(async () => {
      confirm.click();
    });
    expect(calls[1]).toMatchObject({ url: "/api/collect/exclusions", method: "POST", body: JSON.stringify({ name: "demo-test" }) });
    expect(done).toHaveBeenCalled();
  });
});
