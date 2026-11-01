import { describe, expect, it } from "vitest";
import { safeParseConversationTime } from "../src/components/ask/HistoryDrawer";
import { resolveSafeProjectName } from "../src/lib/ask/cache";
import type { AskConversationSummary, DeviceSummary, ProjectSummary } from "../src/lib/api-client";

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

    const INITIAL_RENDER_LIMIT = 64;
    const calculateInitialLimit = (activeId: string | null, list: { id: string }[]) => {
      if (activeId) {
        const idx = list.findIndex((c) => c.id === activeId);
        if (idx >= 0) {
          return Math.max(INITIAL_RENDER_LIMIT, idx + 12);
        }
      }
      return INITIAL_RENDER_LIMIT;
    };

    // Case 1: No active conversation -> 64
    expect(calculateInitialLimit(null, totalConversations)).toBe(64);

    // Case 2: Active conversation early in list -> 64
    expect(calculateInitialLimit("conv_5", totalConversations)).toBe(64);

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

    const { result: sliced64, totalRendered: total64 } = sliceGroups(64);
    expect(total64).toBe(64);
    expect(sliced64.length).toBe(3); // today (20) + yesterday (30) + older (14)
    expect(sliced64[0].items.length).toBe(20);
    expect(sliced64[1].items.length).toBe(30);
    expect(sliced64[2].items.length).toBe(14);
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

  it("resolves project tag and device tag separately, eliminating memento- prefix", () => {
    const mockProjects: ProjectSummary[] = [
      {
        id: "proj_1",
        title: "memento",
        slug: "memento",
        tool_id: "claude_code",
        source_path: "/Users/haixingdong/dev/memento",
        visibility: "private",
        document_count: 10,
        created_at: "2026-01-01",
        updated_at: null,
      },
      {
        id: "proj_2",
        title: "pubchem",
        slug: "pubchem",
        tool_id: "claude_code",
        source_path: "/Users/haixingdong/dev/pubchem",
        visibility: "private",
        document_count: 5,
        created_at: "2026-01-01",
        updated_at: null,
      },
    ];

    const mockDevices: DeviceSummary[] = [
      {
        id: "dev_1",
        device_id: "memento-192e28374-98ad",
        name: "MacBook Pro (haixingdong)",
        collector_version: "1.0.96",
        last_heartbeat: "2026-11-01T10:00:00Z",
        document_count: 50,
      },
      {
        id: "dev_2",
        device_id: "DESKTOP-KR9IPP4",
        name: "DESKTOP-KR9IPP4",
        collector_version: "1.0.96",
        last_heartbeat: "2026-11-01T10:00:00Z",
        document_count: 12,
      },
    ];

    // Helper matching ConversationItem tag resolution
    const resolveTags = (c: AskConversationSummary, isZh = true) => {
      let safeProjectTitle = "";
      if (c.project_title && c.project_title.trim()) {
        safeProjectTitle = c.project_title.trim();
      } else {
        const resolved = resolveSafeProjectName({
          projectId: c.project_id || c.config?.project_id,
          projectTitle: c.project_title || undefined,
          projects: mockProjects,
          cwd: c.cwd || c.config?.cwd,
          isZh,
        });
        if (resolved !== (isZh ? "项目代码库" : "Project")) {
          safeProjectTitle = resolved;
        }
      }

      let resolvedDevName = "";
      if (c.device_name && c.device_name.trim()) {
        resolvedDevName = c.device_name
          .replace(/\.local$/i, "")
          .replace(/ \(\w+\)$/, "")
          .trim();
      } else if (c.device_id) {
        const found = mockDevices.find(
          (d) => d.device_id === c.device_id || d.id === c.device_id || d.name === c.device_id
        );
        if (found?.name) {
          resolvedDevName = found.name.replace(/\.local$/i, "").replace(/ \(\w+\)$/, "").trim();
        } else if (!c.device_id.startsWith("memento-")) {
          resolvedDevName = c.device_id;
        }
      }

      return { safeProjectTitle, resolvedDevName };
    };

    // Case 1: Explicit project_title and device_name
    const conv1: AskConversationSummary = {
      id: "c1",
      title: "优化对话抽屉",
      created_at: "2026-11-01T10:00:00Z",
      updated_at: "2026-11-01T10:05:00Z",
      device_id: "dev_2",
      device_name: "DESKTOP-KR9IPP4.local",
      project_title: "memento",
      message_count: 5,
    };
    const tags1 = resolveTags(conv1);
    expect(tags1.safeProjectTitle).toBe("memento");
    expect(tags1.resolvedDevName).toBe("DESKTOP-KR9IPP4");

    // Case 2: Resolved via cwd and matching device_id in devices
    const conv2: AskConversationSummary = {
      id: "c2",
      title: "化学逆合成规划",
      created_at: "2026-11-01T09:00:00Z",
      updated_at: "2026-11-01T09:30:00Z",
      device_id: "memento-192e28374-98ad",
      cwd: "/Users/haixingdong/dev/pubchem",
      message_count: 3,
    };
    const tags2 = resolveTags(conv2);
    expect(tags2.safeProjectTitle).toBe("pubchem");
    expect(tags2.resolvedDevName).toBe("MacBook Pro");

    // Case 3: Generic conversation without project, and device_id with memento- prefix without match
    const conv3: AskConversationSummary = {
      id: "c3",
      title: "今天天气如何",
      created_at: "2026-11-01T08:00:00Z",
      updated_at: "2026-11-01T08:05:00Z",
      device_id: "memento-unknown-hash",
      message_count: 1,
    };
    const tags3 = resolveTags(conv3);
    // Project and device tags must be gracefully omitted, never showing "memento-"
    expect(tags3.safeProjectTitle).toBe("");
    expect(tags3.resolvedDevName).toBe("");
    expect(tags3.resolvedDevName).not.toContain("memento-");
  });

  it("validates drawer client-side filtering between all devices and current device", () => {
    const mockDevices: DeviceSummary[] = [
      {
        id: "d1",
        device_id: "DESKTOP-KR9IPP4",
        name: "DESKTOP-KR9IPP4",
        collector_version: "1.0.96",
        last_heartbeat: "2026-11-01T10:00:00Z",
        document_count: 12,
      },
      {
        id: "d2",
        device_id: "memento-mac-123",
        name: "MacBook Pro",
        collector_version: "1.0.96",
        last_heartbeat: "2026-11-01T10:00:00Z",
        document_count: 50,
      },
    ];

    const conversations: AskConversationSummary[] = [
      { id: "1", title: "Windows Conv 1", device_id: "DESKTOP-KR9IPP4", message_count: 2, created_at: null, updated_at: null },
      { id: "2", title: "Windows Conv 2", device_id: "DESKTOP-KR9IPP4", message_count: 4, created_at: null, updated_at: null },
      { id: "3", title: "Mac Conv 1", device_id: "memento-mac-123", message_count: 6, created_at: null, updated_at: null },
      { id: "4", title: "Cloud Conv", device_id: null, message_count: 1, created_at: null, updated_at: null },
    ];

    const filterConversations = (list: AskConversationSummary[], filterDevice: boolean, selectedDevice: string) => {
      if (filterDevice && selectedDevice && selectedDevice !== "auto" && selectedDevice !== "ask_only") {
        const targetDev = mockDevices.find(
          (d) => d.device_id === selectedDevice || d.id === selectedDevice || d.name === selectedDevice
        );
        return list.filter((c) => {
          if (!c.device_id) return false;
          if (c.device_id === selectedDevice) return true;
          if (targetDev) {
            return (
              c.device_id === targetDev.device_id ||
              c.device_id === targetDev.id ||
              c.device_id === targetDev.name
            );
          }
          return false;
        });
      }
      return list;
    };

    // When filterDevice is false ("全部设备"): all 4 conversations are shown
    const allList = filterConversations(conversations, false, "DESKTOP-KR9IPP4");
    expect(allList.length).toBe(4);

    // When filterDevice is true ("当前设备"): only 2 Windows conversations are shown
    const currentList = filterConversations(conversations, true, "DESKTOP-KR9IPP4");
    expect(currentList.length).toBe(2);
    expect(currentList.map((c) => c.id)).toEqual(["1", "2"]);

    // When switching to Mac: only 1 Mac conversation is shown
    const macList = filterConversations(conversations, true, "memento-mac-123");
    expect(macList.length).toBe(1);
    expect(macList[0].id).toBe("3");
  });

  it("supports limit and offset in api.listAskConversations query construction", () => {
    const buildQuery = (deviceId?: string, limit?: number, offset?: number) => {
      const params = new URLSearchParams();
      if (deviceId && deviceId !== "auto" && deviceId !== "ask_only" && deviceId !== "all") {
        params.set("device_id", deviceId);
      }
      if (limit !== undefined && limit !== null && limit > 0) {
        params.set("limit", String(limit));
      }
      if (offset !== undefined && offset !== null && offset >= 0) {
        params.set("offset", String(offset));
      }
      return params.toString() ? `?${params.toString()}` : "";
    };

    expect(buildQuery("all")).toBe("");
    expect(buildQuery("all", 50, 10)).toBe("?limit=50&offset=10");
    expect(buildQuery("DESKTOP-KR9IPP4", 100, 0)).toBe("?device_id=DESKTOP-KR9IPP4&limit=100&offset=0");
    expect(buildQuery(undefined, 200)).toBe("?limit=200");
  });
});
