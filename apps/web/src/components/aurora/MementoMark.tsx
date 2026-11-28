"use client";

import { useId, type CSSProperties } from "react";

/**
 * Memento official App Icon mark — matches apps/desktop/build/icon.png, apps/mobile/assets/icon.png,
 * and apps/web/public/favicon.svg (double four-point white sparkles on the Aurora rounded-square emblem).
 */
export function MementoMark({
  size = 32,
  radius,
  tone = "accent",
  style,
}: {
  size?: number;
  radius?: number;
  /** "accent" renders the official App Icon tile; "mono" renders bare sparkles in currentColor. */
  tone?: "accent" | "mono";
  style?: CSSProperties;
}) {
  const uid = useId();
  const gradId = `memento-icon-grad-${uid}`;

  if (tone === "mono") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0, display: "block", ...style }}
      >
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
        <path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7z" />
      </svg>
    );
  }

  const r = radius ?? Math.round(size * 0.26);
  const svgR = Math.round((r / size) * 64);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      style={{ flexShrink: 0, display: "block", ...style }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7C3AED" />
          <stop offset="55%" stopColor="#EC4899" />
          <stop offset="100%" stopColor="#06B6D4" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx={svgR} fill={`url(#${gradId})`} />
      <g
        transform="translate(14, 14) scale(1.5)"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
        <path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7z" />
      </g>
    </svg>
  );
}
