"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { Btn, Glass, GhostInput } from "@/components/aurora/primitives";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const { login } = useAuth();
  const { t } = useI18n();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try { await login(email, password); router.push("/app"); }
    catch { setError(t.auth.invalidCredentials); }
  };

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
      <Glass padding={36} radius={24} style={{ width: "100%", maxWidth: 380 }}>
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
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
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
            fontSize: 13,
            color: "var(--aurora-fg3)",
            textAlign: "center",
            letterSpacing: "-0.01em",
          }}
        >
          {t.app.title}
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {error && (
            <div
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(239,68,68,0.10)",
                color: "#B91C1C",
                fontSize: 13,
                letterSpacing: "-0.005em",
              }}
            >
              {error}
            </div>
          )}
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
        <p style={{ textAlign: "center", fontSize: 12, color: "var(--aurora-fg4)", marginTop: 18 }}>
          {t.auth.noAccount}{" "}
          <Link href="/auth/register" style={{ color: "var(--aurora-accent)", fontWeight: 500 }}>
            {t.register}
          </Link>
        </p>
      </Glass>
    </div>
  );
}
