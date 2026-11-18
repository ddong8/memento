// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nowSec = Math.floor(Date.now() / 1000);
const runs = [
  { conversation_id: "c1", title: "会员体系", question: "继续优化", device_name: "DESKTOP", started_at: nowSec - 930, elapsed_seconds: 930, done: false, cancelled: false, failed: false },
  { conversation_id: "c2", title: "蓝图", question: "生成业务蓝图", device_name: "mac", started_at: nowSec - 60, elapsed_seconds: 60, done: false, cancelled: false, failed: false },
];

vi.mock("next/navigation", () => ({
  usePathname: () => "/memory",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/api-client", () => ({
  api: { listAskRuns: vi.fn(async () => runs), cancelAskRun: vi.fn() },
  forgetRunStatus: vi.fn(),
}));
vi.mock("@/lib/sidebar-context", () => ({ useSidebar: () => ({ collapsed: false }) }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { id: "u" }, token: "t" }) }));
vi.mock("@/lib/native-notify", () => ({ sendLocalNotification: vi.fn() }));
vi.mock("@/lib/live-events", () => ({ onLiveEvent: () => () => {}, onLiveStatus: () => () => {}, useLiveConnected: () => false }));

import ActiveRunsMonitor from "../src/components/agent/ActiveRunsMonitor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("background runs chip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("on a phone, collapsed, still says what it is and how many run, tinted so it stands out", async () => {
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    await act(async () => {
      root.render(<ActiveRunsMonitor />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const chip = container.querySelector('[data-testid="active-runs-chip"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    // A bare dot and "15分30秒" was easy to miss among the cards
    expect(chip!.textContent).toContain("后台任务 2");
    expect(chip!.textContent).toMatch(/15分\d+秒/);
    expect(chip!.getAttribute("style") || "").toContain("--aurora-success-soft");
  });
});
