import { useColorScheme } from "react-native";

/** The Aurora palette of the web app, for both schemes. */
const light = {
  bg: "#F6F5FB",
  surface: "#FFFFFF",
  surfaceMute: "#F1EFF7",
  border: "rgba(22,19,31,0.08)",
  borderStrong: "rgba(22,19,31,0.16)",
  fg1: "#16131F",
  fg2: "#3E3A4D",
  fg3: "#6E6A7C",
  fg4: "#9C98A8",
  accent: "#7C3AED",
  accentSoft: "rgba(124,58,237,0.10)",
  onAccent: "#FFFFFF",
  danger: "#DC2626",
  dangerSoft: "rgba(220,38,38,0.08)",
  warn: "#B45309",
  warnSoft: "rgba(217,119,6,0.10)",
  success: "#059669",
  successSoft: "rgba(16,185,129,0.12)",
  code: "#F1EFF7",
};

const dark: typeof light = {
  bg: "#0B0B12",
  surface: "#15141D",
  surfaceMute: "#1C1B26",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.16)",
  fg1: "#F2F0FA",
  fg2: "#CFCBDD",
  fg3: "#9A96AB",
  fg4: "#6E6A80",
  accent: "#A78BFA",
  accentSoft: "rgba(167,139,250,0.14)",
  onAccent: "#0B0B12",
  danger: "#F87171",
  dangerSoft: "rgba(248,113,113,0.12)",
  warn: "#FBBF24",
  warnSoft: "rgba(251,191,36,0.12)",
  success: "#34D399",
  successSoft: "rgba(52,211,153,0.14)",
  code: "#1C1B26",
};

export type Theme = typeof light & { scheme: "light" | "dark" };

export function useTheme(): Theme {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return { ...(scheme === "dark" ? dark : light), scheme };
}

export const radius = { card: 16, control: 10, chip: 8 };
