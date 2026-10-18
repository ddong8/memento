"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

type IconName = Parameters<typeof Icon>[0]["name"];

export function Features() {
  const { t } = useI18n();
  const cards: { icon: IconName; title: string; desc: string }[] = [
    { icon: "refresh", title: t.landing.f1_title, desc: t.landing.f1_desc },
    { icon: "brain", title: t.landing.f2_title, desc: t.landing.f2_desc },
    { icon: "search", title: t.landing.f3_title, desc: t.landing.f3_desc },
    { icon: "calendar", title: t.landing.f4_title, desc: t.landing.f4_desc },
    { icon: "lock", title: t.landing.f5_title, desc: t.landing.f5_desc },
    { icon: "cube", title: t.landing.f6_title, desc: t.landing.f6_desc },
  ];

  return (
    <section id="features" style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.features_title}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.features_sub}
        </h2>
      </div>
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"
        style={{ gap: 16 }}
      >
        {cards.map((c) => (
          <Glass key={c.title} padding={22} radius={20} hover>
            <div
              style={{
                width: 38, height: 38, borderRadius: 11,
                background: "var(--aurora-accent-soft)",
                color: "var(--aurora-accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                marginBottom: 14,
              }}
            >
              <Icon name={c.icon} size={18} />
            </div>
            <h3
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 600,
                color: "var(--aurora-fg1)",
                letterSpacing: "-0.015em",
                marginBottom: 6,
              }}
            >
              {c.title}
            </h3>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--aurora-fg3)",
                lineHeight: 1.6,
                letterSpacing: "-0.005em",
              }}
            >
              {c.desc}
            </p>
          </Glass>
        ))}
      </div>
    </section>
  );
}
