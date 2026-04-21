"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, UserInfo } from "./api-client";

interface AuthState {
  user: UserInfo | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<UserInfo>;
  logout: () => void;
  refreshMe: () => Promise<UserInfo | null>;
  setUser: (u: UserInfo | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

/** Routes that don't require authentication — landing and auth pages. */
const PUBLIC_PATHS = ["/", "/auth/login", "/auth/register"];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const stored = localStorage.getItem("dr_token");
    if (stored) {
      setToken(stored);
      api.getMe(stored).then(setUser).catch(() => {
        localStorage.removeItem("dr_token");
        setToken(null);
      }).finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Redirect to login if not authenticated and not on a public page
  useEffect(() => {
    if (!loading && !token && !PUBLIC_PATHS.includes(pathname)) {
      router.replace("/auth/login");
    }
  }, [loading, token, pathname, router]);

  const login = async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.access_token);
    localStorage.setItem("dr_token", res.access_token);
    const me = await api.getMe(res.access_token);
    setUser(me);
  };

  const register = async (email: string, password: string, name?: string) => {
    return await api.register(email, password, name);
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
