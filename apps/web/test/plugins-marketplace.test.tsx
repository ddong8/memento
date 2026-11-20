// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeChatPublishModal } from "../src/components/viewers/WeChatPublishModal";
import { resolveInternalAppLink } from "../src/components/viewers/media-utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Plugin Marketplace gating and dynamic WeChat publisher config", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("recognizes /plugins as an in-app route without opening external browser", () => {
    expect(resolveInternalAppLink("https://mem.ihasy.com/plugins?highlight=studio", "https://mem.ihasy.com")).toBe(
      "/plugins?highlight=studio"
    );
    expect(resolveInternalAppLink("/plugins", "https://mem.ihasy.com")).toBe("/plugins");
  });

  it("uses pluginConfig api_base_url and default_cover_media_id instead of hardcoded personal URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, html: "<p>ok</p>" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, media_id: "draft_999" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      root.render(
        <WeChatPublishModal
          isOpen={true}
          onClose={() => {}}
          markdown={"# 测试标题\n\n正文内容足够长用于提取摘要。"}
          pluginConfig={{
            api_base_url: "https://selfhost-wx.example.com",
            default_author: "SelfHostAuthor",
            default_cover_media_id: "SELFHOST_COVER_ID",
            official_site_url: "https://selfhost.example.com",
          }}
        />
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const publishBtn = buttons.find((b) => b.textContent?.includes("确认推送到草稿箱"));
    expect(publishBtn).toBeDefined();

    await act(async () => {
      publishBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://selfhost-wx.example.com/api/convert");
    expect(fetchMock.mock.calls[1][0]).toBe("https://selfhost-wx.example.com/api/wechat/draft");
    const draftBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body || "{}"));
    expect(draftBody.author).toBe("SelfHostAuthor");
    expect(draftBody.thumbMediaId).toBe("SELFHOST_COVER_ID");
  });
});
