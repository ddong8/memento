import { useColorScheme } from "react-native";

/** Unified Aurora palette paired with the Memento App Icon, synced 1:1 with Web & Desktop (zero UI gradients). */
const light = {
  bg: "#F6F5FA",
  surface: "#FFFFFF",
  surfaceMute: "#EFEBF8",
  border: "rgba(24, 18, 42, 0.085)",
  borderStrong: "rgba(24, 18, 42, 0.14)",
  fg1: "#14121E",
  fg2: "#3A354B",
  fg3: "#625C75",
  fg4: "#746E88",
  accent: "#7C3AED",
  accentPrimary: "#7C3AED",
  accentSoft: "rgba(124, 58, 237, 0.10)",
  onAccent: "#FFFFFF",
  danger: "#DC2626",
  dangerSoft: "rgba(220, 38, 38, 0.09)",
  warn: "#B45309",
  warnSoft: "rgba(217, 119, 6, 0.10)",
  success: "#059669",
  successSoft: "rgba(5, 150, 105, 0.10)",
  code: "#F3F1F9",
};

const dark: typeof light = {
  bg: "#0B0A12",
  surface: "#15131F",
  surfaceMute: "#1B1827",
  border: "rgba(255, 255, 255, 0.10)",
  borderStrong: "rgba(255, 255, 255, 0.16)",
  fg1: "#F5F4FA",
  fg2: "#CBC7DB",
  fg3: "#9993AD",
  fg4: "#817B96",
  accent: "#A78BFA",
  accentPrimary: "#7C3AED",
  accentSoft: "rgba(167, 139, 250, 0.15)",
  onAccent: "#FFFFFF",
  danger: "#F87171",
  dangerSoft: "rgba(248, 113, 113, 0.14)",
  warn: "#FBBF24",
  warnSoft: "rgba(251, 191, 36, 0.14)",
  success: "#34D399",
  successSoft: "rgba(52, 211, 153, 0.14)",
  code: "#13111C",
};

export type Theme = typeof light & { scheme: "light" | "dark" };

export function useTheme(): Theme {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return { ...(scheme === "dark" ? dark : light), scheme };
}

export const radius = { card: 14, control: 10, chip: 8 };
