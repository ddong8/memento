"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

// Per-platform installers are published on every `v*` GitHub release.
// Asset names embed version + arch and change each release, so we link
// the stable "latest release" page rather than hard-coding filenames.
const RELEASES_LATEST = "https://github.com/ddong8/memento/releases/latest";

export function DesktopBlock() {
  const { t } = useI18n();
  const platforms = [
    { os: t.landing.desktop_macos, ext: t.landing.desktop_macos_ext },
    { os: t.landing.desktop_windows, ext: t.landing.desktop_windows_ext },
    { os: t.landing.desktop_linux, ext: t.landing.desktop_linux_ext },
  ];

  return (
    <section id="desktop" style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.desktop_title}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.desktop_sub}
        </h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 16 }}>
        {platforms.map((p) => (
          <DownloadCard key={p.os} os={p.os} ext={p.ext} />
        ))}
      </div>
      <p
        style={{
          marginTop: 18,
          fontSize: 12,
          color: "var(--aurora-fg4)",
          textAlign: "center",
          maxWidth: 680,
          marginInline: "auto",
        }}
      >
        {t.landing.desktop_note}
      </p>
    </section>
  );
}

function DownloadCard({ os, ext }: { os: string; ext: string }) {
  const { t } = useI18n();
  return (
    <a href={RELEASES_LATEST} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
      <Glass hover padding={0} radius={16} style={{ overflow: "hidden" }}>
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--aurora-border)",
            fontSize: 11,
            fontWeight: 600,
            color: "var(--aurora-fg4)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {os}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "20px 18px",
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.02em" }}>
              {t.landing.desktop_btn}
            </div>
            <div
              style={{
                fontSize: 12,
                color: "var(--aurora-fg4)",
                marginTop: 3,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              {ext}
            </div>
          </div>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 38,
              height: 38,
              borderRadius: 12,
              background: "var(--aurora-brand-grad)",
              boxShadow: "0 8px 24px -8px rgba(124,58,237,0.5)",
              flexShrink: 0,
            }}
          >
            <Icon name="chevron_right" size={18} style={{ color: "#fff" }} strokeWidth={2.5} />
          </span>
        </div>
      </Glass>
    </a>
  );
}
