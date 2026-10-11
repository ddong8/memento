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
              "radial-gradient(circle at 14% 16%, rgba(124, 58, 237, 0.22) 0%, transparent 52%)",
              "radial-gradient(circle at 86% 24%, rgba(219, 39, 119, 0.17) 0%, transparent 48%)",
              "radial-gradient(circle at 48% 88%, rgba(8, 145, 178, 0.18) 0%, transparent 56%)",
              "radial-gradient(circle at 52% 46%, rgba(245, 158, 11, 0.10) 0%, transparent 42%)",
            ].join(", ")
          : [
              "radial-gradient(circle at 14% 16%, rgba(167, 139, 250, 0.18) 0%, transparent 52%)",
              "radial-gradient(circle at 86% 24%, rgba(251, 165, 201, 0.16) 0%, transparent 48%)",
              "radial-gradient(circle at 48% 88%, rgba(125, 211, 252, 0.16) 0%, transparent 56%)",
              "radial-gradient(circle at 52% 46%, rgba(253, 230, 138, 0.12) 0%, transparent 42%)",
            ].join(", "),
      }}
    />
  );
}

