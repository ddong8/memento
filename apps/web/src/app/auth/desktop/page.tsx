"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Glass } from "@/components/aurora/primitives";
import { api } from "@/lib/api-client";

/**
 * Desktop OAuth loopback bridge — the tail of the native GitHub sign-in flow.
 *
 * github.com sends `x-frame-options: deny`, so the desktop app can never run
 * the authorization inside its dashboard iframe. Instead it opens the system
 * browser (gh CLI / gcloud style) and listens on a one-shot 127.0.0.1 socket.
 * The server's OAuth callback lands on /auth/callback (which stores the JWT),
 * which forwards here with ?port=&nonce=. We trade the JWT for the user's
 * durable *collector token* — the desktop's real identity — and hand it to
 * the loopback listener. The desktop already knows how to turn a collector
 * token back into a web session (mint_web_token → /auth/handoff).
 *
 * Both `port` and `nonce` land in a URL we navigate to, so they are validated
 * strictly and the loopback host is hardcoded — never taken from the URL.
 */

/** 1..65535, digits only. */
function validPort(port: string): boolean {
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** Hex nonce minted by the Rust side. */
function validNonce(nonce: string): boolean {
  return /^[a-f0-9]{16,128}$/i.test(nonce);
}

export default function AuthDesktopPage() {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const port = params.get("port") ?? "";
    const nonce = params.get("nonce") ?? "";

    // Someone landed here without a live desktop flow (or with junk params):
    // fail loudly rather than spin forever.
    if (!validPort(port) || !validNonce(nonce)) {
      queueMicrotask(() => setFailed(true));
      return;
    }

    // /auth/callback just wrote this on its way here.
    let jwt: string | null = null;
    try {
      jwt = localStorage.getItem("dr_token");
    } catch {
      /* storage blocked — treated as missing below */
    }
    if (!jwt) {
      queueMicrotask(() => setFailed(true));
      return;
    }

    let cancelled = false;
    api
      .getMe(jwt)
      .then((me) => {
        if (cancelled) return;
        const collectorToken = me.collector_token;
        if (!collectorToken) {
          // Account exists but isn't active → no collector token to hand over.
          setFailed(true);
          return;
        }
        // Hand off to the desktop's loopback listener. Host is hardcoded.
        window.location.replace(
          `http://127.0.0.1:${port}/?token=${encodeURIComponent(collectorToken)}` +
            `&nonce=${encodeURIComponent(nonce)}`,
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
    // Mount-only: the query string and the stored JWT don't change under us,
    // and `t` is only read at render time (a locale switch must not re-run
    // the hand-off).
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
          {failed ? (
            <>
              {t.auth.desktopHandoffFailed}
              <br />
              <a
                href="/auth/login"
                style={{ color: "var(--aurora-accent)", marginTop: 8, display: "inline-block" }}
              >
                {t.auth.goToLogin}
              </a>
            </>
          ) : (
            t.auth.returningToApp
          )}
        </p>
      </Glass>
    </div>
  );
}
