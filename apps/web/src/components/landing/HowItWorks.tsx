"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

type IconName = Parameters<typeof Icon>[0]["name"];

export function HowItWorks() {
  const { t } = useI18n();
  const steps: { icon: IconName; title: string; desc: string }[] = [
    { icon: "devices", title: t.landing.how_1_title, desc: t.landing.how_1_desc },
    { icon: "server", title: t.landing.how_2_title, desc: t.landing.how_2_desc },
    { icon: "layers", title: t.landing.how_3_title, desc: t.landing.how_3_desc },
  ];

  return (
    <section style={{ padding: "56px 20px", maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ maxWidth: 680, marginBottom: 28 }}>
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
          {t.landing.how_title}
        </h2>
        <p style={{ margin: "10px 0 0", fontSize: 15, color: "var(--aurora-fg3)", lineHeight: 1.55 }}>
          {t.landing.how_sub}
        </p>
      </div>

      {/* Unified macOS frosted glass 3-stage pipeline */}
      <div
        className="grid grid-cols-1 md:grid-cols-3 aurora-glass-panel"
        style={{
          borderRadius: 18,
          overflow: "hidden",
        }}
      >
        {steps.map((s, i) => (
          <div
            key={s.title}
            className={i < steps.length - 1 ? "border-b md:border-b-0 md:border-r" : ""}
            style={{
              padding: "24px 22px",
              borderColor: "var(--aurora-border)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
                }}
              >
                <Icon name={s.icon} size={17} />
              </div>
              {i < steps.length - 1 && (
                <Icon name="arrow_right" size={16} className="hidden md:block" style={{ color: "var(--aurora-fg4)" }} />
              )}
            </div>
            <h3
              style={{
                margin: "4px 0 0",
                fontSize: 16,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                letterSpacing: "-0.015em",
              }}
            >
              {s.title}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: "var(--aurora-fg3)",
                lineHeight: 1.62,
              }}
            >
              {s.desc}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
