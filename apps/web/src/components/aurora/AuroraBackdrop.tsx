"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Aurora skin background: static multi-origin radial gradient aura.
 * Renders in a single composited layer with zero Gaussian blur filters,
 * zero SVG feTurbulence shaders, and zero infinite keyframe animations
 * so mobile and desktop GPUs stay completely idle (0% GPU usage at rest).
 */
export function AuroraBackdrop() {
  const { skin, theme } = useTheme();
  if (skin !== "aurora") return null;

  const dark = theme === "dark";

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: -2,
        backgroundColor: "var(--aurora-bg)",
        backgroundImage: dark
          ? [
              "radial-gradient(circle at 14% 16%, rgba(124, 58, 237, 0.18) 0%, transparent 52%)",
              "radial-gradient(circle at 86% 24%, rgba(236, 72, 153, 0.14) 0%, transparent 48%)",
              "radial-gradient(circle at 48% 88%, rgba(6, 182, 212, 0.14) 0%, transparent 56%)",
            ].join(", ")
          : [
              "radial-gradient(circle at 14% 16%, rgba(167, 139, 250, 0.15) 0%, transparent 52%)",
              "radial-gradient(circle at 86% 24%, rgba(244, 114, 182, 0.13) 0%, transparent 48%)",
              "radial-gradient(circle at 48% 88%, rgba(103, 232, 249, 0.13) 0%, transparent 56%)",
            ].join(", "),
      }}
    />
  );
}

