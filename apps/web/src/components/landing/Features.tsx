"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

type IconName = Parameters<typeof Icon>[0]["name"];

export function Features() {
  const { t } = useI18n();
  const pillars: { icon: IconName; title: string; desc: string }[] = [
    { icon: "devices", title: t.landing.f1_title, desc: t.landing.f1_desc },
    { icon: "sparkles", title: t.landing.f2_title, desc: t.landing.f2_desc },
    { icon: "brain", title: t.landing.f8_title, desc: t.landing.f8_desc },
  ];

  const capabilities: { icon: IconName; title: string; desc: string }[] = [
    { icon: "zap", title: t.landing.f4_title, desc: t.landing.f4_desc },
    { icon: "layers", title: t.landing.f7_title, desc: t.landing.f7_desc },
    { icon: "user", title: t.landing.f3_title, desc: t.landing.f3_desc },
    { icon: "inbox", title: t.landing.f5_title, desc: t.landing.f5_desc },
    { icon: "calendar", title: t.landing.f6_title, desc: t.landing.f6_desc },
    { icon: "lock", title: t.landing.f9_title, desc: t.landing.f9_desc },
  ];

  return (
    <section id="features" style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ maxWidth: 680, marginBottom: 32 }}>
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
          {t.landing.features_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.features_sub}
        </p>
      </div>

      {/* Primary 3 pillars inside one crisp macOS frosted glass frame */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 aurora-glass-panel"
        style={{
          borderRadius: 18,
          overflow: "hidden",
          marginBottom: 28,
        }}
      >
        {pillars.map((c, idx) => (
          <div
            key={c.title}
            className={idx < pillars.length - 1 ? "border-b md:border-b-0 md:border-r" : ""}
            style={{
              padding: "24px 22px",
              borderColor: "var(--aurora-border)",
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: "var(--aurora-accent-soft)",
                color: "var(--aurora-accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Icon name={c.icon} size={17} />
            </div>
            <h3
              style={{
                margin: "0 0 8px",
                fontSize: 15.5,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                letterSpacing: "-0.015em",
                lineHeight: 1.35,
              }}
            >
              {c.title}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: "var(--aurora-fg3)",
                lineHeight: 1.62,
              }}
            >
              {c.desc}
            </p>
          </div>
        ))}
      </div>

      {/* Secondary 6 capabilities in an open hairline ledger — zero heavy nested card cages */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        style={{
          gap: "24px 28px",
          paddingTop: 24,
          borderTop: "1px solid var(--aurora-border)",
        }}
      >
        {capabilities.map((c) => (
          <div key={c.title} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Icon name={c.icon} size={16} style={{ color: "var(--aurora-accent)", flexShrink: 0 }} />
              <h3
                style={{
                  margin: 0,
                  fontSize: 15,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  letterSpacing: "-0.015em",
                }}
              >
                {c.title}
              </h3>
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 13.5,
                color: "var(--aurora-fg3)",
                lineHeight: 1.6,
              }}
            >
              {c.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
