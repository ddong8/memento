"use client";

import { useI18n } from "@/lib/i18n";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer
      style={{
        padding: "36px 20px",
        maxWidth: 1100,
        margin: "32px auto 0",
        borderTop: "1px solid var(--aurora-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          fontSize: 12,
          color: "var(--aurora-fg4)",
          letterSpacing: "-0.005em",
        }}
      >
        <span>© {new Date().getFullYear()} · {t.landing.footer_tagline}</span>
        <div style={{ display: "flex", gap: 18 }}>
          <FooterLink href="https://github.com/ddong8/memento">
            {t.landing.footer_github}
          </FooterLink>
          <FooterLink href="/install">{t.landing.footer_install}</FooterLink>
          <FooterLink href="/docs">{t.landing.footer_api}</FooterLink>
        </div>
      </div>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  const external = href.startsWith("http");
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noreferrer" : undefined}
      style={{ color: "var(--aurora-fg3)", textDecoration: "none" }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-accent)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg3)")}
    >
      {children}
    </a>
  );
}
