"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, UserInfo } from "./api-client";

interface AuthState {
  user: UserInfo | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string, inviteCode?: string) => Promise<UserInfo>;
  logout: () => void;
  refreshMe: () => Promise<UserInfo | null>;
  setUser: (u: UserInfo | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Routes that don't require authentication — landing and auth pages. */
const PUBLIC_PATHS = ["/", "/auth/login", "/auth/register", "/auth/handoff"];

/// Post the user's collector token to the parent window (the Memento
/// desktop app) so it can configure + start the collector daemon. Only
/// fires when we know we're embedded by the desktop client: the URL
/// carries `?embed=memento` on first arrival, persisted via
/// sessionStorage so it survives the login redirect chain.
function maybePostTokenToDesktop(collectorToken: string | null | undefined) {
  if (typeof window === "undefined" || !collectorToken) return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("embed") === "memento") {
      sessionStorage.setItem("memento_embed", "1");
    }
    if (sessionStorage.getItem("memento_embed") !== "1") return;
    if (window.parent && window.parent !== window) {
      // targetOrigin "*": the parent is the desktop's tauri:// custom
      // protocol whose origin we can't reliably know — token also lives
      // in this iframe's localStorage so this hand-off doesn't widen
      // exposure beyond what the iframe itself already has.
      window.parent.postMessage(
        { type: "memento:token", collector_token: collectorToken },
        "*",
      );
    }
  } catch {
    /* sessionStorage / postMessage unavailable — silent */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  // Lazy-init token from localStorage — avoids setState-in-effect rule and
  // also means first render already has the token (no flash of logged-out UI).
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("dr_token");
  });
  const [loading, setLoading] = useState<boolean>(() => {
    // If we start with no token, no /me fetch needed → not loading.
    if (typeof window === "undefined") return true;
    return !!localStorage.getItem("dr_token");
  });
  const pathname = usePathname();
  const router = useRouter();

  // Sticky embed marker: the desktop loads the iframe with ?embed=memento
  // on the first request, but AuthProvider's redirect to /auth/login
  // strips query params. Stash it in sessionStorage on mount so login /
  // register success can still tell whether to post the token back.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("embed") === "memento") {
      try { sessionStorage.setItem("memento_embed", "1"); } catch { /* noop */ }
    }
  }, []);

  useEffect(() => {
    // Only fetch /me if we have a token carried over from a previous session.
    if (!token) {
      setLoading(false);
      return;
    }
    api.getMe(token)
      .then((me) => {
        setUser(me);
        // Sliding window: ask the server for a fresh JWT on every app
        // mount. With the default 30-day expiry, any user who opens the
        // app at least once a month stays logged in forever. Best-effort
        // — a stale token still gets caught by the /me 401 path above.
        api.refreshToken(token)
          .then((res) => {
            if (res.access_token && res.access_token !== token) {
              localStorage.setItem("dr_token", res.access_token);
              setToken(res.access_token);
            }
          })
          .catch(() => { /* keep the original token; /me already validated it */ });
      })
      .catch(() => {
        localStorage.removeItem("dr_token");
        setToken(null);
      })
      .finally(() => setLoading(false));
    // Intentionally run only on mount — token is a lazy-init snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic refresh while the tab stays open. Keeps long-running web
  // sessions (Memento dashboard left open across days) from hitting the
  // 30-day wall. 12 h cadence — well under the expiry window but rare
  // enough that it costs essentially nothing.
  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => {
      api.refreshToken(token)
        .then((res) => {
          if (res.access_token && res.access_token !== token) {
            localStorage.setItem("dr_token", res.access_token);
            setToken(res.access_token);
          }
        })
        .catch(() => { /* network blip — try again next tick */ });
    }, 12 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [token]);

  // Redirect to login if not authenticated and not on a public page.
  // /s/<token> is a share URL — recipient has no account, must stay public.
  useEffect(() => {
    const isSharePrefix = pathname.startsWith("/s/") || pathname === "/s";
    if (!loading && !token && !PUBLIC_PATHS.includes(pathname) && !isSharePrefix) {
      router.replace("/auth/login");
    }
  }, [loading, token, pathname, router]);

  const login = async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.access_token);
    localStorage.setItem("dr_token", res.access_token);
    const me = await api.getMe(res.access_token);
    setUser(me);
    // Desktop hand-off: when the web is loaded inside the Memento
    // desktop client's dashboard iframe, mark sessionStorage on first
    // visit (?embed=memento) and on every login success post the
    // collector token back to the parent window so the desktop can
    // configure + start the collector daemon.
    maybePostTokenToDesktop(me.collector_token);
  };

  const register = async (email: string, password: string, name?: string, inviteCode?: string) => {
    return await api.register(email, password, name, inviteCode);
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem("dr_token");
    router.replace("/auth/login");
  };

  const refreshMe = async () => {
    if (!token) return null;
    try {
      const me = await api.getMe(token);
      setUser(me);
      return me;
    } catch {
      return null;
    }
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout, refreshMe, setUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
