// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskTopBar } from "../src/components/ask/AskTopBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe("AskTopBar button placement", () => {
  it("renders history button next to new chat button and invokes onOpenHistory", async () => {
    const onOpenHistory = vi.fn();
    const onNewChat = vi.fn();

    root = createRoot(host);
    await act(async () => {
      root!.render(
        <AskTopBar
          conversationCount={12}
          turnCount={2}
          activeConversationId="conv-123"
          title="在吗"
          agent={{ id: "antigravity", name: "Antigravity", brandId: "antigravity" }}
          agentColor="#3186FF"
          executionMode="antigravity"
          selectedDevice="DESKTOP-KR9IPP4"
          quotasData={null}
          selecting={false}
          onOpenHistory={onOpenHistory}
          onOpenQuota={vi.fn()}
          onNewChat={onNewChat}
          onToggleSelectTurns={vi.fn()}
          onExportMarkdown={vi.fn()}
          onShare={vi.fn()}
        />
      );
    });

    // Check history button is present with count 12
    const buttons = Array.from(host.querySelectorAll("button"));
    const historyBtn = buttons.find((b) => b.getAttribute("title")?.includes("历史对话"));
    expect(historyBtn).toBeDefined();
    expect(historyBtn?.textContent).toContain("12");

    // Check new chat button is present
    const newChatBtn = buttons.find((b) => b.getAttribute("title")?.includes("新建") || b.getAttribute("title")?.includes("New"));
    expect(newChatBtn).toBeDefined();

    // Verify historyBtn is placed next to newChatBtn (same parent container)
    expect(historyBtn?.parentElement).toBe(newChatBtn?.parentElement);

    // Click history button
    await act(async () => {
      historyBtn?.click();
    });
    expect(onOpenHistory).toHaveBeenCalledTimes(1);

    // Open more menu
    const moreBtn = buttons.find((b) => b.getAttribute("title")?.includes("更多"));
    expect(moreBtn).toBeDefined();
    await act(async () => {
      moreBtn?.click();
    });

    // Verify more menu dropdown does NOT duplicate the history button
    const moreMenuDropdown = host.querySelector(".animate-in");
    expect(moreMenuDropdown).toBeDefined();
    const dropdownText = moreMenuDropdown?.textContent ?? "";
    expect(dropdownText).not.toContain("历史对话");
  });
});
