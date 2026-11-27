"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
export type Skin = "aurora" | "arc" | "baseline";

interface ThemeCtx {
  theme: Theme;
  skin: Skin;
  glass: boolean;
  setTheme: (t: Theme) => void;
  setSkin: (s: Skin) => void;
  setGlass: (on: boolean) => void;
  toggleTheme: () => void;
}

const Ctx = createContext<ThemeCtx>({
  theme: "light",
  skin: "aurora",
  glass: true,
  setTheme: () => {},
  setSkin: () => {},
  setGlass: () => {},
  toggleTheme: () => {},
});

const SKINS: Skin[] = ["aurora", "arc", "baseline"];

const SKIN_CHROME: Record<
  Skin,
  Record<Theme, { surface: string; pageBg: string; border: string; accent: string; accentSoft: string; fg: string }>
> = {
  aurora: {
    light: { surface: "#FFFFFF", pageBg: "#FAFAFC", border: "rgba(15, 15, 30, 0.11)", accent: "#6D28D9", accentSoft: "rgba(109, 40, 217, 0.10)", fg: "#3A3A48" },
    dark: { surface: "#15151F", pageBg: "#0A0A12", border: "rgba(255, 255, 255, 0.12)", accent: "#A78BFA", accentSoft: "rgba(167, 139, 250, 0.16)", fg: "#C5C5D2" },
  },
  arc: {
    light: { surface: "#FFFFFF", pageBg: "#FAFAF7", border: "rgba(0, 0, 0, 0.13)", accent: "#C2410C", accentSoft: "rgba(194, 65, 12, 0.10)", fg: "#3A3A38" },
    dark: { surface: "#141413", pageBg: "#0B0B0A", border: "rgba(255, 255, 255, 0.13)", accent: "#F97316", accentSoft: "rgba(249, 115, 22, 0.16)", fg: "#C8C8C3" },
  },
  baseline: {
    light: { surface: "#FFFFFF", pageBg: "#F9FAFB", border: "#D1D5DB", accent: "#2563EB", accentSoft: "rgba(37, 99, 235, 0.12)", fg: "#374151" },
    dark: { surface: "#1E293B", pageBg: "#0F172A", border: "#475569", accent: "#3B82F6", accentSoft: "rgba(59, 130, 246, 0.18)", fg: "#CBD5E1" },
  },
};

function applyAttrs(skin: Skin, theme: Theme, glass: boolean) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-skin", skin);
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-glass", glass ? "on" : "off");
  // Swap favicon to match skin
  const href = `/favicon-${skin}.svg`;
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon'][data-skin-icon]");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.setAttribute("data-skin-icon", "1");
    document.head.appendChild(link);
  }
  if (link.href !== location.origin + href) link.href = href;

  // Sync theme-color and native shell status bar + bottom tab bar with the exact active skin tokens
  const isDark = theme === "dark";
  const fallback = SKIN_CHROME[skin]?.[theme] ?? SKIN_CHROME.aurora[theme];
  const cs = typeof window !== "undefined" ? window.getComputedStyle(document.documentElement) : null;
  const pickVar = (name: string, fb: string) => cs?.getPropertyValue(name)?.trim() || fb;
  const surface = pickVar("--aurora-surface-solid", fallback.surface);
  const pageBg = pickVar("--aurora-bg", fallback.pageBg);
  const border = pickVar("--aurora-border-strong", fallback.border);
  const accent = pickVar("--aurora-accent", fallback.accent);
  const accentSoft = pickVar("--aurora-accent-soft", fallback.accentSoft);
  const fg = pickVar("--aurora-fg2", fallback.fg);

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = surface;

  // The desktop app: what the system draws (title bar on Windows, macOS vibrancy, scroll bars, menus)
  const dt = (window as unknown as {
    mementoDesktop?: {
      nativeGlass?: boolean;
      setTheme?: (t: string) => Promise<unknown>;
      setGlass?: (on: boolean) => Promise<unknown>;
    };
  }).mementoDesktop;
  document.documentElement.setAttribute("data-native-glass", dt?.nativeGlass ? "1" : "0");
  // Not chosen in the app: "system", so the page keeps seeing the system's changes (Electron's
  // prefers-color-scheme follows nativeTheme.themeSource)
  let chosen: string | null = null;
  try { chosen = localStorage.getItem("dr_theme"); } catch {}
  void dt?.setTheme?.(chosen === "light" || chosen === "dark" ? theme : "system")?.catch?.(() => {});
  void dt?.setGlass?.(glass)?.catch?.(() => {});

  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage: (msg: string) => void } }).ReactNativeWebView;
  if (bridge?.postMessage) {
    try {
      bridge.postMessage(
        JSON.stringify({
          type: "theme",
          bg: surface,
          pageBg,
          surface,
          border,
          accent,
          accentSoft,
          fg,
          dark: isDark,
          glass,
        }),
      );
    } catch {}
  }
}

function readInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("dr_theme") as Theme | null;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readInitialSkin(): Skin {
  if (typeof window === "undefined") return "aurora";
  const saved = localStorage.getItem("dr_skin") as Skin | null;
  return saved && SKINS.includes(saved) ? saved : "aurora";
}

function readInitialGlass(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem("dr_glass") !== "off";
  } catch {
    return true;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const [skin, setSkinState] = useState<Skin>(readInitialSkin);
  const [glass, setGlassState] = useState<boolean>(readInitialGlass);

  // Not chosen in the app: follow the system's light/dark as it changes, like a native app does
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      let saved: string | null = null;
      try { saved = localStorage.getItem("dr_theme"); } catch {}
      if (saved === "light" || saved === "dark") return;
      setThemeState(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Sync <html data-*> attrs + favicon link on mount and whenever theme/skin/glass change.
  useEffect(() => {
    applyAttrs(skin, theme, glass);
    const onActive = () => applyAttrs(skin, theme, glass);
    window.addEventListener("focus", onActive);
    window.addEventListener("memento_app_active", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      window.removeEventListener("memento_app_active", onActive);
    };
  }, [skin, theme, glass]);

  const setTheme = (t: Theme) => {
    try { localStorage.setItem("dr_theme", t); } catch {}
    setThemeState(t);
    applyAttrs(skin, t, glass);
  };

  const setSkin = (s: Skin) => {
    setSkinState(s);
    applyAttrs(s, theme, glass);
    try { localStorage.setItem("dr_skin", s); } catch {}
  };

  const setGlass = (on: boolean) => {
    setGlassState(on);
    try { localStorage.setItem("dr_glass", on ? "on" : "off"); } catch {}
    applyAttrs(skin, theme, on);
  };

  return (
    <Ctx.Provider
      value={{
        theme, skin, glass,
        setTheme, setSkin, setGlass,
        toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
