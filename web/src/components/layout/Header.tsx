"use client";

import Link from "next/link";
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
  const [isMacDesktop, setIsMacDesktop] = useState(false);

  useEffect(() => {
    if (desktop() && typeof navigator !== "undefined" && (/Mac/i.test(navigator.userAgent) || /Mac/i.test((navigator as { platform?: string }).platform || ""))) {
      setIsMacDesktop(true);
    }
  }, []);

  return (
    <header
      className={`h-14 flex items-center justify-between px-3 sm:px-4 md:px-6 fixed top-0 left-0 ${collapsed ? "lg:left-[68px]" : "lg:left-60"} right-0 z-20 transition-all duration-200 ${isMacDesktop ? "app-region-drag" : ""}`}
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
          className="lg:hidden p-1"
          style={{ color: "var(--aurora-fg2)" }}
        >
          <Icon name="menu" size={22} />
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
