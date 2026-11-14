"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Aurora skin background: the plain page color. It used to carry four colored radial glows; those read as
 * the stock "AI product" look, so the page is a flat color like the other skins.
 */
export function AuroraBackdrop() {
  const { skin } = useTheme();
  if (skin !== "aurora") return null;

  return (
    <div
      aria-hidden
      data-app-backdrop
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
