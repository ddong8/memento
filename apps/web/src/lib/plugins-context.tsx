"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { authFetch, getApiBase } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";

async function pluginRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const base = getApiBase().replace(/\/+$/, "");
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await authFetch(`${base}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const err = await res.json();
      if (err && typeof err.detail === "string") msg = err.detail;
    } catch {}
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export interface PluginFieldSpec {
  key: string;
  label: string;
  type: "url" | "text" | "secret" | "boolean";
  required?: boolean;
  placeholder?: string;
  help?: string;
  server_capability?: string;
}

export interface PluginItem {
  id: string;
  name: string;
  version: string;
  category: string;
  icon: string;
  entry_route: string;
  summary: string;
  highlights: string[];
  fields: PluginFieldSpec[];
  installed: boolean;
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  installed_at?: string | null;
  updated_at?: string | null;
  config: Record<string, unknown>;
}

export interface PluginsResponse {
  plugins: PluginItem[];
  server_capabilities: Record<string, boolean>;
}

export interface PluginTestResult {
  ok: boolean;
  latency_ms: number;
  message: string;
}

interface PluginContextValue {
  plugins: PluginItem[];
  serverCapabilities: Record<string, boolean>;
  loading: boolean;
  loaded: boolean;
  isPluginReady: (pluginId: string) => boolean;
  getPlugin: (pluginId: string) => PluginItem | undefined;
  refreshPlugins: () => Promise<void>;
  installPlugin: (pluginId: string, config?: Record<string, unknown>, enabled?: boolean) => Promise<PluginsResponse>;
  savePluginConfig: (
    pluginId: string,
    payload: { config?: Record<string, unknown>; enabled?: boolean }
  ) => Promise<PluginsResponse>;
  testPlugin: (pluginId: string, config?: Record<string, unknown>) => Promise<PluginTestResult>;
  uninstallPlugin: (pluginId: string) => Promise<PluginsResponse>;
}

const CACHE_KEY = "memento_plugins_cache_v1";

function readCached(): PluginsResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PluginsResponse;
    if (parsed && Array.isArray(parsed.plugins)) return parsed;
  } catch {}
  return null;
}

function writeCached(data: PluginsResponse): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {}
}

function clearCached(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

const DEFAULT_VALUE: PluginContextValue = {
  plugins: [],
  serverCapabilities: {},
  loading: false,
  loaded: false,
  isPluginReady: () => false,
  getPlugin: () => undefined,
  refreshPlugins: async () => {},
  installPlugin: async () => ({ plugins: [], server_capabilities: {} }),
  savePluginConfig: async () => ({ plugins: [], server_capabilities: {} }),
  testPlugin: async () => ({ ok: false, latency_ms: 0, message: "" }),
  uninstallPlugin: async () => ({ plugins: [], server_capabilities: {} }),
};

const PluginContext = createContext<PluginContextValue>(DEFAULT_VALUE);

export function PluginProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth();
  const [plugins, setPlugins] = useState<PluginItem[]>(() => readCached()?.plugins ?? []);
  const [serverCapabilities, setServerCapabilities] = useState<Record<string, boolean>>(
    () => readCached()?.server_capabilities ?? {}
  );
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(() => Boolean(readCached()));

  const applyPayload = useCallback((res: PluginsResponse) => {
    const next: PluginsResponse = {
      plugins: Array.isArray(res.plugins) ? res.plugins : [],
      server_capabilities: res.server_capabilities || {},
    };
    setPlugins(next.plugins);
    setServerCapabilities(next.server_capabilities);
    setLoaded(true);
    writeCached(next);
    return next;
  }, []);

  const inflightRef = useRef<Promise<void> | null>(null);
  const lastFetchedAuthKeyRef = useRef<string | null>(null);

  const refreshPlugins = useCallback(async () => {
    if (!token && !user) return;
    if (inflightRef.current) return inflightRef.current;
    setLoading(true);
    const run = (async () => {
      try {
        const res = await pluginRequest<PluginsResponse>("/api/plugins");
        applyPayload(res);
      } catch {
        setLoaded(true);
      } finally {
        inflightRef.current = null;
        setLoading(false);
      }
    })();
    inflightRef.current = run;
    return run;
  }, [token, user, applyPayload]);

  useEffect(() => {
    if (!user && !token) {
      lastFetchedAuthKeyRef.current = null;
      setPlugins([]);
      setServerCapabilities({});
      setLoaded(false);
      clearCached();
      return;
    }
    // Avoid firing a duplicate /api/plugins request when `user` resolves right after lazy `token` mount
    const authKey = user?.id ? `user:${user.id}` : "authed";
    if (lastFetchedAuthKeyRef.current && (lastFetchedAuthKeyRef.current === authKey || lastFetchedAuthKeyRef.current === "authed")) {
      lastFetchedAuthKeyRef.current = authKey;
      return;
    }
    lastFetchedAuthKeyRef.current = authKey;
    void refreshPlugins();
  }, [user?.id, token, refreshPlugins]);

  const installPlugin = useCallback(
    async (pluginId: string, config: Record<string, unknown> = {}, enabled = true) => {
      const res = await pluginRequest<PluginsResponse>(`/api/plugins/${encodeURIComponent(pluginId)}/install`, {
        method: "POST",
        body: JSON.stringify({ config, enabled }),
      });
      return applyPayload(res);
    },
    [applyPayload]
  );

  const savePluginConfig = useCallback(
    async (pluginId: string, payload: { config?: Record<string, unknown>; enabled?: boolean }) => {
      const res = await pluginRequest<PluginsResponse>(`/api/plugins/${encodeURIComponent(pluginId)}/config`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      return applyPayload(res);
    },
    [applyPayload]
  );

  const testPlugin = useCallback(
    async (pluginId: string, config?: Record<string, unknown>) => {
      return pluginRequest<PluginTestResult>(`/api/plugins/${encodeURIComponent(pluginId)}/test`, {
        method: "POST",
        body: JSON.stringify({ config: config ?? null }),
      });
    },
    []
  );

  const uninstallPlugin = useCallback(
    async (pluginId: string) => {
      const res = await pluginRequest<PluginsResponse>(`/api/plugins/${encodeURIComponent(pluginId)}`, {
        method: "DELETE",
      });
      return applyPayload(res);
    },
    [applyPayload]
  );

  const pluginMap = useMemo(() => {
    const m = new Map<string, PluginItem>();
    for (const p of plugins) m.set(p.id, p);
    return m;
  }, [plugins]);

  const isPluginReady = useCallback(
    (pluginId: string) => Boolean(pluginMap.get(pluginId)?.ready),
    [pluginMap]
  );

  const getPlugin = useCallback(
    (pluginId: string) => pluginMap.get(pluginId),
    [pluginMap]
  );

  const value = useMemo<PluginContextValue>(
    () => ({
      plugins,
      serverCapabilities,
      loading,
      loaded,
      isPluginReady,
      getPlugin,
      refreshPlugins,
      installPlugin,
      savePluginConfig,
      testPlugin,
      uninstallPlugin,
    }),
    [
      plugins,
      serverCapabilities,
      loading,
      loaded,
      isPluginReady,
      getPlugin,
      refreshPlugins,
      installPlugin,
      savePluginConfig,
      testPlugin,
      uninstallPlugin,
    ]
  );

  return <PluginContext.Provider value={value}>{children}</PluginContext.Provider>;
}

export function usePlugins(): PluginContextValue {
  return useContext(PluginContext);
}
