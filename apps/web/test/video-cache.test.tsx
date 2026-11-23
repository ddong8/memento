// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "../src/components/viewers/MediaPreview";
import { studioEpisodeVideoUrl } from "../src/lib/studio-api";
import {
  _resetVideoCacheForTests,
  cacheVideoInBackground,
  evictCachedVideo,
  getCachedVideoUrl,
  peekCachedVideoUrl,
  videoCacheKey,
} from "../src/lib/video-cache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createMockCacheStorage() {
  const store = new Map<string, Response>();
  const cacheObj = {
    match: vi.fn(async (key: RequestInfo | URL) => {
      const k = typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
      const found = store.get(k);
      return found ? found.clone() : undefined;
    }),
    put: vi.fn(async (key: RequestInfo | URL, resp: Response) => {
      const k = typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
      store.set(k, resp.clone());
    }),
    delete: vi.fn(async (key: RequestInfo | URL) => {
      const k = typeof key === "string" ? key : key instanceof URL ? key.href : key.url;
      return store.delete(k);
    }),
  };
  return {
    store,
    cacheObj,
    storage: {
      open: vi.fn(async () => cacheObj),
    },
  };
}

describe("Video client cache and Studio deterministic URL", () => {
  let container: HTMLDivElement;
  let root: Root;
  let origCaches: unknown;
  let origFetch: typeof globalThis.fetch;
  let origCreateObjUrl: typeof URL.createObjectURL;
  let origRevokeObjUrl: typeof URL.revokeObjectURL;
  let blobSeq = 0;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const lsStore = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => lsStore.get(k) ?? null,
      setItem: (k: string, v: string) => {
        lsStore.set(k, String(v));
      },
      removeItem: (k: string) => {
        lsStore.delete(k);
      },
      clear: () => {
        lsStore.clear();
      },
    });
    _resetVideoCacheForTests();
    blobSeq = 0;
    origCaches = (globalThis as Record<string, unknown>).caches;
    origFetch = globalThis.fetch;
    origCreateObjUrl = URL.createObjectURL;
    origRevokeObjUrl = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => `blob:memento-test-${++blobSeq}`);
    URL.revokeObjectURL = vi.fn();
    window.HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    window.HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    _resetVideoCacheForTests();
    (globalThis as Record<string, unknown>).caches = origCaches;
    globalThis.fetch = origFetch;
    URL.createObjectURL = origCreateObjUrl;
    URL.revokeObjectURL = origRevokeObjUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes video cache keys by stripping rotating auth params while preserving render version", () => {
    const k1 = videoCacheKey("/api/studio/episodes/ep1/latest-video?token=jwt_A&v=task_99");
    const k2 = videoCacheKey("/api/studio/episodes/ep1/latest-video?token=jwt_B&v=task_99#t=0.001");
    const k3 = videoCacheKey("/api/studio/episodes/ep1/latest-video?token=jwt_B&v=task_100");
    expect(k1).toBe("https://memento-video-cache.local/api/studio/episodes/ep1/latest-video?v=task_99");
    expect(k2).toBe(k1);
    expect(k3).not.toBe(k1);

    const m1 = videoCacheKey("/api/media/video/videos/u/u1/a.mp4?exp=100&sig=aaa");
    const m2 = videoCacheKey("/api/media/video/videos/u/u1/a.mp4?exp=200&sig=bbb");
    expect(m1).toBe(m2);

    expect(videoCacheKey("blob:https://mem.ihasy.com/123")).toBeNull();
    expect(videoCacheKey("memento-media://local/a.mp4")).toBeNull();
  });

  it("builds deterministic studioEpisodeVideoUrl using version v instead of random timestamp", () => {
    localStorage.setItem("dr_token", "tok123");
    const urlA = studioEpisodeVideoUrl("ep1", "task_42");
    const urlB = studioEpisodeVideoUrl("ep1", "task_42");
    expect(urlA).toBe(urlB);
    expect(urlA).toContain("/api/studio/episodes/ep1/latest-video?");
    expect(urlA).toContain("v=task_42");
    expect(urlA).not.toContain("t=");
  });

  it("caches once after the first playback (not at play start) and serves from local cache on second mount without re-downloading", async () => {
    const mock = createMockCacheStorage();
    (globalThis as Record<string, unknown>).caches = mock.storage;

    const fakeMp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
    const fetchMock = vi.fn(async () => new Response(fakeMp4, { status: 200, headers: { "Content-Type": "video/mp4" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const urlFirst = "/api/studio/episodes/ep1/latest-video?token=tok1&v=task_42";
    const urlSecond = "/api/studio/episodes/ep1/latest-video?token=tok2&v=task_42";

    // First mount: streams from remote URL initially
    await act(async () => {
      root.render(<VideoPlayer src={urlFirst} title="第1集" />);
    });
    const firstVideo = container.querySelector("video");
    expect(firstVideo?.getAttribute("src")).toContain("/api/studio/episodes/ep1/latest-video");
    expect(fetchMock).not.toHaveBeenCalled();

    // Starting playback must not start a second full download (it competes with playback on slow links)
    await act(async () => {
      firstVideo?.dispatchEvent(new Event("play"));
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();

    // Once playback ends the whole file is stored, once
    await act(async () => {
      firstVideo?.dispatchEvent(new Event("ended"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(peekCachedVideoUrl(urlSecond)).toBe("blob:memento-test-1");
    expect(container.textContent).toContain("已缓存");

    // Simulate leaving the Studio tab / unmounting & remounting with a rotated token
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<VideoPlayer src={urlSecond} title="第1集" />);
    });

    const secondVideo = container.querySelector("video");
    expect(secondVideo?.getAttribute("src")).toBe("blob:memento-test-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even after cold reload (in-memory pool cleared), persistent Cache API still serves without network fetch
    _resetVideoCacheForTests();
    const coldHit = await getCachedVideoUrl(urlSecond);
    expect(coldHit).toBe("blob:memento-test-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Deduplicated background caching does not re-fetch when already cached
    await cacheVideoInBackground(urlSecond);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Eviction clears both memory pool and persistent Cache API
    await evictCachedVideo(urlSecond);
    expect(peekCachedVideoUrl(urlSecond)).toBeNull();
    expect(await getCachedVideoUrl(urlSecond)).toBeNull();
  });
});
