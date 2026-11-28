import { useColorScheme } from "react-native";

/** Unified Studio palette synced 1:1 with Web & Desktop tokens (zero gradients). */
const light = {
  bg: "#F7F7F9",
  surface: "#FFFFFF",
  surfaceMute: "#EFEFF4",
  border: "rgba(17, 17, 24, 0.085)",
  borderStrong: "rgba(17, 17, 24, 0.145)",
  fg1: "#111118",
  fg2: "#343444",
  fg3: "#5B5B6E",
  fg4: "#6E6E82",
  accent: "#4F46E5",
  accentPrimary: "#4F46E5",
  accentSoft: "rgba(79, 70, 229, 0.09)",
  onAccent: "#FFFFFF",
  danger: "#DC2626",
  dangerSoft: "rgba(220, 38, 38, 0.09)",
  warn: "#B45309",
  warnSoft: "rgba(217, 119, 6, 0.10)",
  success: "#059669",
  successSoft: "rgba(5, 150, 105, 0.10)",
  code: "#F2F2F6",
};

const dark: typeof light = {
  bg: "#0B0C10",
  surface: "#14151C",
  surfaceMute: "#181922",
  border: "rgba(255, 255, 255, 0.085)",
  borderStrong: "rgba(255, 255, 255, 0.14)",
  fg1: "#F3F4F8",
  fg2: "#C8CBD8",
  fg3: "#989DB2",
  fg4: "#7E8399",
  accent: "#818CF8",
  accentPrimary: "#5B52F0",
  accentSoft: "rgba(129, 140, 248, 0.13)",
  onAccent: "#FFFFFF",
  danger: "#F87171",
  dangerSoft: "rgba(248, 113, 113, 0.14)",
  warn: "#FBBF24",
  warnSoft: "rgba(251, 191, 36, 0.14)",
  success: "#34D399",
  successSoft: "rgba(52, 211, 153, 0.14)",
  code: "#12131A",
};

export type Theme = typeof light & { scheme: "light" | "dark" };

export function useTheme(): Theme {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return { ...(scheme === "dark" ? dark : light), scheme };
}

export const radius = { card: 14, control: 10, chip: 8 };
