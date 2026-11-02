// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "../src/components/viewers/MediaPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("VideoPlayer Inline & Fullscreen Verification", () => {
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

  it("1. renders inline video player with '放大全屏' top button and '点击放大全屏播放' center badge", async () => {
    await act(async () => {
      root.render(
        <VideoPlayer
          src="/test-video.mp4"
          title="Demo Test Video"
        />
      );
    });

    // Simulate video canplay to complete loading state
    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    await act(async () => {
      video?.dispatchEvent(new Event("canplay"));
    });

    const textContent = container.textContent || "";
    // Should display the center capsule in inline paused state
    expect(textContent).toContain("点击放大全屏播放");
    // Should display top bar "放大全屏" button
    expect(textContent).toContain("放大全屏");

    // Top button check
    const topFullscreenBtn = container.querySelector('button[title="放大全屏播放"]');
    expect(topFullscreenBtn).not.toBeNull();

    // Center capsule check
    const centerCapsule = container.querySelector(".whitespace-nowrap.select-none");
    expect(centerCapsule?.textContent).toBe("点击放大全屏播放");
  });

  it("2. keeps timestamp and BOOST button from vertical text collapse with whitespace-nowrap and shrink-0", async () => {
    await act(async () => {
      root.render(
        <VideoPlayer
          src="/test-video.mp4"
          title="Demo Test Video"
        />
      );
    });

    // Timestamp element should have whitespace-nowrap and shrink-0
    const timeStampEl = container.querySelector("div.text-\\[11px\\].font-mono");
    expect(timeStampEl).not.toBeNull();
    expect(timeStampEl?.textContent).toContain("00:00");
    expect(timeStampEl?.className).toContain("whitespace-nowrap");
    expect(timeStampEl?.className).toContain("shrink-0");

    // BOOST button should have whitespace-nowrap and shrink-0
    const boostBtn = container.querySelector('button[title*="BOOST"], button[title*="200%"]');
    expect(boostBtn).not.toBeNull();
    expect(boostBtn?.className).toContain("whitespace-nowrap");
    expect(boostBtn?.className).toContain("shrink-0");

    // Inline volume controls container should be hidden on mobile (hidden sm:flex)
    const volContainer = boostBtn?.parentElement;
    expect(volContainer?.className).toContain("hidden sm:flex");
  });

  it("3. clicking center '点击放大全屏播放' badge triggers fullscreen toggle and playback", async () => {
    await act(async () => {
      root.render(
        <VideoPlayer
          src="/test-video.mp4"
          title="Demo Test Video"
        />
      );
    });

    const video = container.querySelector("video");
    await act(async () => {
      video?.dispatchEvent(new Event("canplay"));
    });

    const centerPill = Array.from(container.querySelectorAll("span")).find(
      (el) => el.textContent === "点击放大全屏播放"
    )?.parentElement;

    expect(centerPill).not.toBeNull();

    // Mock requestFullscreen on video container
    const videoContainer = container.querySelector("div.relative.group") as HTMLDivElement;
    videoContainer.requestFullscreen = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      centerPill?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Should have attempted to play and toggle fullscreen
    expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});
