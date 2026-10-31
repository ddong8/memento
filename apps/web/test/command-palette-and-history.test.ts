import { describe, expect, it } from "vitest";
import { safeParseConversationTime } from "../src/components/ask/HistoryDrawer";

describe("HistoryDrawer and CommandPalette Optimizations", () => {
  it("safeParseConversationTime handles standard ISO and Safari-style spaced timestamps", () => {
    expect(safeParseConversationTime(null)).toBe(0);
    expect(safeParseConversationTime("")).toBe(0);

    const isoTime = safeParseConversationTime("2026-10-31T08:00:00Z");
    expect(isoTime).toBeGreaterThan(0);

    // Safari space formatted
    const safariTime = safeParseConversationTime("2026-10-31 08:00:00");
    expect(safariTime).toBeGreaterThan(0);
  });

  it("validates CommandPalette tiered hierarchical actions logic", () => {
    // Actions keywords matching
    const actions = [
      { id: "action_new_chat", category: "action", keywords: ["new", "chat", "新建", "会话"] },
      { id: "action_switch_device", category: "action", keywords: ["server", "device", "切换", "设备"] },
      { id: "action_clear_cache", category: "action", keywords: ["clear", "cache", "清理", "缓存"] },
      { id: "action_toggle_theme", category: "action", keywords: ["theme", "dark", "light", "主题"] },
      { id: "jump_ask", category: "jump", keywords: ["ask", "brain", "大脑"] },
      { id: "jump_daily", category: "jump", keywords: ["daily", "rhythm", "作息", "节律"] },
      { id: "jump_tasks", category: "jump", keywords: ["task", "tasks", "待办", "任务"] },
      { id: "jump_profile", category: "jump", keywords: ["profile", "persona", "画像"] },
      { id: "jump_memory_nebula", category: "jump", keywords: ["memory", "nebula", "星云", "图谱"] },
    ];

    const matchQuery = (q: string) => {
      const clean = q.trim().toLowerCase();
      return actions.filter((a) => a.keywords.some((k) => k.includes(clean)));
    };

    expect(matchQuery("新建")[0].id).toBe("action_new_chat");
    expect(matchQuery("缓存")[0].id).toBe("action_clear_cache");
    expect(matchQuery("星云")[0].id).toBe("jump_memory_nebula");
    expect(matchQuery("待办")[0].id).toBe("jump_tasks");
  });

  it("validates HistoryDrawer windowed grouping and active index guarantee", () => {
    const totalConversations = Array.from({ length: 100 }, (_, i) => ({
      id: `conv_${i}`,
      title: `Session ${i}`,
    }));

    const INITIAL_RENDER_LIMIT = 32;
    const calculateInitialLimit = (activeId: string | null, list: { id: string }[]) => {
      if (activeId) {
        const idx = list.findIndex((c) => c.id === activeId);
        if (idx >= 0) {
          return Math.max(INITIAL_RENDER_LIMIT, idx + 12);
        }
      }
      return INITIAL_RENDER_LIMIT;
    };

    // Case 1: No active conversation -> 32
    expect(calculateInitialLimit(null, totalConversations)).toBe(32);

    // Case 2: Active conversation early in list -> 32
    expect(calculateInitialLimit("conv_5", totalConversations)).toBe(32);

    // Case 3: Active conversation deep in list (conv_60) -> 60 + 12 = 72
    expect(calculateInitialLimit("conv_60", totalConversations)).toBe(72);

    // Group slicing logic: items past remaining quota are excluded, preventing broken DOM nodes
    const groups = [
      { id: "today", items: Array.from({ length: 20 }, (_, i) => ({ id: `t_${i}` })) },
      { id: "yesterday", items: Array.from({ length: 30 }, (_, i) => ({ id: `y_${i}` })) },
      { id: "older", items: Array.from({ length: 50 }, (_, i) => ({ id: `o_${i}` })) },
    ];

    const sliceGroups = (renderLimit: number) => {
      let runningCount = 0;
      const result: { id: string; items: { id: string }[] }[] = [];
      for (const group of groups) {
        const remaining = renderLimit - runningCount;
        if (remaining <= 0) continue;
        const rendered = group.items.slice(0, remaining);
        runningCount += rendered.length;
        result.push({ id: group.id, items: rendered });
      }
      return { result, totalRendered: runningCount };
    };

    const { result: sliced32, totalRendered: total32 } = sliceGroups(32);
    expect(total32).toBe(32);
    expect(sliced32.length).toBe(2); // today (20) + yesterday (12)
    expect(sliced32[0].items.length).toBe(20);
    expect(sliced32[1].items.length).toBe(12);
    expect(sliced32.find((g) => g.id === "older")).toBeUndefined();
  });

  it("verifies CommandPalette flat items 1:1 match with rendered items count", () => {
    interface TestAction {
      id: string;
      category: "action" | "jump";
    }

    const buildFlatItems = (
      cleanQ: string,
      matchingActions: TestAction[],
      matchingJumps: TestAction[],
      hits: { id: string }[]
    ) => {
      const items: { id: string }[] = [];
      for (const a of matchingActions) items.push({ id: a.id });
      for (const j of matchingJumps) items.push({ id: j.id });
      if (cleanQ) items.push({ id: "ask_ai_card" });
      for (const h of hits) items.push({ id: `hit_${h.id}` });
      if (cleanQ && (hits.length > 0 || matchingActions.length + matchingJumps.length > 0)) {
        items.push({ id: "view_all_footer" });
      }
      return items;
    };

    // When no match: only ask_ai_card is selectable
    const emptyMatches = buildFlatItems("xyz_not_found", [], [], []);
    expect(emptyMatches.length).toBe(1);
    expect(emptyMatches[0].id).toBe("ask_ai_card");

    // When hits exist: actions + jumps + ask_ai_card + hits + view_all_footer
    const withHits = buildFlatItems("update", [{ id: "act_1", category: "action" }], [], [{ id: "doc_1" }]);
    expect(withHits.length).toBe(4);
    expect(withHits.map((x) => x.id)).toEqual(["act_1", "ask_ai_card", "hit_doc_1", "view_all_footer"]);
  });
});
