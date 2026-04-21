"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type PublicStats } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Chip } from "@/components/aurora/primitives";

export function Hero() {
  const { t } = useI18n();
  const { token, loading } = useAuth();
  const [stats, setStats] = useState<PublicStats | null>(null);

  useEffect(() => {
    api.getPublicStats().then(setStats).catch(() => {});
  }, []);

  return (
    <section
      style={{
        padding: "72px 20px 56px",
        maxWidth: 1100,
        margin: "0 auto",
        textAlign: "center",
      }}
    >
      <Chip tone="accent" icon="sparkles" style={{ marginBottom: 20 }}>
        {t.landing.features_sub}
      </Chip>
      <h1
        style={{
          margin: 0,
          fontSize: "clamp(32px, 6vw, 56px)",
          fontWeight: 600,
          letterSpacing: "-0.035em",
          lineHeight: 1.08,
          color: "var(--aurora-fg1)",
          maxWidth: 820,
          marginInline: "auto",
        }}
      >
        {t.landing.hero_title}
      </h1>
      <p
        style={{
          margin: "18px auto 30px",
          fontSize: "clamp(14px, 2vw, 17px)",
          color: "var(--aurora-fg3)",
          letterSpacing: "-0.01em",
          lineHeight: 1.55,
          maxWidth: 640,
        }}
      >
        {t.landing.hero_sub}
      </p>

      {/* CTAs */}
      <div
        style={{
          display: "flex",
          gap: 12,
          justifyContent: "center",
          flexWrap: "wrap",
          marginBottom: 28,
        }}
      >
        {!loading && (
          <Link href={token ? "/app" : "/auth/login"} style={{ textDecoration: "none" }}>
            <button className="aurora-btn aurora-btn-lg">
              {token ? t.landing.cta_dashboard : t.landing.cta_login}
              <Icon name="arrow_right" size={14} />
            </button>
          </Link>
        )}
        <a href="#install" style={{ textDecoration: "none" }}>
          <button className="aurora-btn aurora-btn-lg aurora-btn-glass">
            <Icon name="terminal" size={14} />
            {t.landing.cta_install}
          </button>
        </a>
      </div>

      {/* Live stats */}
      {stats && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 18,
            padding: "10px 18px",
            borderRadius: 9999,
            border: "1px solid var(--aurora-border)",
            background: "var(--aurora-surface)",
            backdropFilter: "var(--aurora-blur)",
            fontSize: 13,
            color: "var(--aurora-fg2)",
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <StatPiece value={stats.total_documents} label={t.landing.stats_files} />
          <span style={{ color: "var(--aurora-fg5)" }}>·</span>
          <StatPiece value={stats.total_devices} label={t.landing.stats_devices} />
          <span style={{ color: "var(--aurora-fg5)" }}>·</span>
          <StatPiece value={stats.total_tools} label={t.landing.stats_tools} />
          <span style={{ color: "var(--aurora-fg5)" }}>·</span>
          <StatPiece value={stats.total_messages} label={t.landing.stats_messages} />
        </div>
      )}
    </section>
  );
}

function StatPiece({ value, label }: { value: number; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
      <b
        style={{
          color: "var(--aurora-fg1)",
          fontSize: 15,
          fontWeight: 600,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          letterSpacing: "-0.02em",
        }}
      >
        {value.toLocaleString()}
      </b>
      <span style={{ color: "var(--aurora-fg4)", fontSize: 12 }}>{label}</span>
    </span>
  );
}
