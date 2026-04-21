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
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [skin, setSkinState] = useState<Skin>("aurora");

  useEffect(() => {
    const savedTheme = (typeof window !== "undefined" && localStorage.getItem("dr_theme")) as Theme | null;
    const savedSkin = (typeof window !== "undefined" && localStorage.getItem("dr_skin")) as Skin | null;
    const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    const initialTheme: Theme = savedTheme ?? (prefersDark ? "dark" : "light");
    const initialSkin: Skin = savedSkin && SKINS.includes(savedSkin) ? savedSkin : "aurora";
    setThemeState(initialTheme);
    setSkinState(initialSkin);
    applyAttrs(initialSkin, initialTheme);
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyAttrs(skin, t);
    try { localStorage.setItem("dr_theme", t); } catch {}
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
