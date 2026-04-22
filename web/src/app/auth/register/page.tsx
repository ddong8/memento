"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Glass, GhostInput } from "@/components/aurora/primitives";
import { TokenDisplay } from "@/components/TokenDisplay";
import { api, type UserInfo } from "@/lib/api-client";

// Defined at module scope — NOT inside RegisterPage. Otherwise every keystroke
// re-creates the component type and React remounts the subtree, stealing focus.
function Wrap({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <Glass padding={36} radius={24} style={{ width: "100%", maxWidth: wide ? 520 : 380 }}>
        {children}
      </Glass>
    </div>
  );
}

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [registered, setRegistered] = useState<UserInfo | null>(null);
  const [mode, setMode] = useState<{ mode: "open" | "invite_only" | "closed"; has_any_user: boolean } | null>(null);
  const { register } = useAuth();
  const { t } = useI18n();

  useEffect(() => {
    api.getRegistrationMode().then(setMode).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const info = await register(email, password, name || undefined, inviteCode || undefined);
      setRegistered(info);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t.auth.invalidCredentials);
    }
  };

  if (registered) {
    const isOwner = registered.role === "owner" && registered.status === "active" && !!registered.collector_token;
    return (
      <Wrap wide={isOwner}>
        <div style={{ textAlign: isOwner ? "left" : "center" }}>
          <div
            style={{
              width: 56, height: 56, borderRadius: 16,
              background: "linear-gradient(135deg,#10B981,#34D399)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: isOwner ? "0 0 16px" : "0 auto 16px",
              boxShadow: "0 12px 40px -10px rgba(16,185,129,0.5)",
            }}
          >
            <Icon name="check" size={28} style={{ color: "#fff" }} strokeWidth={2.4} />
          </div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.03em" }}>
            {t.auth.registerSuccess}
          </h2>
          {isOwner ? (
            <>
              <p style={{ fontSize: 13, color: "var(--aurora-fg2)", margin: "10px 0 4px", fontWeight: 500 }}>
                {t.auth.ownerWelcome}
              </p>
              <p style={{ fontSize: 12, color: "var(--aurora-fg3)", margin: "0 0 18px" }}>
                {t.auth.tokenSaveHint}
              </p>
              <div style={{ fontSize: 11, color: "var(--aurora-fg4)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontWeight: 600 }}>
                {t.auth.collectorTokenLabel}
              </div>
              <TokenDisplay token={registered.collector_token} maskByDefault={false} />
              <div style={{ marginTop: 20, textAlign: "center" }}>
                <Link href="/auth/login" style={{ color: "var(--aurora-accent)", fontSize: 13, fontWeight: 500 }}>
                  {t.auth.goToLogin}
                </Link>
              </div>
            </>
          ) : (
            <>
              <p style={{ fontSize: 13, color: "var(--aurora-fg3)", margin: "10px 0 18px" }}>
                {t.auth.pendingApproval}
              </p>
              <Link href="/auth/login" style={{ color: "var(--aurora-accent)", fontSize: 13, fontWeight: 500 }}>
                {t.auth.goToLogin}
              </Link>
            </>
          )}
        </div>
      </Wrap>
    );
  }

  return (
    <Wrap>
      <div
        style={{
          width: 56, height: 56, borderRadius: 16,
          background: "var(--aurora-brand-grad)",
          display: "flex", alignItems: "center", justifyContent: "center",
          margin: "0 auto 16px",
          boxShadow: "0 12px 40px -10px rgba(124,58,237,0.5)",
        }}
      >
        <Icon name="sparkles" size={26} style={{ color: "#fff" }} strokeWidth={2} />
      </div>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: "var(--aurora-fg1)", textAlign: "center", letterSpacing: "-0.03em" }}>
        {t.auth.registerTitle}
      </h1>
      <p style={{ margin: "6px 0 22px", fontSize: 13, color: "var(--aurora-fg3)", textAlign: "center" }}>
        {t.app.title}
      </p>
      {mode?.mode === "closed" && mode.has_any_user && (
        <div style={{
          padding: 10, borderRadius: 10, marginBottom: 12,
          background: "rgba(239,68,68,0.10)", color: "#B91C1C", fontSize: 13,
        }}>
          {t.auth.registrationClosed}
        </div>
      )}
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(239,68,68,0.10)",
              color: "#B91C1C",
              fontSize: 13,
            }}
          >
            {error}
          </div>
        )}
        <GhostInput type="text" placeholder={t.auth.name} value={name} onChange={(e) => setName(e.target.value)} icon="user" />
        <GhostInput type="email" placeholder={t.auth.email} value={email} onChange={(e) => setEmail(e.target.value)} required icon="message" />
        <GhostInput type="password" placeholder={t.auth.password} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} icon="lock" />
        {/* Invite code: required if mode=invite_only (and not first user), optional otherwise */}
        {mode && !(mode.mode === "open" && !mode.has_any_user /* first-user shortcut */) && (
          <GhostInput
            type="text"
            placeholder={mode.mode === "invite_only" ? t.auth.inviteCodeRequired : t.auth.inviteCodeOptional}
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required={mode.mode === "invite_only" && mode.has_any_user}
            icon="sparkles"
          />
        )}
        <Btn
          type="submit"
          size="lg"
          style={{ marginTop: 6, width: "100%", justifyContent: "center" }}
          iconRight="arrow_right"
          disabled={mode?.mode === "closed" && mode.has_any_user}
        >
          {t.register}
        </Btn>
      </form>
      <p style={{ textAlign: "center", fontSize: 12, color: "var(--aurora-fg4)", marginTop: 18 }}>
        {t.auth.hasAccount}{" "}
        <Link href="/auth/login" style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>
          {t.login}
        </Link>
      </p>
    </Wrap>
  );
}
