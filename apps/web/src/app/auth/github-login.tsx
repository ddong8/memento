"use client";

// Shared "Continue with GitHub" pieces for the login & register pages.
// Colocated under app/auth/ but not a route file (only page/layout/etc.
// special names create routes).

import { useEffect, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/lib/i18n";
import { Btn } from "@/components/aurora/primitives";
import { getApiBase } from "@/lib/api-client";

/** Inline GitHub mark — not part of the aurora Icon set. */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * Are we running inside the Memento desktop app's dashboard iframe?
 * Same detection auth-context.tsx uses for maybePostTokenToDesktop(): the
 * desktop loads the iframe with ?embed=memento once, which is stashed in
 * sessionStorage so it survives the login redirect chain (which strips the
 * query string).
 */
function isMementoEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).get("embed") === "memento") {
      sessionStorage.setItem("memento_embed", "1");
    }
    if (sessionStorage.getItem("memento_embed") !== "1") return false;
    return !!window.parent && window.parent !== window;
  } catch {
    return false;
  }
}

/** Divider + "Continue with GitHub" button (full-page redirect to the API). */
export function GithubLoginSection() {
  const { t } = useI18n();
  const [handedToDesktop, setHandedToDesktop] = useState(false);
  const handleGithub = () => {
    // Embedded in the desktop app: a redirect to github.com would die in the
    // iframe (github.com/login/oauth/authorize sends `x-frame-options: deny`).
    // Hand off to the parent instead — the desktop runs the OAuth flow in the
    // system browser and collects the result over a 127.0.0.1 loopback listener.
    if (isMementoEmbedded()) {
      // targetOrigin "*": the parent is the desktop's tauri:// custom protocol
      // whose origin we can't reliably know. The message carries no secret —
      // it's a bare "the user clicked GitHub" signal.
      window.parent.postMessage({ type: "memento:github-login" }, "*");
      setHandedToDesktop(true);
      return;
    }
    // Read ?next= at click time from window.location (event handler — the
    // idiom these pages use instead of useSearchParams, which would force
    // them out of Next 16's static prerender).
    const next = new URLSearchParams(window.location.search).get("next");
    window.location.href =
      `${getApiBase()}/api/auth/github/authorize` +
      (next ? `?next=${encodeURIComponent(next)}` : "");
  };
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0 14px" }}>
        <div style={{ flex: 1, height: 1, background: "var(--aurora-border)" }} />
        <span style={{ fontSize: 12, color: "var(--aurora-fg4)", letterSpacing: "-0.005em" }}>
          {t.auth.orContinueWith}
        </span>
        <div style={{ flex: 1, height: 1, background: "var(--aurora-border)" }} />
      </div>
      <Btn
        type="button"
        variant="glass"
        size="lg"
        style={{ width: "100%", justifyContent: "center", gap: 8 }}
        onClick={handleGithub}
        disabled={handedToDesktop}
      >
        <GithubMark size={16} />
        {handedToDesktop ? t.auth.continueInBrowser : t.auth.continueWithGithub}
      </Btn>
    </>
  );
}

const noopSubscribe = () => () => {};

/**
 * Map the OAuth callback's ?error= code to an i18n message ("" when absent).
 * Reads window.location instead of useSearchParams() to stay compatible with
 * Next 16's static prerender. useSyncExternalStore (server snapshot: "")
 * yields the client value right after hydration without a mismatch and
 * without setState-in-effect; the value never changes afterwards, so the
 * subscription is a no-op.
 */
export function useOauthErrorMessage(): string {
  const { t } = useI18n();
  const search = useSyncExternalStore(
    noopSubscribe,
    () => window.location.search,
    () => "",
  );
  const code = new URLSearchParams(search).get("error");
  if (!code) return "";
  const map: Record<string, string> = {
    github_oauth_failed: t.auth.githubOauthFailed,
    registration_closed: t.auth.registrationClosed,
    account_disabled: t.auth.accountDisabled,
  };
  return map[code] ?? t.auth.githubOauthFailed;
}

/** Whether the server has GitHub OAuth configured (public probe, no auth). */
export function useGithubEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    fetch(`${getApiBase()}/api/auth/registration-mode`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setEnabled(!!d?.github_enabled))
      .catch(() => {});
  }, []);
  return enabled;
}
