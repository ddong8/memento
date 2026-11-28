"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useI18n, locales, type Locale } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { MementoMark } from "@/components/aurora/MementoMark";
import { ThemeToggle, SkinPicker } from "@/components/aurora/primitives";

export function LandingNav() {
  const { t, locale, setLocale } = useI18n();
  const { token, loading } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        padding: "12px 20px",
        background: scrolled ? "var(--aurora-surface)" : "transparent",
        backdropFilter: scrolled ? "var(--aurora-blur)" : "none",
        WebkitBackdropFilter: scrolled ? "var(--aurora-blur)" : "none",
        borderBottom: scrolled ? "1px solid var(--aurora-border)" : "1px solid transparent",
        transition: "background-color 180ms ease, border-color 180ms ease",
      }}
    >
      <div
        style={{
          maxWidth: 1120,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        {/* Brand — stronger visual presence than nav links */}
        <Link
          href="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            textDecoration: "none",
            color: "var(--aurora-fg1)",
            minWidth: 0,
          }}
        >
          <MementoMark size={30} radius={8} />
          <span style={{ fontWeight: 700, fontSize: 16.5, letterSpacing: "-0.03em", whiteSpace: "nowrap" }}>
            {t.app.title}
          </span>
        </Link>

        {/* Anchor links — desktop only */}
        <div
          className="hidden md:flex"
          style={{ alignItems: "center", gap: 24, marginLeft: 24, flex: 1 }}
        >
          <NavLink href="#features">{t.landing.nav_features}</NavLink>
          <NavLink href="#workbench">{t.landing.nav_workbench}</NavLink>
          <NavLink href="#tools">{t.landing.nav_tools}</NavLink>
          <NavLink href="#desktop">{t.landing.nav_install}</NavLink>
          <NavLink href="https://github.com/ddong8/memento" external>
            {t.landing.nav_github}
          </NavLink>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <div
            style={{
              display: "inline-flex",
              gap: 2,
              padding: 2,
              borderRadius: 8,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              flexShrink: 0,
            }}
          >
            {(Object.keys(locales) as Locale[]).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                aria-label={`Switch to ${locales[l].label}`}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: locale === l ? 600 : 500,
                  border: 0,
                  background: locale === l ? "var(--aurora-surface-solid)" : "transparent",
                  color: locale === l ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  transition: "background-color 150ms ease, color 150ms ease",
                }}
              >
                {l === "en-US" ? (
                  <>
                    <span className="sm:hidden">EN</span>
                    <span className="hidden sm:inline">{locales[l].label}</span>
                  </>
                ) : (
                  locales[l].label
                )}
              </button>
            ))}
          </div>
          <div className="hidden lg:block"><SkinPicker /></div>
          <ThemeToggle />
          {!loading && (
            <Link href={token ? "/ask" : "/auth/login"} style={{ textDecoration: "none" }}>
              <button
                type="button"
                className="aurora-btn aurora-btn-sm"
                style={{ padding: "7px 14px" }}
              >
                {token ? t.landing.cta_dashboard : t.landing.cta_login}
                <Icon name="arrow_right" size={12.5} />
              </button>
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

function NavLink({
  href, children, external = false,
}: { href: string; children: React.ReactNode; external?: boolean }) {
  const Comp = external ? "a" : Link;
  const props = external ? { href, target: "_blank", rel: "noreferrer" } : { href };
  return (
    <Comp
      {...props}
      style={{
        fontSize: 13.5,
        fontWeight: 500,
        color: "var(--aurora-fg3)",
        textDecoration: "none",
        letterSpacing: "-0.01em",
        transition: "color 150ms ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-fg1)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg3)")}
    >
      {children}
    </Comp>
  );
}
