"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { api } from "@/lib/api-client";
import { Btn, Chip, Glass, TopBar, SectionLabel } from "@/components/aurora/primitives";
import { TokenDisplay } from "@/components/TokenDisplay";

export default function ProfilePage() {
  const { user, token, setUser, logout } = useAuth();
  const { t } = useI18n();
  const [rotating, setRotating] = useState(false);
  const [notice, setNotice] = useState("");

  if (!user) {
    return (
      <div style={{ textAlign: "center", color: "var(--aurora-fg4)", marginTop: 80 }}>
        {t.loading}
      </div>
    );
  }

  const handleRotate = async () => {
    if (!token) return;
    if (!confirm(t.profile.rotateConfirm)) return;
    setRotating(true);
    setNotice("");
    try {
      const fresh = await api.rotateCollectorToken(token);
      setUser(fresh);
      setNotice(t.profile.rotateSuccess);
    } catch (err: unknown) {
      setNotice(err instanceof Error ? err.message : "error");
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <TopBar title={t.profile.title} subtitle={t.profile.subtitle} />

      <SectionLabel>{t.admin.users}</SectionLabel>
      <Glass padding={22} radius={20} style={{ marginBottom: 20 }}>
        <Row label={t.profile.email} value={user.email} />
        <Row label={t.profile.name} value={user.name || "—"} />
        <Row
          label={t.profile.role}
          valueNode={<Chip>{user.role}</Chip>}
        />
        <Row
          label={t.profile.status}
          valueNode={<Chip tone={user.status === "active" ? "success" : "warn"}>{user.status}</Chip>}
        />
      </Glass>

      <SectionLabel>{t.profile.collectorToken}</SectionLabel>
      <Glass padding={22} radius={20} style={{ marginBottom: 20 }}>
        {user.collector_token ? (
          <>
            <TokenDisplay token={user.collector_token} maskByDefault={true} />
            <p style={{ fontSize: 12, color: "var(--aurora-fg4)", marginTop: 14, lineHeight: 1.55 }}>
              {t.profile.rotateHint}
            </p>
            <div style={{ marginTop: 12 }}>
              <Btn size="sm" icon="refresh" onClick={handleRotate} disabled={rotating}>
                {rotating ? "…" : t.profile.rotate}
              </Btn>
            </div>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>{t.profile.noToken}</p>
        )}
        {notice && (
          <div
            style={{
              marginTop: 14,
              padding: "8px 12px",
              borderRadius: 10,
              background: "rgba(16,185,129,0.10)",
              color: "#065F46",
              fontSize: 12,
            }}
          >
            {notice}
          </div>
        )}
      </Glass>

      <div style={{ textAlign: "right" }}>
        <Btn variant="ghost" size="sm" icon="log_out" onClick={logout}>
          {t.profile.logout}
        </Btn>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueNode,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid var(--aurora-border)",
        gap: 12,
      }}
    >
      <span style={{ fontSize: 13, color: "var(--aurora-fg3)" }}>{label}</span>
      {valueNode ?? (
        <span style={{ fontSize: 13, color: "var(--aurora-fg1)", fontWeight: 500 }}>{value}</span>
      )}
    </div>
  );
}
