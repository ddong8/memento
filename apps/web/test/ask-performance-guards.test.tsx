// @vitest-environment happy-dom
import React, { useEffect, useRef } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  MediaInspectorProvider,
  useMediaInspector,
  useMediaInspectorActions,
} from "../src/components/viewers/MediaInspectorContext";
import MarkdownViewer, { loadRehypeExtras } from "../src/components/viewers/MarkdownViewer";
import { AskComposer, type AskComposerHandle } from "../src/components/ask/AskComposer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Ask & Markdown performance guards", () => {
  it("MediaInspector state changes never re-render MarkdownViewer or change actions reference", async () => {
    await loadRehypeExtras();
    const actionsRefs: unknown[] = [];
    const renderLog: number[] = [];

    const TrackedMarkdown = React.memo(function TrackedMarkdown({ content }: { content: string }) {
      const actions = useMediaInspectorActions();
      useEffect(() => {
        actionsRefs.push(actions);
        renderLog.push(1);
      });
      return <MarkdownViewer content={content} />;
    });

    function InspectorDriver() {
      const inspector = useMediaInspector();
      return (
        <div>
          <span data-testid="open">{String(Boolean(inspector?.isOpen))}</span>
          <button
            type="button"
            data-testid="open-btn"
            onClick={() => inspector?.openMediaByUrl("/tmp/demo.mp4", "demo.mp4")}
          >
            open
          </button>
        </div>
      );
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <MediaInspectorProvider>
          <InspectorDriver />
          <TrackedMarkdown content={"普通段落文本\n\n```ts\nconst x = 1;\n```"} />
        </MediaInspectorProvider>
      );
    });

    const rendersBefore = renderLog.length;
    expect(host.querySelector('[data-testid="open"]')?.textContent).toBe("false");

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="open-btn"]')?.click();
    });

    expect(host.querySelector('[data-testid="open"]')?.textContent).toBe("true");
    expect(renderLog.length).toBe(rendersBefore);
    expect(new Set(actionsRefs).size).toBe(1);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("AskComposer keeps keystrokes isolated so parent component does not re-render while typing", async () => {
    const parentRenderLog: number[] = [];
    const synced: string[] = [];
    const sent: string[] = [];
    const composerHolder: { current: AskComposerHandle | null } = { current: null };

    function ParentHarness() {
      useEffect(() => {
        parentRenderLog.push(1);
      });
      const turnsRef = useRef([{ role: "user" as const, content: "上一条历史问题" }]);
      const bottomRef = useRef<HTMLDivElement | null>(null);
      const onCacheSync = React.useCallback((v: string) => synced.push(v), []);
      const onSendText = React.useCallback((t: string) => sent.push(t), []);
      const noop = React.useCallback(() => {}, []);
      const setHandle = React.useCallback((h: AskComposerHandle | null) => {
        composerHolder.current = h;
      }, []);

      return (
        <AskComposer
          ref={setHandle}
          initialValue=""
          onCacheSync={onCacheSync}
          onSendText={onSendText}
          onStop={noop}
          onPaste={noop}
          onOpenFilePicker={noop}
          onToggleVoice={noop}
          onFocusMobileCollapse={noop}
          onWarmupAsk={noop}
          onDeviceSwitch={noop}
          turnsRef={turnsRef}
          bottomRef={bottomRef}
          devices={[]}
          selectedDevice="auto"
          configLocked={false}
          executionMode="claude"
          streaming={false}
          isReconnecting={false}
          isRecordingVoice={false}
          attachedImageCount={0}
          placeholderText="Ask..."
          sendLabel="发送"
          stopLabel="停止"
          isZh={true}
        />
      );
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<ParentHarness />);
    });

    expect(parentRenderLog.length).toBe(1);
    const textarea = host.querySelector("textarea")!;
    expect(textarea).toBeTruthy();

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    for (const ch of ["你", "你好", "你好世界"]) {
      await act(async () => {
        setter?.call(textarea, ch);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    // Typing multiple characters caused 0 parent re-renders
    expect(parentRenderLog.length).toBe(1);
    expect(composerHolder.current?.getValue()).toBe("你好世界");
    expect(synced[synced.length - 1]).toBe("你好世界");

    // Pressing Enter on desktop submits trimmed text and clears input without re-rendering parent
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(sent).toEqual(["你好世界"]);
    expect(composerHolder.current?.getValue()).toBe("");
    expect(parentRenderLog.length).toBe(1);

    // ArrowUp recalls previous user prompt
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    });
    expect(composerHolder.current?.getValue()).toBe("上一条历史问题");
    expect(parentRenderLog.length).toBe(1);

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("MarkdownViewer reuses singleton highlight plugin across renders without breaking syntax highlighting", async () => {
    const extras = await loadRehypeExtras();
    expect(extras.highlight()).toBe(extras.highlight());
    expect(extras.raw()).toBe(extras.raw());
    expect(extras.pluginsHighlight).toHaveLength(1);
    expect(extras.pluginsRaw).toHaveLength(1);
    expect(extras.pluginsBoth).toHaveLength(2);
    vi.restoreAllMocks();
  });
});
