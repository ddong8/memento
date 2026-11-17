// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Project conversations and the timeline load a preview of each session (2026-11-17: one long
// session was 840 KB of an 880 KB first page). Nothing may be lost: the button gets every message.

const fetched: string[] = [];
vi.mock("@/lib/api-client", () => ({
  getApiBase: () => "",
  authFetch: vi.fn(async (url: string) => {
    fetched.push(url);
    const messages = Array.from({ length: 120 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第 ${i + 1} 条` }));
    return new Response(JSON.stringify({ sessions: [{ messages }] }), { status: 200 });
  }),
}));

import { MoreMessages } from "../src/components/viewers/MoreMessages";
import { PREVIEW_MESSAGES, sessionsUrl } from "../src/lib/session-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fetched.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("session previews", () => {
  it("asks each page for a preview of every session, not every message", () => {
    const url = sessionsUrl("p1", 5, "desc");
    expect(url).toContain("session_offset=5");
    expect(url).toContain("order=desc");
    expect(url).toContain(`max_messages_per_session=${PREVIEW_MESSAGES}`);
  });

  it("loads the whole session when the reader asks for the rest", async () => {
    const got: unknown[][] = [];
    act(() => {
      root.render(
        <MoreMessages projectId="p1" conversationId="c-9" hidden={80} order="desc" locale="zh-CN" onLoaded={(m) => got.push(m)} />,
      );
    });
    const button = host.querySelector("button")!;
    expect(button.textContent).toContain("展开前面 80 条");
    await act(async () => {
      button.click();
    });
    expect(fetched).toEqual(["/api/projects/p1/conversations?conversation_id=c-9&session_limit=1&order=asc&artifacts=false"]);
    expect(got).toHaveLength(1);
    expect(got[0]).toHaveLength(120);
  });
});
