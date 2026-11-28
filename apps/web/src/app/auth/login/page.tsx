"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { MementoMark } from "@/components/aurora/MementoMark";
import { Btn, Glass, GhostInput } from "@/components/aurora/primitives";
import { getApiBase, openServerSwitchModal } from "@/lib/api-client";
import { desktop } from "@/lib/desktop";
import { GithubLoginSection, SsoLoginButton, useAuthOptions, useOauthErrorMessage } from "../github-login";
import { WechatLoginSection, WechatMark } from "../wechat-login";

export default function LoginPage() {
  const [authTab, setAuthTab] = useState<"wechat" | "password">("wechat");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [currentServer, setCurrentServer] = useState<string>("");
  const { login, token, loading } = useAuth();
  const { t } = useI18n();
  const router = useRouter();
  const authOptions = useAuthOptions();
  const oauthError = useOauthErrorMessage();
  // Password sign-in turned off for the company: only the owner may still use it (to get in if SSO breaks)
  const [ownerPassword, setOwnerPassword] = useState(false);
  const classicLogin = authOptions.password_login || ownerPassword;
  const githubEnabled = authOptions.github_enabled && authOptions.password_login;

  useEffect(() => {
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

  // A fresh server (单机模式 just started) has no account to sign in to: the first one is created on the register page
  useEffect(() => {
    if (!authOptions.has_any_user && !token) router.replace("/auth/register");
  }, [authOptions.has_any_user, token, router]);

  // Auto-redirect if already authenticated
  useEffect(() => {
    if (!loading && token) {
      let next: string | null = null;
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        next = params.get("next");
      }
      const dest = next && next.startsWith("/") && !/^\/[/\\]/.test(next) ? next : "/ask";
      window.location.replace(dest);
    }
  }, [loading, token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, password);
      // Honor ?next= so visitors landing on a directed share land back on it
      // after authenticating, instead of dropping into the dashboard. Read
      // from window.location instead of useSearchParams() because the latter
      // forces the page out of Next 16's static prerender.
      let next: string | null = null;
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        next = params.get("next");
      }
      // Same-origin relative paths only — reject "//host" and "/\host"
      // (backslash normalizes to slash → protocol-relative open redirect).
      router.push(next && next.startsWith("/") && !/^\/[/\\]/.test(next) ? next : "/ask");
    } catch (err: unknown) {
      setError(err instanceof Error && err.message.startsWith("API 429") ? t.auth.tooManyAttempts : t.auth.invalidCredentials);
    }
  };

  const banner = error || (authOptions.sso_enabled ? "" : oauthError);
  const errorBox = (text: string) => (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--aurora-danger-soft)",
        color: "var(--aurora-danger)",
        fontSize: 13,
        letterSpacing: "-0.005em",
      }}
    >
      {text}
    </div>
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <Glass padding={32} radius={18} style={{ width: "100%", maxWidth: 388 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 16 }}>
          <MementoMark size={50} radius={14} />
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 22,
            fontWeight: 700,
            color: "var(--aurora-fg1)",
            textAlign: "center",
            letterSpacing: "-0.03em",
          }}
        >
          {t.auth.loginTitle}
        </h1>
        <p
          style={{
            margin: "6px 0 22px",
            fontSize: 13.5,
            color: "var(--aurora-fg3)",
            textAlign: "center",
            letterSpacing: "-0.01em",
          }}
        >
          {t.app.title}
        </p>

        {authOptions.sso_enabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: classicLogin ? 4 : 0 }}>
            {oauthError && errorBox(oauthError)}
            <SsoLoginButton name={authOptions.sso_name} />
            {classicLogin && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0 10px" }}>
                <div style={{ flex: 1, height: 1, background: "var(--aurora-border)" }} />
                <span style={{ fontSize: 12, color: "var(--aurora-fg4)" }}>{t.auth.orContinueWith}</span>
                <div style={{ flex: 1, height: 1, background: "var(--aurora-border)" }} />
              </div>
            )}
          </div>
        )}
        {!classicLogin && (
          <button
            type="button"
            onClick={() => { setOwnerPassword(true); setAuthTab("password"); }}
            style={{ display: "block", margin: "14px auto 0", background: "none", border: "none", color: "var(--aurora-fg4)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
          >
            {t.auth.ownerPasswordLogin}
          </button>
        )}
        {classicLogin && (
          <>
        {/* Tab Switcher */}
        <div
          style={{
            display: "flex",
            background: "var(--aurora-chip)",
            borderRadius: 10,
            padding: 3,
            marginBottom: 20,
            border: "1px solid var(--aurora-border)",
          }}
        >
          <button
            type="button"
            onClick={() => setAuthTab("wechat")}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "8px 0",
              fontSize: 13,
              fontWeight: authTab === "wechat" ? 600 : 500,
              color: authTab === "wechat" ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
              background: authTab === "wechat" ? "var(--aurora-surface-solid)" : "transparent",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              boxShadow: authTab === "wechat" ? "0 1px 3px rgba(17,17,24,0.08)" : "none",
              transition: "background-color 150ms ease, color 150ms ease, box-shadow 150ms ease",
            }}
          >
            <WechatMark size={16} />
            微信扫码
          </button>
          <button
            type="button"
            onClick={() => setAuthTab("password")}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "8px 0",
              fontSize: 13,
              fontWeight: authTab === "password" ? 600 : 500,
              color: authTab === "password" ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
              background: authTab === "password" ? "var(--aurora-surface-solid)" : "transparent",
              borderRadius: 8,
              border: "none",
              cursor: "pointer",
              boxShadow: authTab === "password" ? "0 1px 3px rgba(17,17,24,0.08)" : "none",
              transition: "background-color 150ms ease, color 150ms ease, box-shadow 150ms ease",
            }}
          >
            <Icon name="lock" size={15} />
            密码登录
          </button>
        </div>

        {authTab === "wechat" ? (
          <WechatLoginSection />
        ) : (
          <>
            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {banner && errorBox(banner)}
              <GhostInput
                type="email"
                placeholder={t.auth.email}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                icon="user"
              />
              <GhostInput
                type="password"
                placeholder={t.auth.password}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                icon="lock"
              />
              <Btn type="submit" size="lg" style={{ marginTop: 6, width: "100%", justifyContent: "center" }} iconRight="arrow_right">
                {t.login}
              </Btn>
            </form>
            {githubEnabled && <GithubLoginSection />}
          </>
        )}
          </>
        )}
        {authOptions.password_login && (
          <p style={{ textAlign: "center", fontSize: 12, color: "var(--aurora-fg4)", marginTop: 18 }}>
            {t.auth.noAccount}{" "}
            <Link href="/auth/register" style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>
              {t.register}
            </Link>
          </p>
        )}
        <p style={{ textAlign: "center", fontSize: 11, color: "var(--aurora-fg4)", marginTop: 12 }}>
          使用即代表您已阅读并同意{" "}
          <Link href="/privacy" style={{ color: "var(--aurora-fg3)", textDecoration: "underline" }}>
            隐私政策
          </Link>{" "}
          与{" "}
          <Link href="/support" style={{ color: "var(--aurora-fg3)", textDecoration: "underline" }}>
            技术支持
          </Link>
        </p>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--aurora-border)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11, color: "var(--aurora-fg4)" }}>
          <Icon name="server" size={13} style={{ color: "var(--aurora-fg3)" }} />
          <span>服务器:</span>
          <span style={{ color: "var(--aurora-fg2)", fontFamily: "var(--font-mono)", maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentServer || "..."}
          </span>
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
            切换
          </button>
        </div>
      </Glass>
    </div>
  );
}
