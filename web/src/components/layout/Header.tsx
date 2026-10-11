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

export default function Header({ onMenuToggle }: { onMenuToggle: () => void }) {
  const { user } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { collapsed, toggleCollapsed } = useSidebar();
  const pathname = usePathname();
  const [isMacDesktop, setIsMacDesktop] = useState(false);

  useEffect(() => {
    if (desktop() && typeof navigator !== "undefined" && (/Mac/i.test(navigator.userAgent) || /Mac/i.test((navigator as { platform?: string }).platform || ""))) {
      setIsMacDesktop(true);
    }
  }, []);

  const mobilePageTitle = (() => {
    if (!pathname) return t.app.title;
    if (pathname.startsWith("/ask")) return t.nav.ask || "AI 执事";
    if (pathname.startsWith("/memory/persona")) return t.nav.persona || "数字分身";
    if (pathname.startsWith("/memory")) return t.nav.memory || "认知大脑";
    if (pathname.startsWith("/daily")) return t.nav.daily || "作息节律";
    if (pathname.startsWith("/inbox") || pathname.startsWith("/tasks")) return t.nav.inbox || "工作待办";
    if (pathname.startsWith("/profile")) return "个人中心";
    if (pathname.startsWith("/projects")) return t.nav.projects || "项目空间";
    if (pathname.startsWith("/skills")) return t.nav.skills || "技能中心";
    if (pathname.startsWith("/app")) return t.nav.overview || "全景总览";
    return t.app.title;
  })();

  return (
    <header
      className={`h-11 sm:h-14 flex items-center justify-between px-3 sm:px-4 md:px-6 fixed top-0 left-0 ${collapsed ? "lg:left-[68px]" : "lg:left-60"} right-0 z-20 transition-all duration-200 ${isMacDesktop ? "app-region-drag" : ""}`}
      style={{
        background: "var(--aurora-surface)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderBottom: "1px solid var(--aurora-border)",
      }}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        {/* Mobile menu */}
        <button
          onClick={onMenuToggle}
          aria-label="Menu"
          className="lg:hidden p-1 -ml-0.5 rounded-lg active:bg-[var(--aurora-chip)]"
          style={{ color: "var(--aurora-fg2)" }}
        >
          <Icon name="menu" size={20} />
        </button>

        {/* Mobile Brand & Current Section Title */}
        <div className="flex lg:hidden items-center gap-2 min-w-0">
          <div
            style={{
              width: 22,
              height: 22,
              borderRadius: 7,
              background: "var(--aurora-brand-grad)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 2px 8px -2px rgba(124,58,237,0.45)",
              flexShrink: 0,
            }}
          >
            <Icon name="sparkles" size={12} style={{ color: "#fff" }} strokeWidth={2.2} />
          </div>
          <span
            className="truncate"
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: "var(--aurora-fg1)",
              letterSpacing: "-0.015em",
            }}
          >
            {mobilePageTitle}
          </span>
        </div>

        {/* Desktop Sidebar toggle when collapsed */}
        {collapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            title="展开侧边栏 (⌘B)"
            className="hidden lg:flex items-center justify-center p-1.5 rounded-lg text-[var(--aurora-fg3)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors app-region-no-drag"
            style={{ border: "none", background: "transparent", cursor: "pointer" }}
          >
            <Icon name="sidebar" size={17} />
          </button>
        )}

        {/* Language switcher */}
        <div className="hidden sm:flex gap-1">
          {(Object.keys(locales) as Locale[]).map((l) => {
            const active = locale === l;
            return (
              <button
                key={l}
                onClick={() => setLocale(l)}
                style={{
                  padding: "5px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 500,
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

      <div className="flex items-center gap-2 sm:gap-3">
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
