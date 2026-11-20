"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Aurora skin background: static multi-origin radial gradient aura.
 * Renders in a single composited layer with zero Gaussian blur filters,
 * zero SVG feTurbulence shaders, and zero infinite keyframe animations
 * so mobile and desktop GPUs stay completely idle (0% GPU usage at rest).
 */
export function AuroraBackdrop() {
  const { skin } = useTheme();
  if (skin !== "aurora") return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: -2,
        backgroundColor: "var(--aurora-bg)",
      }}
    />
  );
}

