"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useI18n, locales, type Locale } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { SkinPicker, ThemeToggle } from "@/components/aurora/primitives";

import { useEffect, useState } from "react";
import { desktop } from "@/lib/desktop";
import { useSidebar } from "@/lib/sidebar-context";

export default function Header({ onMenuToggle, className = "" }: { onMenuToggle: () => void; className?: string }) {
  const { user } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { collapsed, toggleCollapsed } = useSidebar();
  const pathname = usePathname();
  // The top bar is the desktop window's title bar: it drags the window (on Windows the system's
  // minimize / maximize / close buttons sit over its right end, see globals.css)
  const [isDesktopApp, setIsDesktopApp] = useState(false);

  useEffect(() => {
    if (desktop()) setIsDesktopApp(true);
  }, []);

  const pageMeta = (() => {
    if (!pathname) return { title: t.app.title, icon: "sparkles" as const };
    if (pathname.startsWith("/ask")) return { title: t.nav.ask || "AI 执事", icon: "terminal" as const };
    if (pathname.startsWith("/memory/persona")) return { title: t.nav.persona || "数字分身", icon: "user" as const };
    if (pathname.startsWith("/memory")) return { title: t.nav.memory || "认知大脑", icon: "brain" as const };
    if (pathname.startsWith("/daily")) return { title: t.nav.daily || "作息节律", icon: "calendar" as const };
    if (pathname.startsWith("/inbox") || pathname.startsWith("/tasks")) return { title: t.nav.inbox || "工作待办", icon: "check" as const };
    if (pathname.startsWith("/plans")) return { title: "协作任务", icon: "layers" as const };
    if (pathname.startsWith("/profile")) return { title: "个人中心", icon: "settings" as const };
    if (pathname.startsWith("/projects")) return { title: t.nav.projects || "项目空间", icon: "folder" as const };
    if (pathname.startsWith("/skills")) return { title: t.nav.skills || "技能中心", icon: "sparkles" as const };
    if (pathname.startsWith("/app")) return { title: t.nav.overview || "全景总览", icon: "grid" as const };
    return { title: t.app.title, icon: "sparkles" as const };
  })();

  return (
    <header
      className={`h-11 sm:h-12 flex items-center justify-between px-3 sm:px-5 md:px-7 fixed top-0 left-0 ${collapsed ? "lg:left-[68px]" : "lg:left-60"} right-0 z-20 transition-[left] duration-200 ease-in-out ${isDesktopApp ? "app-region-drag" : ""} ${className}`}
      style={{
        background: "var(--aurora-surface)",
        backdropFilter: "var(--aurora-blur)",
        WebkitBackdropFilter: "var(--aurora-blur)",
        borderBottom: "1px solid var(--aurora-border)",
      }}
    >
      <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
        {/* Mobile menu */}
        <button
          onClick={onMenuToggle}
          aria-label="Menu"
          className="lg:hidden p-1 -ml-0.5 rounded-lg active:bg-[var(--aurora-chip)]"
          style={{ color: "var(--aurora-fg2)" }}
        >
          <Icon name="menu" size={19} />
        </button>

        {/* Desktop Sidebar toggle when collapsed */}
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            title="展开侧边栏 (⌘B)"
            className="hidden lg:flex items-center justify-center p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors app-region-no-drag"
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
          >
            <Icon name="sidebar" size={16} />
          </button>
        )}

        {/* Current Section Title (Mobile & Desktop) */}
        <div className="flex items-center gap-2 min-w-0">
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: "var(--aurora-brand-grad)",
              boxShadow: "0 2px 8px -2px rgba(124,58,237,0.4), inset 0 1px 0 rgba(255,255,255,0.28)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon name={pageMeta.icon} size={12} style={{ color: "#fff" }} strokeWidth={2.2} />
          </div>
          <span
            className="truncate text-[13px] sm:text-[13.5px]"
            style={{
              fontWeight: 600,
              color: "var(--aurora-fg1)",
              letterSpacing: "-0.015em",
            }}
          >
            {pageMeta.title}
          </span>
        </div>

        <span
          className="hidden sm:inline-block h-3 w-[1px] mx-1"
          style={{ background: "var(--aurora-border-strong)" }}
        />

        {/* Language switcher */}
        <div className="hidden sm:flex gap-0.5 app-region-no-drag">
          {(Object.keys(locales) as Locale[]).map((l) => {
            const active = locale === l;
            return (
              <button
                key={l}
                onClick={() => setLocale(l)}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: active ? 600 : 500,
                  letterSpacing: "-0.005em",
                  border: 0,
                  cursor: "pointer",
                  background: active ? "var(--aurora-accent-soft)" : "transparent",
                  color: active ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  transition: "all .15s",
                }}
              >
                {locales[l].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="hidden md:block"><SkinPicker /></div>
        <ThemeToggle />
        {!user && (
          <Link
            href="/auth/login"
            style={{ fontSize: 13, color: "var(--aurora-accent)", fontWeight: 500, letterSpacing: "-0.01em" }}
          >
            {t.login}
          </Link>
        )}
      </div>
    </header>
  );
}
