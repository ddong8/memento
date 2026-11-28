"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Restrained macOS-style atmospheric ambient canvas harmonized with the Memento App Icon
 * (violet #7C3AED, soft rose #EC4899, whisper cyan #06B6D4).
 *
 * Static diffused light fields (zero continuous keyframe animation / zero GPU drain) give
 * frosted glass cards, sidebars, and headers genuine macOS translucency and depth to refract.
 * Hidden automatically in Arc/Baseline skins or when the user disables frosted glass.
 */
export function AuroraBackdrop() {
  const { skin, theme, glass } = useTheme();
  if (skin !== "aurora" || !glass) return null;

  const isDark = theme === "dark";

  return (
    <div
      aria-hidden="true"
      className="memento-aurora-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      {/* Primary soft violet crown matching the App Icon's upper-left anchor */}
      <div
        style={{
          position: "absolute",
          top: "-18%",
          left: "-8%",
          width: "58vw",
          height: "58vw",
          maxWidth: 820,
          maxHeight: 820,
          borderRadius: "50%",
          background: "#7C3AED",
          opacity: isDark ? 0.16 : 0.085,
          filter: "blur(130px)",
          transform: "translateZ(0)",
        }}
      />
      {/* Delicate magenta-rose warmth matching the App Icon's center sweep */}
      <div
        style={{
          position: "absolute",
          top: "12%",
          right: "-10%",
          width: "48vw",
          height: "48vw",
          maxWidth: 700,
          maxHeight: 700,
          borderRadius: "50%",
          background: "#EC4899",
          opacity: isDark ? 0.11 : 0.06,
          filter: "blur(140px)",
          transform: "translateZ(0)",
        }}
      />
      {/* Whisper-soft cyan counter-balance matching the App Icon's lower-right corner */}
      <div
        style={{
          position: "absolute",
          bottom: "-20%",
          left: "28%",
          width: "52vw",
          height: "52vw",
          maxWidth: 760,
          maxHeight: 760,
          borderRadius: "50%",
          background: "#06B6D4",
          opacity: isDark ? 0.10 : 0.055,
          filter: "blur(145px)",
          transform: "translateZ(0)",
        }}
      />
    </div>
  );
}
