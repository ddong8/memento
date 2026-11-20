// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const nowSec = Math.floor(Date.now() / 1000);
const runs = [
  {
    conversation_id: "c-mob-1",
    title: "超长标题测试超长标题测试超长标题测试",
    question: "在 375px 窄屏上不能横向溢出",
    device_name: "haixing-mac",
    started_at: nowSec - 125,
    elapsed_seconds: 125,
    done: false,
    cancelled: false,
    failed: false,
  },
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
vi.mock("@/lib/live-events", () => ({ onLiveEvent: () => () => {}, onLiveStatus: () => () => {}, useLiveConnected: () => true }));

import ActiveRunsMonitor from "../src/components/agent/ActiveRunsMonitor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("mobile 375px layout & overflow guard", () => {
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

  it("global stylesheet enforces horizontal overflow clipping on mobile viewports", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/overflow-x:\s*(?:hidden|clip)/);
  });

  it("ActiveRunsMonitor stays compact and opaque on 375px iPhone SE viewport", async () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    await act(async () => {
      root.render(<ActiveRunsMonitor />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    const chip = container.querySelector('[data-testid="active-runs-chip"]') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("智能体运行中");
    expect(chip!.getAttribute("style") || "").toContain("rgba(15, 23, 42, 0.97)");
  });

  it("MermaidBlock enforces strict securityLevel to block XSS regressions", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/viewers/MermaidBlock.tsx"), "utf8");
    expect(src).toContain('securityLevel: "strict"');
    expect(src).not.toContain('securityLevel: "loose"');
  });
});
