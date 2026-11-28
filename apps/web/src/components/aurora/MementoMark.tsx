"use client";

import type { CSSProperties } from "react";

/**
 * Memento unified geometric brand mark — architectural folded-memory "M" emblem.
 * Pure solid geometry (zero gradients) shared identically across Web, Desktop HTML, Mobile RN, and favicons.
 */
export function MementoMark({
  size = 32,
  radius,
  tone = "accent",
  style,
}: {
  size?: number;
  radius?: number;
  /** "accent" renders solid brand tile + white monogram; "mono" renders bare vector in currentColor. */
  tone?: "accent" | "mono";
  style?: CSSProperties;
}) {
  if (tone === "mono") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        style={{ flexShrink: 0, display: "block", ...style }}
      >
        <path
          d="M7 24V9.5C7 8.67 7.67 8 8.5 8H10.6C11.16 8 11.67 8.31 11.93 8.81L16 16.5L20.07 8.81C20.33 8.31 20.84 8 21.4 8H23.5C24.33 8 25 8.67 25 9.5V24"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="22.5" r="1.8" fill="currentColor" />
      </svg>
    );
  }

  const r = radius ?? Math.round(size * 0.28);
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: "var(--aurora-brand-grad)",
        color: "#FFFFFF",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...style,
      }}
    >
      <svg
        width={Math.round(size * 0.62)}
        height={Math.round(size * 0.62)}
        viewBox="0 0 32 32"
        fill="none"
        style={{ display: "block" }}
      >
        <path
          d="M6.5 24.5V9.2C6.5 8.54 7.04 8 7.7 8H10.3C10.82 8 11.29 8.29 11.53 8.75L16 17.2L20.47 8.75C20.71 8.29 21.18 8 21.7 8H24.3C24.96 8 25.5 8.54 25.5 9.2V24.5"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="16" cy="23.2" r="2" fill="currentColor" />
      </svg>
    </span>
  );
}
