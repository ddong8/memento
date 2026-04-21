/**
 * Brand marks for each tool — reconstructed from public logo geometry.
 * Rendered in 24x24 viewBox. Either:
 *   - colored=true  → brand color
 *   - inverted=true → white (for dark gradient tiles)
 *   - default       → currentColor monochrome
 */
import type { CSSProperties } from "react";

export const BRAND_COLORS: Record<string, string> = {
  claude_code: "#D97757",
  codex:       "#10A37F",
  obsidian:    "#7C3AED",
  cursor:      "#0F0F0F",
  windsurf:    "#0FB68A",
  vscode:      "#2B7CD3",
  antigravity: "#4F46E5",
  openclaw:    "#7C3AED",
  notes:       "#F59E0B",
};

type BrandId = keyof typeof BRAND_COLORS;

const BRAND_PATHS: Record<BrandId, (fill: string) => React.ReactElement> = {
  claude_code: (fill) => (
    <path
      fill={fill}
      d="M12 2.4c.5 2.6 1.5 4.8 3.1 6.4 1.6 1.6 3.8 2.6 6.5 3.1-2.7.5-4.9 1.5-6.5 3.1-1.6 1.6-2.6 3.8-3.1 6.5-.5-2.7-1.5-4.9-3.1-6.5C7.3 13.4 5.1 12.4 2.4 12c2.7-.5 4.9-1.5 6.5-3.1 1.6-1.6 2.6-3.8 3.1-6.5z"
    />
  ),
  codex: (fill) => (
    <g fill="none" stroke={fill} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" />
      <path d="M12 3.2v8.8M12 12l7.6 4.4M12 12l-7.6 4.4" />
    </g>
  ),
  obsidian: (fill) => (
    <g fill={fill}>
      <path
        d="M12 2.2 3.4 8.6l3.1 11.2h11l3.1-11.2L12 2.2zm0 2.7 5.9 4.4-3 8.8h-5.8l-3-8.8L12 4.9z"
        opacity="0.9"
      />
      <path d="m12 4.9 5.9 4.4-3 8.8h-2.9V4.9z" opacity="0.6" />
    </g>
  ),
  cursor: (fill) => (
    <g fill={fill}>
      <path d="M4.5 3.2 20.8 12 12 15.2 8.7 21 4.5 3.2z" opacity="0.95" />
      <path d="M4.5 3.2 12 15.2 8.7 21 4.5 3.2z" opacity="0.55" />
    </g>
  ),
  windsurf: (fill) => (
    <g fill="none" stroke={fill} strokeWidth="2" strokeLinecap="round">
      <path d="M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
      <path d="M3 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
      <path d="M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0" />
    </g>
  ),
  vscode: (fill) => (
    <g fill={fill}>
      <path d="M17.5 3.1c.4-.2.9-.2 1.2.1l2.7 2.5c.4.4.4 1 0 1.4L14.4 14l7 6.9c.4.4.4 1 0 1.4l-2.7 2.5c-.4.3-.9.3-1.2.1L4.1 16l-1.7 1.3c-.4.3-1 .2-1.3-.2L.5 16c-.3-.4-.2-.9.1-1.2L4.7 12 .6 9.2C.3 9 .2 8.5.5 8.1l.6-1.1c.3-.4.9-.5 1.3-.2l1.7 1.3L17.5 3.1zM6.4 12l7.7 5.9v-11.8L6.4 12z" />
    </g>
  ),
  antigravity: (fill) => (
    <g fill="none" stroke={fill} strokeWidth="1.8" strokeLinecap="round">
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-28 12 12)" />
      <circle cx="12" cy="12" r="2.4" fill={fill} />
    </g>
  ),
  openclaw: (fill) => (
    <g fill="none" stroke={fill} strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 4c-3 3-4 6-4 9a4 4 0 0 0 8 0c0-3-1-6-4-9z" />
      <path d="M6 14c-.5 1.5-1.5 3-3 4M18 14c.5 1.5 1.5 3 3 4M9 19c0 .8-.3 1.7-1 2.5M15 19c0 .8.3 1.7 1 2.5" />
    </g>
  ),
  notes: (fill) => (
    <g fill="none" stroke={fill} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h10l4 4v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14 4v5h5M8 13h8M8 17h5" />
    </g>
  ),
};

export function BrandMark({
  id,
  size = 24,
  colored = false,
  inverted = false,
  tint,
  style,
}: {
  id: string;
  size?: number;
  colored?: boolean;
  inverted?: boolean;
  tint?: string;
  style?: CSSProperties;
}) {
  const brandId = (id in BRAND_PATHS ? id : "notes") as BrandId;
  const draw = BRAND_PATHS[brandId];
  const fill = inverted
    ? "#fff"
    : colored
      ? BRAND_COLORS[brandId] || "currentColor"
      : tint || "currentColor";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, ...style }}>
      {draw(fill)}
    </svg>
  );
}
