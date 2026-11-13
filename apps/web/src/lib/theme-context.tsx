"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
export type Skin = "aurora" | "arc" | "baseline";

interface ThemeCtx {
  theme: Theme;
  skin: Skin;
  setTheme: (t: Theme) => void;
  setSkin: (s: Skin) => void;
  toggleTheme: () => void;
}

const Ctx = createContext<ThemeCtx>({
  theme: "light",
  skin: "aurora",
  setTheme: () => {},
  setSkin: () => {},
  toggleTheme: () => {},
});

const SKINS: Skin[] = ["aurora", "arc", "baseline"];

function applyAttrs(skin: Skin, theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-skin", skin);
  document.documentElement.setAttribute("data-theme", theme);
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

  // Sync theme-color and native shell status bar
  const isDark = theme === "dark";
  const headerBg = isDark ? "#15151F" : "#FFFFFF";

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = headerBg;

  // The desktop app: what the system draws (title bar on Windows, scroll bars, menus) in the same light/dark
  const dt = (window as unknown as { mementoDesktop?: { setTheme?: (t: string) => Promise<unknown> } }).mementoDesktop;
  // Not chosen in the app: "system", so the page keeps seeing the system's changes (Electron's
  // prefers-color-scheme follows nativeTheme.themeSource)
  let chosen: string | null = null;
  try { chosen = localStorage.getItem("dr_theme"); } catch {}
  void dt?.setTheme?.(chosen === "light" || chosen === "dark" ? theme : "system")?.catch?.(() => {});

  const bridge = (window as unknown as { ReactNativeWebView?: { postMessage: (msg: string) => void } }).ReactNativeWebView;
  if (bridge?.postMessage) {
    try {
      bridge.postMessage(JSON.stringify({ type: "theme", bg: headerBg, dark: isDark }));
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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const [skin, setSkinState] = useState<Skin>(readInitialSkin);

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

  // Sync <html data-*> attrs + favicon link on mount and whenever theme/skin change.
  useEffect(() => {
    applyAttrs(skin, theme);
    const onActive = () => applyAttrs(skin, theme);
    window.addEventListener("focus", onActive);
    window.addEventListener("memento_app_active", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      window.removeEventListener("memento_app_active", onActive);
    };
  }, [skin, theme]);

  const setTheme = (t: Theme) => {
    try { localStorage.setItem("dr_theme", t); } catch {}
    setThemeState(t);
    applyAttrs(skin, t);
  };

  const setSkin = (s: Skin) => {
    setSkinState(s);
    applyAttrs(s, theme);
    try { localStorage.setItem("dr_skin", s); } catch {}
  };

  return (
    <Ctx.Provider
      value={{
        theme, skin,
        setTheme, setSkin,
        toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
