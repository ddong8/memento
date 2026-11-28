"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { MementoMark } from "@/components/aurora/MementoMark";
import { Btn, Glass, GhostInput } from "@/components/aurora/primitives";
import { TokenDisplay } from "@/components/TokenDisplay";
import { api, getApiBase, openServerSwitchModal, type UserInfo } from "@/lib/api-client";
import { desktop } from "@/lib/desktop";
import { GithubLoginSection, SsoLoginButton } from "../github-login";

// Defined at module scope — NOT inside RegisterPage. Otherwise every keystroke
// re-creates the component type and React remounts the subtree, stealing focus.
function Wrap({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <Glass padding={32} radius={18} style={{ width: "100%", maxWidth: wide ? 520 : 388 }}>
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
  const [autoLoggedIn, setAutoLoggedIn] = useState(false);
  const [currentServer, setCurrentServer] = useState<string>("");
  const [mode, setMode] = useState<{ mode: "open" | "invite_only" | "closed"; has_any_user: boolean; github_enabled?: boolean; sso_enabled?: boolean; sso_name?: string; password_login?: boolean } | null>(null);
  const { register, login } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const isStandaloneLocal = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(currentServer);
  const isFreshStandalone = isStandaloneLocal && mode !== null && !mode.has_any_user;

  useEffect(() => {
    api.getRegistrationMode().then(setMode).catch(() => {});
    const initServer = async () => {
      const d = desktop();
      if (d?.server?.get) {
        try {
          const info = await d.server.get();
          if (info.current) {
            setCurrentServer(info.current.replace(/\/+$/, ""));
            return;
          }
        } catch {}
      }
      setCurrentServer(getApiBase().replace(/\/+$/, ""));
    };
    void initServer();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const info = await register(email, password, name || undefined, inviteCode || undefined);
      setRegistered(info);
      if (info.status === "active") {
        try {
          await login(email, password);
          setAutoLoggedIn(true);
        } catch {
          // fall back to manual goToLogin link below
        }
      }
      // Hand the brand-new token off to the Memento desktop app when
      // the page is embedded in its dashboard iframe (?embed=memento).
      if (typeof window !== "undefined" && info.collector_token) {
        try {
          const params = new URLSearchParams(window.location.search);
          if (params.get("embed") === "memento") {
            sessionStorage.setItem("memento_embed", "1");
          }
          if (
            sessionStorage.getItem("memento_embed") === "1" &&
            window.parent &&
            window.parent !== window
          ) {
            window.parent.postMessage(
              { type: "memento:token", collector_token: info.collector_token },
              "*",
            );
          }
        } catch { /* noop */ }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("API 429")) setError(t.auth.tooManyAttempts);
      else setError(err instanceof Error ? err.message : t.auth.invalidCredentials);
    }
  };

  if (registered) {
    // Show the collector-token panel whenever the server handed one back
    // — that now covers owner (first user), invite-accepted users, AND
    // open self-register (which is instant-active since the approval gate
    // was removed). Only a still-"pending" account (operator set
    // registration_mode without auto-token) falls through to the
    // wait-for-approval message.
    const hasToken = registered.status === "active" && !!registered.collector_token;
    return (
      <Wrap wide={hasToken}>
        <div style={{ textAlign: hasToken ? "left" : "center" }}>
          <div
            style={{
              width: 50, height: 50, borderRadius: 14,
              background: "var(--aurora-success)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: hasToken ? "0 0 16px" : "0 auto 16px",
            }}
          >
            <Icon name="check" size={26} style={{ color: "#fff" }} strokeWidth={2.4} />
          </div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--aurora-fg1)", letterSpacing: "-0.03em" }}>
            {t.auth.registerSuccess}
          </h2>
          {hasToken ? (
            <>
              <p style={{ fontSize: 13.5, color: "var(--aurora-fg2)", margin: "10px 0 4px", fontWeight: 500 }}>
                {registered.role === "owner" ? t.auth.ownerWelcome : t.auth.memberWelcome}
              </p>
              <p style={{ fontSize: 12.5, color: "var(--aurora-fg3)", margin: "0 0 18px" }}>
                {t.auth.tokenSaveHint}
              </p>
              <div style={{ fontSize: 12, color: "var(--aurora-fg3)", marginBottom: 8, fontWeight: 600 }}>
                {t.auth.collectorTokenLabel}
              </div>
              <TokenDisplay token={registered.collector_token} maskByDefault={false} />
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                {autoLoggedIn ? (
                  <Btn
                    type="button"
                    size="lg"
                    style={{ width: "100%", justifyContent: "center" }}
                    iconRight="arrow_right"
                    onClick={() => router.replace("/ask")}
                  >
                    进入 Memento 工作台
                  </Btn>
                ) : (
                  <Link href="/auth/login" style={{ color: "var(--aurora-accent)", fontSize: 13, fontWeight: 500 }}>
                    {t.auth.goToLogin}
                  </Link>
                )}
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
      <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
        <MementoMark size={50} radius={14} />
      </div>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--aurora-fg1)", textAlign: "center", letterSpacing: "-0.03em" }}>
        {isFreshStandalone ? "初始化单机模式" : t.auth.registerTitle}
      </h1>
      <p style={{ margin: "6px 0 22px", fontSize: 13.5, color: "var(--aurora-fg3)", textAlign: "center", lineHeight: 1.55 }}>
        {isFreshStandalone ? "创建你的本机所有者账号，数据仅存这台电脑，随时可切换服务端模式" : t.app.title}
      </p>
      {mode?.sso_enabled && (
        <div style={{ marginBottom: mode.password_login === false && mode.has_any_user ? 0 : 16 }}>
          <SsoLoginButton name={mode.sso_name || ""} />
        </div>
      )}
      {/* Everyone signs in with the company account: no email + password registration */}
      {mode?.password_login === false && mode.has_any_user ? (
        <p style={{ textAlign: "center", fontSize: 13, color: "var(--aurora-fg3)", margin: "14px 0 0" }}>
          {t.auth.ssoRequired}
        </p>
      ) : (<>
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
        {/* Invite code: never shown for the very first owner user (e.g. fresh standalone install) */}
        {mode && mode.has_any_user && (
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
          {isFreshStandalone ? "创建本机账号并开始使用" : t.register}
        </Btn>
      </form>
      {mode?.github_enabled && <GithubLoginSection />}
      </>)}
      {(!mode || mode.has_any_user) && (
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--aurora-fg4)", marginTop: 18 }}>
          {t.auth.hasAccount}{" "}
          <Link href="/auth/login" style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>
            {t.login}
          </Link>
        </p>
      )}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--aurora-border)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "var(--aurora-fg4)", flexWrap: "wrap" }}>
        <Icon name={isStandaloneLocal ? "devices" : "server"} size={13} style={{ color: "var(--aurora-fg3)" }} />
        <span>{isStandaloneLocal ? "当前为单机模式（本机）" : "服务器:"}</span>
        {!isStandaloneLocal && (
          <span style={{ color: "var(--aurora-fg2)", fontFamily: "var(--font-mono)", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentServer || "..."}
          </span>
        )}
        <button
          type="button"
          onClick={() => openServerSwitchModal()}
          style={{
            background: "none",
            border: "none",
            color: "var(--aurora-accent)",
            fontSize: 11,
            fontWeight: 500,
            cursor: "pointer",
            padding: "0 2px",
            textDecoration: "underline",
          }}
        >
          {isStandaloneLocal ? "已有服务端？切到服务端模式" : "切换服务器"}
        </button>
      </div>
    </Wrap>
  );
}
