"use client";

import { useEffect, useRef, useState } from "react";

// Token hand-off target for the Memento desktop app. The desktop client
// already authenticated the user (in-app register/login), mints a fresh
// web JWT, and loads this page with `#token=<JWT>` in the URL hash. We
// persist it the same way the normal login flow does (localStorage
// `dr_token`) and then do a FULL navigation to /app — a hard reload so
// AuthProvider re-mounts and lazy-inits its token from localStorage
// (a client-side router push would keep the stale null-token provider
// and bounce straight back to /auth/login).
//
// Hash (not query string) keeps the JWT out of server logs / Referer.
export default function HandoffPage() {
  const [failed, setFailed] = useState(false);
  const handledRef = useRef(false);

  useEffect(() => {
    if (handledRef.current) return;
    handledRef.current = true;

    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const token = params.get("token");
    const next = params.get("next");
    // Only allow same-origin relative paths — reject "//host" and "/\host"
    // (browsers normalize backslash to slash, making it protocol-relative).
    const dest =
      next && next.startsWith("/") && !/^\/[/\\]/.test(next) ? next : "/app";

    if (!token) {
      setFailed(true);
      return;
    }
    try {
      localStorage.setItem("dr_token", token);
    } catch {
      setFailed(true);
      return;
    }
    window.location.replace(dest);
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        color: "var(--aurora-fg3)",
        fontSize: 14,
      }}
    >
      {failed ? (
        <span>
          Sign-in hand-off failed.{" "}
          <a href="/auth/login" style={{ color: "var(--aurora-accent)" }}>
            Log in
          </a>
        </span>
      ) : (
        <span>Signing you in…</span>
      )}
    </div>
  );
}
