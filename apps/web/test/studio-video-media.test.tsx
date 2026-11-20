// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMediaType, resolveMediaUrl } from "../src/components/viewers/media-utils";
import MarkdownViewer from "../src/components/viewers/MarkdownViewer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Studio published video inline playback in chat", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("detects signed /api/media/video/... URLs as video and resolves playUrl cleanly", () => {
    const url = "/api/media/video/videos/u/uid1/abc123.mp4?exp=1800000000&sig=deadbeef";
    expect(detectMediaType(url)).toBe("video");
    const resolved = resolveMediaUrl(url);
    expect(resolved.isLocal).toBe(false);
    expect(resolved.filename).toBe("abc123.mp4");
    expect(resolved.playUrl).toContain("/api/media/video/videos/u/uid1/abc123.mp4");
  });

  it("renders inline VideoPlayer directly inside MarkdownViewer chat bubble", async () => {
    const md =
      "演播台成片已归档，可直接在对话内播放：\n\n" +
      "![《夜班守墓人七条铁律》第1集](/api/media/video/videos/u/uid1/abc123.mp4?exp=1800000000&sig=deadbeef)\n\n" +
      "- [在演播台继续精修](/studio?project=p1&episode=ep1)";

    await act(async () => {
      root.render(<MarkdownViewer content={md} />);
    });

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("src") || "").toContain("/api/media/video/videos/u/uid1/abc123.mp4");
    const studioLink = container.querySelector('a[href="/studio?project=p1&episode=ep1"]');
    expect(studioLink).not.toBeNull();
  });
});
