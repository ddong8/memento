"use client";

import { useEffect } from "react";
import { useI18n } from "@/lib/i18n";
import { Glass } from "@/components/aurora/primitives";

/**
 * GitHub OAuth landing page. The server redirects here with the JWT in the
 * URL *fragment* (#token=...&next=...) so it never reaches server logs.
 * Store it, then hard-navigate (window.location.replace, NOT router.push)
 * on purpose: AuthProvider lazily initializes its token from localStorage
 * on first render, so a full reload is what makes it pick the token up.
 */
export default function AuthCallbackPage() {
  const { t } = useI18n();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    const next = params.get("next");
    if (token) {
      localStorage.setItem("dr_token", token);
      // Only allow same-origin relative paths — reject "//host" and "/\host"
      // (browsers normalize backslash to slash, making it protocol-relative).
      window.location.replace(
        next && next.startsWith("/") && !/^\/[/\\]/.test(next) ? next : "/app",
      );
    } else {
      window.location.replace("/auth/login?error=github_oauth_failed");
    }
  }, []);

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
        <p
          style={{
            margin: 0,
            fontSize: 14,
            color: "var(--aurora-fg2)",
            textAlign: "center",
            letterSpacing: "-0.01em",
          }}
        >
          {t.auth.signingIn}
        </p>
      </Glass>
    </div>
  );
}
