// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The account menu (2026-11-17 "很不好看，要美化一下"): one panel on every client (the desktop app used
// to show 20-odd plain system-menu rows), drawn above the page so nothing in the sidebar shows through it.
const popupMenu = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { name: "Ada", email: "ada@example.com", role: "owner" }, logout: vi.fn() }) }));
vi.mock("@/lib/i18n", () => ({
  locales: { "zh-CN": { label: "中文" }, en: { label: "English" } },
  useI18n: () => ({ locale: "zh-CN", setLocale: vi.fn(), t: { profile: { title: "个人设置", tabs: {}, logout: "退出登录" }, nav: {}, serverSwitch: { title: "切换服务器" } } }),
}));
vi.mock("@/lib/theme-context", () => ({ useTheme: () => ({ skin: "aurora", theme: "light", setSkin: vi.fn() }) }));
vi.mock("@/lib/desktop", () => ({ desktop: () => ({ popupMenu }) }));
vi.mock("@/lib/api-client", () => ({ openServerSwitchModal: vi.fn() }));

import { panelPosition, UserMenu } from "../src/components/UserMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("account menu", () => {
  it("opens the same panel in the desktop app, on top of the page, and closes on an outside click", async () => {
    await act(async () => root.render(<UserMenu variant="sidebar" />));
    await act(async () => (host.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement).click());
    expect(popupMenu).not.toHaveBeenCalled();
    const menu = document.body.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    const text = menu.textContent || "";
    for (const label of ["Ada", "AI 执事", "我的设备", "本机采集", "管理后台", "界面语言", "界面风格", "切换服务器", "退出登录"]) expect(text).toContain(label);

    await act(async () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("sits above the sidebar card, beside it when collapsed, inside the window", () => {
    const card = { left: 10, right: 238, top: 820, bottom: 868 };
    expect(panelPosition(card, "sidebar", false, 1440, 900)).toEqual({ bottom: 88, left: 10, width: 288 });
    expect(panelPosition({ left: 10, right: 54, top: 820, bottom: 868 }, "sidebar", true, 1440, 900)).toEqual({ bottom: 32, left: 62, width: 288 });
    expect(panelPosition(card, "sidebar", false, 300, 900).width).toBe(284);
  });
});
