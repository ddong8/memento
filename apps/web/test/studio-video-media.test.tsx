// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMediaType, resolveInternalAppLink, resolveMediaUrl } from "../src/components/viewers/media-utils";
import MarkdownViewer from "../src/components/viewers/MarkdownViewer";
import { StudioPublishPanel } from "../src/components/studio/StudioPublishPanel";
import { studioApi, studioPublishBundleUrl } from "../src/lib/studio-api";

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
    expect(studioLink?.getAttribute("target")).toBeNull();
  });

  it("navigates same-origin /studio links in-app without target=_blank while keeping external links opening externally", async () => {
    expect(resolveInternalAppLink("https://mem.ihasy.com/studio", "https://mem.ihasy.com")).toBe("/studio");
    expect(resolveInternalAppLink("https://mem.ihasy.com/studio?project=p1&episode=ep1#shots", "https://mem.ihasy.com")).toBe(
      "/studio?project=p1&episode=ep1#shots"
    );
    expect(resolveInternalAppLink("/studio?project=p1", "https://mem.ihasy.com")).toBe("/studio?project=p1");
    expect(resolveInternalAppLink("https://mem.ihasy.com/api/media/video/a.mp4", "https://mem.ihasy.com")).toBeNull();
    expect(resolveInternalAppLink("https://example.com/studio", "https://mem.ihasy.com")).toBeNull();

    const navSpy = vi.fn();
    (window as unknown as { __memento_navigate?: (u: string) => void }).__memento_navigate = navSpy;
    const origOrigin = window.location.origin;

    const md =
      `打开演播台：${origOrigin}/studio?project=p1\n\n` +
      `外部文档：[GitHub](https://github.com/ddong8/memento)`;

    try {
      await act(async () => {
        root.render(<MarkdownViewer content={md} />);
      });

      const inAppLink = container.querySelector('a[href="/studio?project=p1"]') as HTMLAnchorElement | null;
      expect(inAppLink).not.toBeNull();
      expect(inAppLink?.getAttribute("target")).toBeNull();

      await act(async () => {
        inAppLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(navSpy).toHaveBeenCalledWith("/studio?project=p1");

      const extLink = container.querySelector('a[href="https://github.com/ddong8/memento"]') as HTMLAnchorElement | null;
      expect(extLink).not.toBeNull();
      expect(extLink?.getAttribute("target")).toBe("_blank");
    } finally {
      delete (window as unknown as { __memento_navigate?: unknown }).__memento_navigate;
    }
  });

  it("builds authenticated bundle.zip URL and renders StudioPublishPanel with platforms and jobs", async () => {
    const store = new Map<string, string>([["dr_token", "tok_publish_test"]]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
    try {
      const zipUrl = studioPublishBundleUrl("ep_demo_1");
      expect(zipUrl).toContain("/api/studio/episodes/ep_demo_1/publish/bundle.zip");
      expect(zipUrl).toContain("token=tok_publish_test");

      vi.spyOn(studioApi, "getPublishPlatforms").mockResolvedValue({
        platforms: [
          {
            id: "weixin_channels",
            name: "微信视频号",
            adapter: "playwright",
            login_url: "https://channels.weixin.qq.com/platform/login",
            upload_url: "https://channels.weixin.qq.com/platform/post/create",
            max_title: 30,
            max_desc: 1000,
            max_tags: 5,
            supports_draft: true,
            supports_schedule: true,
            style_hint: "",
            agent_status: null,
          },
          {
            id: "bilibili",
            name: "B站",
            adapter: "biliup",
            login_url: "https://member.bilibili.com/",
            upload_url: "https://member.bilibili.com/",
            max_title: 80,
            max_desc: 2000,
            max_tags: 10,
            supports_draft: true,
            supports_schedule: true,
            style_hint: "",
            agent_status: null,
          },
        ],
        agent: {
          online: false,
          url: "",
          playwright: false,
          biliup: false,
          chrome: false,
          error: "",
          platform_status: {},
        },
      });
      vi.spyOn(studioApi, "getEpisodePublish").mockResolvedValue({
        episode: {
          id: "ep_demo_1",
          project_id: "proj_1",
          title: "第1集",
          slug: "ep01",
          aspect: "vertical",
          engine: "external",
          transition: "cut",
          transition_duration: 0.3,
          subtitle_preset: "cinema_sub",
          title_banner: "",
          duck_bgm: true,
          bgm_volume: 0.2,
          bgm_path: "",
          story_text: "",
          last_task_id: "",
        },
        video: { name: "demo_final.mp4", path: "films/demo/demo_final.mp4", size_bytes: 2 * 1024 * 1024, url: "" },
        covers: [{ name: "cover_1.jpg", path: "films/demo/publish/covers/cover_1.jpg", url: "" }],
        jobs: [
          {
            id: "pub_1",
            project_id: "proj_1",
            episode_id: "ep_demo_1",
            platform: "weixin_channels",
            status: "prepared",
            mode: "draft",
            title: "测试差异化标题",
            description: "测试简介",
            tags: ["短剧", "悬疑"],
            cover_path: "films/demo/publish/covers/cover_1.jpg",
            video_path: "films/demo/publish/weixin_channels/demo.mp4",
            video_sha256: "abcdef1234567890",
            scheduled_at: "",
            agent_job_id: "",
            published_url: "",
            error: "",
            logs: [],
            created_at: 1,
            updated_at: 1,
          },
        ],
        has_zip: true,
        zip_url: "/api/studio/episodes/ep_demo_1/publish/bundle.zip",
      });
      vi.spyOn(studioApi, "getSettings").mockResolvedValue({
        settings: { publish_agent_url: "", publish_agent_token_set: false, publish_dedup_remux: true },
      });

      await act(async () => {
        root.render(
          <StudioPublishPanel
            episode={{
              id: "ep_demo_1",
              project_id: "proj_1",
              title: "第1集",
              slug: "ep01",
              aspect: "vertical",
              engine: "external",
              transition: "cut",
              transition_duration: 0.3,
              subtitle_preset: "cinema_sub",
              title_banner: "",
              duck_bgm: true,
              bgm_volume: 0.2,
              bgm_path: "",
              story_text: "",
              last_task_id: "",
            }}
            onNotify={() => {}}
            onGoScreening={() => {}}
          />
        );
      });

      expect(container.textContent).toContain("微信视频号");
      expect(container.textContent).toContain("B站");
      expect(container.textContent).toContain("SHA256: abcdef123456");
      expect(container.textContent).toContain("下载全平台发布包 (.zip)");
      const zipLink = container.querySelector('a[href*="/publish/bundle.zip"]');
      expect(zipLink).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
