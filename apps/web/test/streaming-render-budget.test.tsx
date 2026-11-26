// @vitest-environment happy-dom
// Performance budget for the busiest moment on the AI 执事 page: a reply streaming in. Every new token re-renders
// the page, and the finished turns above it (each a full Markdown render) must not render again. Counted, not
// timed, so it holds on any CI machine.
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const markdownRenders = { count: 0 };
vi.mock("@/components/viewers/MarkdownViewer", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: ({ content }: { content: string }) => {
    markdownRenders.count += 1;
    return <div className="md">{content}</div>;
  },
}));
vi.mock("@/lib/native-notify", () => ({ showInAppToast: vi.fn(), triggerHapticFeedback: vi.fn() }));
vi.mock("@/components/viewers/MediaInspectorContext", () => ({ useMediaInspectorOpen: () => () => {}, useMediaInspector: () => null }));

import { AssistantBubble } from "../src/components/ask/bubbles";
import type { Turn } from "../src/lib/ask/turns";
import zhCN from "../src/lib/i18n/zh-CN";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FINISHED = 40;
const t = zhCN as never;
const noop = () => {};
const finishedTurns: Turn[] = Array.from({ length: FINISHED }, (_, i) => ({ role: "assistant", content: `第 ${i} 轮的回答，带 **Markdown**` }) as Turn);

function Page() {
  const [live, setLive] = useState("");
  (globalThis as { __append?: (s: string) => void }).__append = (s: string) => setLive((v) => v + s);
  return (
    <div>
      {finishedTurns.map((turn, i) => (
        <AssistantBubble key={i} index={i} turn={turn} isLast={false} streaming={false} onSourcesClick={noop} onSmartCompactAndRetry={noop} t={t} />
      ))}
      <AssistantBubble
        index={FINISHED}
        turn={{ role: "assistant", content: live } as Turn}
        isLast={true}
        streaming={true}
        onSourcesClick={noop}
        onSmartCompactAndRetry={noop}
        t={t}
      />
    </div>
  );
}

describe("render budget while a reply streams", () => {
  it("50 streamed tokens re-render only the live turn, never the 40 finished ones", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Page />));
    const afterMount = markdownRenders.count;
    expect(afterMount).toBeGreaterThanOrEqual(FINISHED);

    for (let i = 0; i < 50; i++) {
      await act(async () => (globalThis as { __append?: (s: string) => void }).__append!(`字${i}`));
    }
    const perToken = (markdownRenders.count - afterMount) / 50;
    // The live turn's own Markdown renders once per token (at most twice with its thinking block); anything
    // more means finished turns re-render on every token, which is what makes long conversations stutter.
    expect(perToken).toBeLessThanOrEqual(2);
    act(() => root.unmount());
    host.remove();
  });
});
