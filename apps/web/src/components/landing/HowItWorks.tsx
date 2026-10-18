"use client";

import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Glass, SectionLabel } from "@/components/aurora/primitives";

type IconName = Parameters<typeof Icon>[0]["name"];

export function HowItWorks() {
  const { t } = useI18n();
  const steps: { icon: IconName; label: string; title: string; desc: string }[] = [
    { icon: "devices",   label: "01", title: t.landing.how_1_title, desc: t.landing.how_1_desc },
    { icon: "terminal",  label: "02", title: t.landing.how_2_title, desc: t.landing.how_2_desc },
    { icon: "layers",    label: "03", title: t.landing.how_3_title, desc: t.landing.how_3_desc },
  ];
  return (
    <section style={{ padding: "48px 20px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <SectionLabel style={{ margin: 0, marginBottom: 8 }}>{t.landing.how_title}</SectionLabel>
        <h2
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 30px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.025em",
          }}
        >
          {t.landing.how_sub}
        </h2>
      </div>
      <div
        className="grid grid-cols-1 md:grid-cols-3"
        style={{ gap: 16, position: "relative" }}
      >
        {steps.map((s, i) => (
          <div key={s.label} style={{ position: "relative" }}>
            <Glass padding={22} radius={20} style={{ height: "100%" }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--aurora-fg4)",
                  letterSpacing: "0.12em",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  marginBottom: 10,
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  width: 38, height: 38, borderRadius: 11,
                  background: "var(--aurora-accent-soft)",
                  color: "var(--aurora-accent)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14,
                }}
              >
                <Icon name={s.icon} size={18} />
              </div>
              <h3
                style={{
                  margin: 0,
                  fontSize: 16,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  letterSpacing: "-0.015em",
                  marginBottom: 6,
                }}
              >
                {s.title}
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
                {s.desc}
              </p>
            </Glass>
            {/* Connector arrow between cards (md+) */}
            {i < steps.length - 1 && (
              <div
                className="hidden md:flex"
                aria-hidden
                style={{
                  position: "absolute",
                  top: "50%",
                  right: -18,
                  transform: "translateY(-50%)",
                  width: 32,
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--aurora-fg4)",
                  zIndex: 1,
                  pointerEvents: "none",
                }}
              >
                <Icon name="arrow_right" size={18} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
