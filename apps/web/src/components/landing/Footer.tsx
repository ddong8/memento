"use client";

import { useI18n } from "@/lib/i18n";
import { MementoMark } from "@/components/aurora/MementoMark";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer
      style={{
        padding: "36px 20px 44px",
        maxWidth: 1120,
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
          gap: 16,
          fontSize: 13,
          color: "var(--aurora-fg4)",
        }}
      >
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
          <MementoMark size={22} radius={6} />
          <span>© {new Date().getFullYear()} Memento · {t.landing.footer_tagline}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
          <FooterLink href="https://github.com/ddong8/memento">
            {t.landing.footer_github}
          </FooterLink>
          <FooterLink href="https://github.com/ddong8/memento/releases/latest">
            {t.landing.footer_download}
          </FooterLink>
          <FooterLink href="/install">{t.landing.footer_install}</FooterLink>
          <FooterLink href="/docs">{t.landing.footer_api}</FooterLink>
          <FooterLink href="/privacy">隐私政策</FooterLink>
          <FooterLink href="/support">技术支持</FooterLink>
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
      style={{
        color: "var(--aurora-fg3)",
        textDecoration: "none",
        transition: "color 150ms ease",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = "var(--aurora-accent)")}
      onMouseLeave={(e) => (e.currentTarget.style.color = "var(--aurora-fg3)")}
    >
      {children}
    </a>
  );
}
