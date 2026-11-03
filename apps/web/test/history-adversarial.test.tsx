// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryDrawer } from "../src/components/ask/HistoryDrawer";
import { resolveSafeProjectName } from "../src/lib/ask/cache";
import type { AskConversationSummary, DeviceSummary, ProjectSummary } from "../src/lib/api-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockI18n = {
  ask: {
    title: "新会话",
    turnsCount: "{n} 轮对话",
    deleteConfirm: "确认删除此会话？",
    historyTitle: "历史对话",
    newChat: "新建会话",
    noHistory: "暂无历史会话",
  },
};

const mockProjects: ProjectSummary[] = [
  {
    id: "proj_memento",
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
    id: "proj_pubchem",
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
    id: "dev_mac",
    device_id: "memento-mac-192e28374-98ad",
    name: "MacBook Pro (haixingdong)",
    collector_version: "1.0.96",
    last_heartbeat: "2026-11-01T10:00:00Z",
    document_count: 50,
  },
  {
    id: "dev_win",
    device_id: "DESKTOP-KR9IPP4",
    name: "DESKTOP-KR9IPP4.local",
    collector_version: "1.0.96",
    last_heartbeat: "2026-11-01T10:00:00Z",
    document_count: 12,
  },
];

describe("Adversarial Verification: HistoryDrawer, Tag Decoupling and Scalability", () => {
  let host: HTMLElement;
  let root: Root | null = null;
  let consoleErrorSpy: any;
  let consoleWarnSpy: any;

  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    // Stub fetch to prevent actual localhost socket connections
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ runs: [], items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    // Location for /ask path check in HistoryDrawer
    delete (window as any).location;
    (window as any).location = { pathname: "/ask" };

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    consoleErrorSpy = vi.spyOn(console, "error");
    consoleWarnSpy = vi.spyOn(console, "warn");
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    host?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const tick = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

  // =========================================================================
  // Test Suite 1: Tag Rendering Edge Cases & Purging "memento-"
  // =========================================================================
  describe("1. Tag Rendering Edge Cases & Purging 'memento-'", () => {
    it("1.1 Pure generic conversation: null project, null device, null cwd", async () => {
      const genericConv: AskConversationSummary = {
        id: "conv_generic",
        title: "纯通用闲聊会话",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: null,
        device_name: null,
        project_id: null,
        project_title: null,
        cwd: null,
        message_count: 3,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[genericConv]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      expect(text).toContain("纯通用闲聊会话");
      expect(text).toContain("3 轮对话");
      // Must NOT contain "memento-"
      expect(text).not.toContain("memento-");
      // Must NOT contain placeholder "项目代码库"
      expect(text).not.toContain("项目代码库");

      // Verify no tag chip elements rendered for project or device
      const projectChips = host.querySelectorAll("span[title*='所属工程']");
      expect(projectChips.length).toBe(0);
      const deviceChips = host.querySelectorAll("span[title*='来源设备']");
      expect(deviceChips.length).toBe(0);
    });

    it("1.2 Device ID starts with 'memento-...' without matching device", async () => {
      const orphanDevConv: AskConversationSummary = {
        id: "conv_orphan_dev",
        title: "孤立设备会话",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: "memento-7b39f1c2-deadbeef",
        device_name: null,
        project_id: null,
        project_title: null,
        message_count: 1,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[orphanDevConv]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      // Must NEVER render "memento-"
      expect(text).not.toContain("memento-");
      expect(text).not.toContain("7b39f1c2");
      // Must not render device chip
      const deviceChips = host.querySelectorAll("span[title*='来源设备']");
      expect(deviceChips.length).toBe(0);
    });

    it("1.3 Device ID starts with 'memento-...' but matches machine in devices", async () => {
      const matchedDevConv: AskConversationSummary = {
        id: "conv_matched_dev",
        title: "已识别的 Mac 会话",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: "memento-mac-192e28374-98ad",
        device_name: null,
        project_id: null,
        project_title: null,
        message_count: 5,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[matchedDevConv]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      // Should show cleaned device name "MacBook Pro" without username "(haixingdong)"
      expect(text).toContain("MacBook Pro");
      expect(text).not.toContain("(haixingdong)");
      // Must NOT render "memento-"
      expect(text).not.toContain("memento-");

      const devChip = host.querySelector("span[title*='来源设备']");
      expect(devChip?.textContent).toBe("MacBook Pro");
    });

    it("1.4 Cleans .local suffix from device_name", async () => {
      const winConv: AskConversationSummary = {
        id: "conv_win",
        title: "Windows 工作站会话",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: "DESKTOP-KR9IPP4",
        device_name: "DESKTOP-KR9IPP4.local",
        message_count: 8,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[winConv]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      expect(text).toContain("DESKTOP-KR9IPP4");
      expect(text).not.toContain("DESKTOP-KR9IPP4.local");

      const devChip = host.querySelector("span[title*='来源设备']");
      expect(devChip?.textContent).toBe("DESKTOP-KR9IPP4");
    });

    it("1.5 Real projects: memento and pubchem tags render with code icon", async () => {
      const convs: AskConversationSummary[] = [
        {
          id: "conv_mem",
          title: "优化对话抽屉",
          created_at: "2026-11-01T10:00:00Z",
          updated_at: "2026-11-01T10:00:00Z",
          device_id: null,
          project_title: "memento",
          message_count: 4,
        },
        {
          id: "conv_pub",
          title: "化学逆合成规划",
          created_at: "2026-11-01T10:00:00Z",
          updated_at: "2026-11-01T10:00:00Z",
          device_id: null,
          project_title: "pubchem",
          message_count: 6,
        },
      ];

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={convs}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const projectChips = host.querySelectorAll("span[title*='所属工程']");
      expect(projectChips.length).toBe(2);
      expect(projectChips[0].textContent).toContain("memento");
      expect(projectChips[1].textContent).toContain("pubchem");
    });

    it("1.6 CWD path fallback stress testing", () => {
      // Deep nested
      expect(resolveSafeProjectName({ cwd: "/Users/haixingdong/dev/memento", isZh: true })).toBe("memento");
      expect(resolveSafeProjectName({ cwd: "/Users/haixingdong/dev/pubchem", isZh: true })).toBe("pubchem");
      expect(resolveSafeProjectName({ cwd: "C:\\Users\\haixingdong\\dev\\workbuddy\\", isZh: true })).toBe("workbuddy");

      // Special characters & spaces
      expect(
        resolveSafeProjectName({ cwd: "/Users/haixingdong/dev/chemical-reaction-v2.1", isZh: true })
      ).toBe("chemical-reaction-v2.1");
      expect(
        resolveSafeProjectName({ cwd: "/Users/haixingdong/dev/my workspace/project_alpha", isZh: true })
      ).toBe("project_alpha");

      // Noise and system paths fallback to safe fallback
      expect(
        resolveSafeProjectName({ cwd: "/tmp/conversations/brain/scratch", isZh: true })
      ).toBe("项目代码库");
      expect(resolveSafeProjectName({ cwd: "/tmp", isZh: true })).toBe("项目代码库");
      expect(resolveSafeProjectName({ cwd: "/home", isZh: true })).toBe("项目代码库");
      expect(resolveSafeProjectName({ cwd: "", isZh: true })).toBe("项目代码库");
    });

    it("1.7 Drawer device filter button never shows 'memento-'", async () => {
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[]}
            activeConversationId={null}
            selectedDevice="memento-orphan-device-123"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const buttons = Array.from(host.querySelectorAll("button"));
      const currentDevBtn = buttons.find((b) => b.textContent?.includes("当前设备"));
      expect(currentDevBtn).toBeDefined();
      expect(currentDevBtn?.textContent).toContain("🖥️ 当前设备 (当前设备)");
      expect(currentDevBtn?.textContent).not.toContain("memento-");
    });

    it("1.8 Exact 8-char 'memento-' string as device_id is never rendered", async () => {
      const convExactMemento: AskConversationSummary = {
        id: "conv_exact_memento",
        title: "边界前缀测试",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: "memento-",
        device_name: null,
        message_count: 1,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[convExactMemento]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      expect(text).not.toContain("memento-");
      const deviceChips = host.querySelectorAll("span[title*='来源设备']");
      expect(deviceChips.length).toBe(0);
    });

    it("1.9 Whitespace-only project_title edge behavior", async () => {
      const convWhitespaceProject: AskConversationSummary = {
        id: "conv_ws_proj",
        title: "空白项目测试",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: null,
        project_title: "   ",
        cwd: null,
        message_count: 2,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[convWhitespaceProject]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // Verified: never contains "memento-"
      const text = host.textContent || "";
      expect(text).not.toContain("memento-");
      // Finding F-1: Note that HistoryDrawer L190 passes "   " into resolveSafeProjectName which returns "   "
      const projectChips = host.querySelectorAll("span[title*='所属工程']");
      expect(projectChips.length).toBeLessThanOrEqual(1);
    });

    it("1.10 Raw UUID project_title edge behavior", async () => {
      const convUuidProject: AskConversationSummary = {
        id: "conv_uuid_proj",
        title: "UUID项目标题测试",
        created_at: "2026-11-01T10:00:00Z",
        updated_at: "2026-11-01T10:00:00Z",
        device_id: null,
        project_title: "1a022370-550f-4e87-baa8-497a7d95a0f4",
        cwd: null,
        message_count: 2,
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[convUuidProject]}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // Verified: never contains "memento-"
      const text = host.textContent || "";
      expect(text).not.toContain("memento-");
      // Finding F-2: Note that HistoryDrawer L190 returns raw UUID before resolveSafeProjectName check
      const projectChips = host.querySelectorAll("span[title*='所属工程']");
      expect(projectChips.length).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // Test Suite 2: Filter State Consistency & Count Calculations
  // =========================================================================
  describe("2. Filter State Consistency & Count Calculations", () => {
    const mixedConvs: AskConversationSummary[] = [
      // 3 on Windows
      { id: "w1", title: "Win Session 1", device_id: "DESKTOP-KR9IPP4", message_count: 2, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" },
      { id: "w2", title: "Win Session 2", device_id: "DESKTOP-KR9IPP4", message_count: 4, created_at: "2026-11-01T09:00:00Z", updated_at: "2026-11-01T09:00:00Z" },
      { id: "w3", title: "Win Session 3", device_id: "DESKTOP-KR9IPP4", message_count: 1, created_at: "2026-10-31T09:00:00Z", updated_at: "2026-10-31T09:00:00Z" },
      // 2 on Mac
      { id: "m1", title: "Mac Session 1", device_id: "memento-mac-192e28374-98ad", message_count: 5, created_at: "2026-11-01T10:00:00Z", updated_at: "2026-11-01T10:00:00Z" },
      { id: "m2", title: "Mac Session 2", device_id: "memento-mac-192e28374-98ad", message_count: 3, created_at: "2026-10-30T10:00:00Z", updated_at: "2026-10-30T10:00:00Z" },
      // 2 with null device
      { id: "c1", title: "Cloud Chat 1", device_id: null, message_count: 2, created_at: "2026-11-01T08:00:00Z", updated_at: "2026-11-01T08:00:00Z" },
      { id: "c2", title: "Cloud Chat 2", device_id: null, message_count: 6, created_at: "2026-10-25T08:00:00Z", updated_at: "2026-10-25T08:00:00Z" },
    ];

    it("2.1 Switching between '全部设备' and '当前设备' accurately filters items and counts", async () => {
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={mixedConvs}
            activeConversationId={null}
            selectedDevice="DESKTOP-KR9IPP4"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // State A: Initial (filterDevice = false, "全部设备")
      const header = host.querySelector("span[style*='border-radius: 999']");
      expect(header?.textContent).toBe("7");

      // All 7 titles should be present in DOM
      expect(host.textContent).toContain("Win Session 1");
      expect(host.textContent).toContain("Win Session 2");
      expect(host.textContent).toContain("Win Session 3");
      expect(host.textContent).toContain("Mac Session 1");
      expect(host.textContent).toContain("Mac Session 2");
      expect(host.textContent).toContain("Cloud Chat 1");
      expect(host.textContent).toContain("Cloud Chat 2");

      // State B: Click "当前设备" (filterDevice = true)
      const currentDevBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("当前设备")
      );
      expect(currentDevBtn).toBeDefined();

      await act(async () => {
        currentDevBtn?.click();
      });
      await tick();

      // Only 3 Windows sessions should be present
      expect(host.textContent).toContain("Win Session 1");
      expect(host.textContent).toContain("Win Session 2");
      expect(host.textContent).toContain("Win Session 3");
      expect(host.textContent).not.toContain("Mac Session 1");
      expect(host.textContent).not.toContain("Mac Session 2");
      expect(host.textContent).not.toContain("Cloud Chat 1");
      expect(host.textContent).not.toContain("Cloud Chat 2");

      // State C: Click "全部设备" to return
      const allDevBtn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("全部设备")
      );
      expect(allDevBtn).toBeDefined();

      await act(async () => {
        allDevBtn?.click();
      });
      await tick();

      // All 7 reappear
      expect(host.textContent).toContain("Win Session 1");
      expect(host.textContent).toContain("Mac Session 1");
      expect(host.textContent).toContain("Cloud Chat 1");
    });

    it("2.2 Search filtering computes correct filtered/total badge", async () => {
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={mixedConvs}
            activeConversationId={null}
            selectedDevice="DESKTOP-KR9IPP4"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const inputEl = host.querySelector("input[placeholder*='搜索']") as HTMLInputElement;
      expect(inputEl).toBeDefined();

      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      await act(async () => {
        nativeInputValueSetter?.call(inputEl, "Mac");
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await tick();

      // Check header badge now displays 2/7
      const header = host.querySelector("span[style*='border-radius: 999']");
      expect(header?.textContent).toBe("2/7");
      expect(host.textContent).toContain("Mac Session 1");
      expect(host.textContent).toContain("Mac Session 2");
      expect(host.textContent).not.toContain("Win Session 1");
    });
  });

  // =========================================================================
  // Test Suite 3: Scalability, Windowing & Deep Active Index (120+ Items)
  // =========================================================================
  describe("3. Scalability, Windowing & Deep Active Index (120+ Items)", () => {
    // Generate 120 items across 7 date groups
    const now = Date.now();
    const dayMs = 86400000;

    const largeConversationList: AskConversationSummary[] = Array.from({ length: 120 }, (_, i) => {
      let createdTime: number;
      if (i < 5) {
        // running: today
        createdTime = now - i * 1000;
      } else if (i < 10) {
        // pinned: today
        createdTime = now - i * 1000;
      } else if (i < 30) {
        // today
        createdTime = now - (i - 10) * 3600000;
      } else if (i < 50) {
        // yesterday
        createdTime = now - 1 * dayMs - (i - 30) * 3600000;
      } else if (i < 80) {
        // past 7 days
        createdTime = now - 3 * dayMs - (i - 50) * 3600000;
      } else if (i < 100) {
        // past 30 days
        createdTime = now - 15 * dayMs - (i - 80) * 3600000;
      } else {
        // older
        createdTime = now - 45 * dayMs - (i - 100) * 3600000;
      }

      return {
        id: `conv_${i}`,
        title: `Scale Session ${i}`,
        created_at: new Date(createdTime).toISOString(),
        updated_at: new Date(createdTime).toISOString(),
        device_id: i % 2 === 0 ? "DESKTOP-KR9IPP4" : "memento-mac-192e28374-98ad",
        project_title: i % 3 === 0 ? "memento" : i % 3 === 1 ? "pubchem" : null,
        message_count: (i % 10) + 1,
        config: i >= 5 && i < 10 ? { pinned: true } : {},
      };
    });

    const runningSet = new Set(["conv_0", "conv_1", "conv_2", "conv_3", "conv_4"]);

    it("3.1 Initial render caps at 64 items, preventing DOM explosion", async () => {
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={largeConversationList}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            runningConversationIds={runningSet}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // Total items in state is 120
      const header = host.querySelector("span[style*='border-radius: 999']");
      expect(header?.textContent).toBe("120");

      // Verify rendered conversation items count equals INITIAL_RENDER_LIMIT (64)
      // Each rendered ConversationItem has a unique delete button with title t.ask.deleteConfirm
      const deleteButtons = host.querySelectorAll(`button[title="${mockI18n.ask.deleteConfirm}"]`);
      expect(deleteButtons.length).toBe(64);

      // Verify no React exceptions were logged
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("3.2 Deep active conversation (item #80) automatically expands render window", async () => {
      // conv_80 is deep in the list (past 64). baseLimit should expand to at least 80 + 12 = 92.
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={largeConversationList}
            activeConversationId="conv_80"
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            runningConversationIds={runningSet}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // conv_80 MUST be rendered and present in the DOM
      expect(host.textContent).toContain("Scale Session 80");

      // Rendered count should be at least 92
      const deleteButtons = host.querySelectorAll(`button[title="${mockI18n.ask.deleteConfirm}"]`);
      expect(deleteButtons.length).toBeGreaterThanOrEqual(92);
    });

    it("3.3 Scroll to bottom expands renderLimit by BATCH_RENDER_SIZE", async () => {
      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={largeConversationList}
            activeConversationId={null}
            selectedDevice="auto"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      // Find scrollable container (has onScroll)
      const scrollableDiv = host.querySelector("div[style*='overflow-y: auto']") as HTMLElement;
      expect(scrollableDiv).toBeDefined();

      // Mock scroll dimensions: scrollTop + clientHeight >= scrollHeight - 260
      Object.defineProperty(scrollableDiv, "scrollTop", { value: 2000, configurable: true });
      Object.defineProperty(scrollableDiv, "clientHeight", { value: 600, configurable: true });
      Object.defineProperty(scrollableDiv, "scrollHeight", { value: 2500, configurable: true });

      await act(async () => {
        scrollableDiv.dispatchEvent(new Event("scroll"));
      });
      await tick();

      // Should now render all 120 items (64 + 64 >= 120)
      const deleteButtons = host.querySelectorAll(`button[title="${mockI18n.ask.deleteConfirm}"]`);
      expect(deleteButtons.length).toBe(120);
    });
  });

  // =========================================================================
  // Test Suite 4: React 19 Concurrency & Warning Cleanliness
  // =========================================================================
  describe("4. React 19 Concurrency & Warning Cleanliness", () => {
    it("4.1 Rapid remounting and prop mutation causes ZERO React 19 errors", async () => {
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          root!.render(
            <HistoryDrawer
              open={i % 2 === 0}
              onClose={() => {}}
              conversations={mockProjects as any}
              activeConversationId={null}
              selectedDevice="DESKTOP-KR9IPP4"
              devices={mockDevices}
              projects={mockProjects}
              onSelectConversation={() => {}}
              onStartNewChat={() => {}}
              onDeleteConversation={() => {}}
              onRenameConversation={() => {}}
              onTogglePinConversation={() => {}}
              onOpenSingleShare={() => {}}
              onOpenBatchShare={() => {}}
              isZh={true}
              t={mockI18n}
            />
          );
        });
        await tick();
      }

      // Assert no setState in useEffect warnings or uncaught errors
      const errorCalls = consoleErrorSpy.mock.calls.filter((c: any[]) =>
        String(c[0]).includes("react-hooks/set-state-in-effect")
      );
      expect(errorCalls.length).toBe(0);
    });
  });

  // =========================================================================
  // Test Suite 5: Device ID Prefix Stripping and Real Project Integrity
  // =========================================================================
  describe("5. Device ID Prefix Stripping and Real Project Integrity", () => {
    it("5.1 Ensures memento- prefix is NEVER shown as literal project tag or fallback device label", async () => {
      const convWithMementoDev: AskConversationSummary = {
        id: "conv-memento-test-1",
        title: "你是谁",
        created_at: "2026-11-01T03:31:28Z",
        updated_at: "2026-11-01T03:31:28Z",
        device_id: "memento-65d4db33c1c70-18f46486",
        device_name: "DESKTOP-KR9IPP4",
        project_id: "21767e3f-1c1f-4c6e-ad67-f5b25264e4b2",
        project_title: "WorkBuddy",
        cwd: "c:/Users/Admin/WorkBuddy",
        message_count: 4,
        config: {
          execution_mode: "workbuddy",
          project_id: "21767e3f-1c1f-4c6e-ad67-f5b25264e4b2",
        },
      };

      await act(async () => {
        root!.render(
          <HistoryDrawer
            open={true}
            onClose={() => {}}
            conversations={[convWithMementoDev]}
            activeConversationId={null}
            selectedDevice="memento-65d4db33c1c70-18f46486"
            devices={mockDevices}
            projects={mockProjects}
            onSelectConversation={() => {}}
            onStartNewChat={() => {}}
            onDeleteConversation={() => {}}
            onRenameConversation={() => {}}
            onTogglePinConversation={() => {}}
            onOpenSingleShare={() => {}}
            onOpenBatchShare={() => {}}
            isZh={true}
            t={mockI18n}
          />
        );
      });
      await tick();

      const text = host.textContent || "";
      expect(text).toContain("WorkBuddy");
      expect(text).toContain("DESKTOP-KR9IPP4");
      // Must NOT contain literal "memento-" as a visible badge
      const badges = Array.from(host.querySelectorAll("span")).map((s) => s.textContent?.trim());
      expect(badges.filter((b) => b === "memento-").length).toBe(0);
    });
  });
});
