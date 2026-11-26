// Business blueprint R-THINKING-FULL and R-PERSONA-ONBOARD: two user rules that used to be "style only, look
// at a screenshot". The thinking one had already regressed (5af514f1, 10-31, collapsed the block once thinking
// was done) without anything noticing.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ThinkingBlock } from "../src/components/ask/bubbles";
import MarkdownViewer from "../src/components/viewers/MarkdownViewer";
import { getPresetById, getPresetsByGender } from "../src/components/persona/avatarPresets";
import { PERSONA_STAGE_DEFAULTS, shouldBackfillDefaultAvatar, shouldOfferAvatarOnboarding } from "../src/lib/persona/onboarding";

const THOUGHT = "先看守护进程日志，再对比两次提交";

describe("R-THINKING-FULL thinking stays spread out", () => {
  it("shows the whole thinking text after thinking is done, not only while it streams", () => {
    for (const isLive of [true, false]) {
      const html = renderToString(createElement(ThinkingBlock, { thinking: THOUGHT, isLive }));
      expect(html, `isLive=${isLive}`).toContain(THOUGHT);
      expect(html).toContain("thinking-scroll-content");
      expect(html).toMatch(/width:100%/);
    }
  });

  it("shows no empty box while nothing has been thought yet, and says 思考中 only once", () => {
    const html = renderToString(createElement(ThinkingBlock, { thinking: "", isLive: true }));
    expect(html).not.toContain("thinking-scroll-content");
    expect(html).not.toContain("推演中");
    expect(html).toContain("思考中");
  });

  it("uses the answer's body size for the thinking text", () => {
    const html = renderToString(createElement(ThinkingBlock, { thinking: THOUGHT, isLive: false }));
    expect(html).toMatch(/class="thinking-scroll-content"[^>]*font-size:14px/);
  });
});

describe("R-THINKING-FULL one body size in answers", () => {
  it("paragraphs and list items of an answer are all 14px", () => {
    const html = renderToString(
      createElement(MarkdownViewer, { content: "第一段\n\n- 列表一\n- 列表二\n\n1. 步骤\n\n> 引用里的话\n\n第二段" }),
    );
    const sizes = new Set([...html.matchAll(/<(?:p|ul|ol|li)\b[^>]*class="[^"]*text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => m[1]));
    expect([...sizes]).toEqual(["14"]);
    // The quote doesn't set its own size: it inherits the body's
    expect(html).toMatch(/<blockquote(?![^>]*text-\[\d)/);
  });
});

describe("R-PERSONA-ONBOARD avatar onboarding", () => {
  it("opens once on first visit, never again once skipped, and saves the default back when skipped", () => {
    expect(shouldOfferAvatarOnboarding({ initialized: false, dismissed: false, checked: false })).toBe(true);
    expect(shouldOfferAvatarOnboarding({ initialized: false, dismissed: false, checked: true })).toBe(false);
    expect(shouldOfferAvatarOnboarding({ initialized: false, dismissed: true, checked: false })).toBe(false);
    expect(shouldOfferAvatarOnboarding({ initialized: true, dismissed: false, checked: false })).toBe(false);
    expect(shouldBackfillDefaultAvatar({ initialized: false, dismissed: true, checked: false })).toBe(true);
    expect(shouldBackfillDefaultAvatar({ initialized: true, dismissed: true, checked: false })).toBe(false);
  });

  it("starts as a full-screen 3D animation, like the other two 3D pages", () => {
    expect(PERSONA_STAGE_DEFAULTS).toEqual({ panelCollapsed: true, threeD: true });
  });

  it("has cartoon figures for every gender choice, and the defaults the modal starts with exist", () => {
    for (const g of ["male", "female", "agent"] as const) {
      const presets = getPresetsByGender(g);
      expect(presets.length, g).toBeGreaterThan(0);
      expect(presets.every((p) => p.gender === g)).toBe(true);
    }
    expect(getPresetById("geek_male").gender).toBe("male");
    expect(getPresetById("cyber_female").gender).toBe("female");
  });
});
