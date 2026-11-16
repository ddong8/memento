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
              "radial-gradient(circle at 12% 14%, rgba(109, 40, 217, 0.15) 0%, transparent 50%)",
              "radial-gradient(circle at 88% 20%, rgba(79, 70, 229, 0.12) 0%, transparent 46%)",
              "radial-gradient(circle at 50% 90%, rgba(8, 145, 178, 0.11) 0%, transparent 54%)",
            ].join(", ")
          : [
              "radial-gradient(circle at 12% 14%, rgba(139, 92, 246, 0.10) 0%, transparent 50%)",
              "radial-gradient(circle at 88% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 46%)",
              "radial-gradient(circle at 50% 90%, rgba(56, 189, 248, 0.08) 0%, transparent 54%)",
            ].join(", "),
      }}
    />
  );
}

