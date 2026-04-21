"use client";

import { useTheme } from "@/lib/theme-context";

/**
 * Aurora skin background: 4 independent floating gradient blobs
 * (violet / pink / cyan / amber) + subtle fractal-noise grain.
 * Null unless skin="aurora".
 */
export function AuroraBackdrop() {
  const { skin, theme } = useTheme();
  if (skin !== "aurora") return null;

  const dark = theme === "dark";

  return (
    <>
      <div
        aria-hidden
        style={{
          position: "fixed", inset: 0, pointerEvents: "none",
          zIndex: -2, background: "var(--aurora-bg)",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "fixed", inset: 0, pointerEvents: "none",
          zIndex: -1, overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute", top: "-12%", left: "-12%",
            width: "62%", height: "62%",
            background: "radial-gradient(closest-side, var(--aurora-glow1), transparent 70%)",
            opacity: dark ? 0.44 : 0.55,
            filter: "blur(44px)",
            animation: "aurFloat1 26s cubic-bezier(.45,.05,.55,.95) infinite",
            willChange: "transform",
          }}
        />
        <div
          style={{
            position: "absolute", top: "8%", right: "-18%",
            width: "58%", height: "58%",
            background: "radial-gradient(closest-side, var(--aurora-glow2), transparent 70%)",
            opacity: dark ? 0.38 : 0.5,
            filter: "blur(56px)",
            animation: "aurFloat2 32s cubic-bezier(.45,.05,.55,.95) infinite",
            willChange: "transform",
          }}
        />
        <div
          style={{
            position: "absolute", bottom: "-22%", left: "18%",
            width: "72%", height: "68%",
            background: "radial-gradient(closest-side, var(--aurora-glow3), transparent 70%)",
            opacity: dark ? 0.36 : 0.48,
            filter: "blur(64px)",
            animation: "aurFloat3 38s cubic-bezier(.45,.05,.55,.95) infinite",
            willChange: "transform",
          }}
        />
        <div
          style={{
            position: "absolute", top: "30%", left: "35%",
            width: "40%", height: "40%",
            background: "radial-gradient(closest-side, var(--aurora-glow4), transparent 70%)",
            opacity: dark ? 0.28 : 0.38,
            filter: "blur(52px)",
            animation: "aurFloat4 24s ease-in-out infinite",
            willChange: "transform, opacity",
          }}
        />
        <div
          style={{
            position: "absolute", inset: 0,
            opacity: dark ? 0.22 : 0.32,
            mixBlendMode: "overlay",
            backgroundImage:
              "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.35 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
          }}
        />
      </div>
    </>
  );
}
