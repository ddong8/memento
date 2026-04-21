"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useI18n, locales, type Locale } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { ThemeToggle, SkinPicker } from "@/components/aurora/primitives";

export function LandingNav() {
  const { t, locale, setLocale } = useI18n();
  const { token, loading } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
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
        transition: "all .2s",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        {/* Brand */}
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
          <div
            style={{
              width: 30, height: 30, borderRadius: 9,
              background: "var(--aurora-brand-grad)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 4px 14px -4px rgba(124,58,237,0.4)",
              flexShrink: 0,
            }}
          >
            <Icon name="sparkles" size={15} style={{ color: "#fff" }} strokeWidth={2} />
          </div>
          <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
            {t.app.title}
          </span>
        </Link>

        {/* Anchor links — hidden on mobile */}
        <div
          className="hidden md:flex"
          style={{ alignItems: "center", gap: 20, marginLeft: 18, flex: 1 }}
        >
          <NavLink href="#features">{t.landing.nav_features}</NavLink>
          <NavLink href="#tools">{t.landing.nav_tools}</NavLink>
          <NavLink href="#install">{t.landing.nav_install}</NavLink>
          <NavLink href="https://github.com/ddong8/memento" external>
            {t.landing.nav_github}
          </NavLink>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {/* Language pill */}
          <div className="hidden sm:flex" style={{ gap: 2 }}>
            {(Object.keys(locales) as Locale[]).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  border: 0,
                  background: locale === l ? "var(--aurora-accent-soft)" : "transparent",
                  color: locale === l ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  cursor: "pointer",
                }}
              >
                {locales[l].label}
              </button>
            ))}
          </div>
          <div className="hidden md:block"><SkinPicker /></div>
          <ThemeToggle />
          {!loading && (
            <Link href={token ? "/app" : "/auth/login"} style={{ textDecoration: "none" }}>
              <button
                className="aurora-btn aurora-btn-sm"
                style={{ padding: "6px 14px" }}
              >
                {token ? t.landing.cta_dashboard : t.landing.cta_login}
                <Icon name="arrow_right" size={12} />
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
        fontSize: 13,
        color: "var(--aurora-fg3)",
        textDecoration: "none",
        letterSpacing: "-0.01em",
        transition: "color .15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-fg1)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg3)")}
    >
      {children}
    </Comp>
  );
}
