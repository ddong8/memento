"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

const RELEASES_LATEST = "https://github.com/ddong8/memento/releases/latest";

type IconName = Parameters<typeof Icon>[0]["name"];

export function DesktopBlock() {
  const { t } = useI18n();
  const platforms: { os: string; ext: string; icon: IconName }[] = [
    { os: t.landing.desktop_macos, ext: t.landing.desktop_macos_ext, icon: "apple" },
    { os: t.landing.desktop_windows, ext: t.landing.desktop_windows_ext, icon: "windows" },
    { os: t.landing.desktop_linux, ext: t.landing.desktop_linux_ext, icon: "linux" },
    { os: t.landing.desktop_ios, ext: t.landing.desktop_ios_ext, icon: "apple" },
    { os: t.landing.desktop_android, ext: t.landing.desktop_android_ext, icon: "devices" },
  ];

  return (
    <section id="desktop" style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ maxWidth: 740, marginBottom: 28 }}>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(24px, 3.2vw, 32px)",
            fontWeight: 700,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.03em",
            lineHeight: 1.18,
          }}
        >
          {t.landing.desktop_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.desktop_sub}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5" style={{ gap: 14 }}>
        {platforms.map((p) => (
          <DownloadCard key={p.os} os={p.os} ext={p.ext} icon={p.icon} />
        ))}
      </div>
      <p
        style={{
          marginTop: 16,
          fontSize: 13,
          color: "var(--aurora-fg4)",
          maxWidth: 720,
          lineHeight: 1.6,
        }}
      >
        {t.landing.desktop_note}
      </p>
    </section>
  );
}

function DownloadCard({ os, ext, icon }: { os: string; ext: string; icon: IconName }) {
  const { t } = useI18n();
  return (
    <a
      href={RELEASES_LATEST}
      target="_blank"
      rel="noreferrer"
      className="aurora-card aurora-card-hover group"
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 18,
        borderRadius: 14,
        textDecoration: "none",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            color: "var(--aurora-fg1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={17} />
        </div>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--aurora-accent-soft)",
            color: "var(--aurora-accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="download" size={15} />
        </span>
      </div>
      <div>
        <div style={{ fontSize: 15.5, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.015em" }}>
          {os} · {t.landing.desktop_btn}
        </div>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--aurora-fg4)",
            marginTop: 4,
            fontFamily: "var(--font-mono)",
          }}
        >
          {ext}
        </div>
      </div>
    </a>
  );
}
