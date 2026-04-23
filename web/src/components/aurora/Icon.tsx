"use client";

import type { CSSProperties, SVGProps } from "react";
import { BrandMark, BRAND_COLORS } from "./BrandMark";
import { useTheme } from "@/lib/theme-context";

type IconName =
  | "home" | "calendar" | "search" | "devices" | "folder" | "brain"
  | "lock" | "sparkles" | "arrow_right" | "arrow_left"
  | "chevron_right" | "chevron_left" | "chevron_down" | "chevron_up"
  | "user" | "log_out" | "sun" | "moon" | "plus" | "minus"
  | "apple" | "linux" | "windows" | "cube"
  | "rocket" | "octopus" | "lightning" | "diamond" | "surf" | "box"
  | "layers" | "message" | "file_text" | "clock" | "book"
  | "settings" | "target" | "code" | "terminal" | "edit"
  | "activity" | "zap" | "grid" | "inbox" | "command"
  | "arrow_up" | "arrow_down" | "refresh" | "check" | "close"
  | "menu" | "trash" | "link" | "copy" | "external_link" | "eye";

const PATHS: Record<IconName, React.ReactElement> = {
  home: <><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-7h4v7h4a1 1 0 0 0 1-1V10"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></>,
  devices: <><rect x="2" y="4" width="14" height="10" rx="1.5"/><rect x="14" y="9" width="8" height="11" rx="1.5"/><path d="M5 18h6"/></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>,
  brain: <><path d="M9 4.5a2.5 2.5 0 0 0-5 0v.5a2.5 2.5 0 0 0-2 4.5 2.5 2.5 0 0 0 .5 5A2.5 2.5 0 0 0 4 19a2.5 2.5 0 0 0 5 .5V4.5z"/><path d="M15 4.5a2.5 2.5 0 0 1 5 0v.5a2.5 2.5 0 0 1 2 4.5 2.5 2.5 0 0 1-.5 5A2.5 2.5 0 0 1 20 19a2.5 2.5 0 0 1-5 .5V4.5z"/></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>,
  sparkles: <><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7z"/></>,
  arrow_right: <path d="M5 12h14M13 5l7 7-7 7"/>,
  arrow_left: <path d="M19 12H5M12 5l-7 7 7 7"/>,
  chevron_right: <path d="M9 5l7 7-7 7"/>,
  chevron_left: <path d="M15 5l-7 7 7 7"/>,
  chevron_down: <path d="M5 9l7 7 7-7"/>,
  chevron_up: <path d="M19 15l-7-7-7 7"/>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  log_out: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  minus: <path d="M5 12h14"/>,
  apple: <><path d="M16.5 12.5c0-2.6 2.1-3.8 2.2-3.9-1.2-1.7-3-2-3.7-2-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9c-1.7 0-3.4 1-4.3 2.6-1.8 3.2-.5 7.9 1.3 10.5.9 1.3 1.9 2.7 3.3 2.6 1.3-.1 1.8-.9 3.4-.9s2 .9 3.4.9c1.4 0 2.3-1.3 3.2-2.6 1-1.5 1.4-2.9 1.4-3-.1 0-2.7-1-2.9-4.2z"/><path d="M14 5.4c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.5-.7.8-1.3 2-1.1 3.1 1.2.1 2.3-.6 3-1.4z"/></>,
  linux: <><path d="M12 3c-2 0-3 1.5-3 4 0 1 .3 2 .8 2.7-1.4 1.5-3.3 4-3.3 6.8 0 1.7.7 3 2 3.5l1.5-2.5h4l1.5 2.5c1.3-.5 2-1.8 2-3.5 0-2.8-1.9-5.3-3.3-6.8.5-.7.8-1.7.8-2.7 0-2.5-1-4-3-4z"/><circle cx="10.5" cy="7" r=".7"/><circle cx="13.5" cy="7" r=".7"/></>,
  windows: <path d="M3 5.5l8-1.2v7.2H3zM12 4.2l9-1.4v9H12zM3 12.5h8v7.2L3 18.5zM12 12.5h9v9.3L12 20.5z"/>,
  cube: <><path d="M12 2L3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/></>,
  rocket: <><path d="M5 14l-2 4 4-2c2 1 5 0 7-2l5-5c1-1 1-4-1-6s-5-2-6-1l-5 5c-2 2-3 5-2 7z"/><circle cx="14" cy="10" r="2"/></>,
  octopus: <><circle cx="12" cy="9" r="5"/><path d="M7 13c0 4-2 6-2 8M10 14c0 4-1 6-1 8M14 14c0 4 1 6 1 8M17 13c0 4 2 6 2 8"/></>,
  lightning: <path d="M13 2L4 14h7l-1 8 9-12h-7z"/>,
  diamond: <><path d="M6 3h12l4 7-10 11L2 10z"/><path d="M11 3l-2 7h6l-2-7M2 10h20"/></>,
  surf: <><path d="M2 17c2-1 4 1 6 0s4-3 6-3 4 2 6 1M2 14c2 0 4-2 6-2s4 1 6 1 4-2 6-2"/><path d="M4 8c4-3 12-3 16 0"/></>,
  box: <><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4 9-4V7"/></>,
  layers: <><path d="M12 2l10 5-10 5L2 7z"/><path d="M2 12l10 5 10-5M2 17l10 5 10-5"/></>,
  message: <path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12z"/>,
  file_text: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  book: <><path d="M4 3h12a4 4 0 0 1 4 4v14H8a4 4 0 0 1-4-4z"/><path d="M4 17a4 4 0 0 1 4-4h12"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
  code: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/>,
  terminal: <><path d="M4 17l6-5-6-5M12 19h8"/></>,
  edit: <><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></>,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>,
  zap: <path d="M13 2L4 14h7l-1 8 9-12h-7z"/>,
  grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/></>,
  command: <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>,
  arrow_up: <path d="M12 19V5M5 12l7-7 7 7"/>,
  arrow_down: <path d="M12 5v14M19 12l-7 7-7-7"/>,
  refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>,
  check: <path d="M5 12l5 5L20 7"/>,
  close: <path d="M6 6l12 12M18 6l-12 12"/>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  trash: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07L11 5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07L13 19"/></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
  external_link: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/></>,
  eye: <><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></>,
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number | string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, strokeWidth = 1.6, style, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...(style as CSSProperties) }}
      {...rest}
    >
      {PATHS[name] ?? <circle cx="12" cy="12" r="9" />}
    </svg>
  );
}

/** Tool id → gradient accent + icon */
export const TOOL_HUE: Record<string, { h: number; bg: string }> = {
  claude_code: { h: 22,  bg: "linear-gradient(135deg,#FB923C,#F43F5E)" },
  openclaw:    { h: 280, bg: "linear-gradient(135deg,#C084FC,#7C3AED)" },
  codex:       { h: 142, bg: "linear-gradient(135deg,#34D399,#10B981)" },
  antigravity: { h: 220, bg: "linear-gradient(135deg,#60A5FA,#2563EB)" },
  obsidian:    { h: 260, bg: "linear-gradient(135deg,#A78BFA,#7C3AED)" },
  cursor:      { h: 190, bg: "linear-gradient(135deg,#22D3EE,#0891B2)" },
  windsurf:    { h: 170, bg: "linear-gradient(135deg,#5EEAD4,#0D9488)" },
  vscode:      { h: 240, bg: "linear-gradient(135deg,#818CF8,#4F46E5)" },
};

export const TOOL_ICON_NAME: Record<string, IconName> = {
  claude_code: "sparkles", openclaw: "octopus", codex: "box",
  antigravity: "rocket", obsidian: "diamond", cursor: "lightning",
  windsurf: "surf", vscode: "code",
};

export const PLATFORM_ICON_NAME: Record<string, IconName> = {
  Darwin: "apple", Linux: "linux", Windows: "windows",
};

export const CATEGORY_ICON_NAME: Record<string, IconName> = {
  config: "settings", conversation: "message", memory: "brain",
  history: "clock", plan: "target", identity: "user", state: "activity",
  learning: "book", extension: "layers", note: "edit", skill: "zap",
};

export function ToolGlyph({ id, size = 36 }: { id: string; size?: number }) {
  const { skin, theme } = useTheme();
  const tool = TOOL_HUE[id] ?? TOOL_HUE.claude_code;
  const radius = Math.max(6, size * 0.28);
  const brandColor = BRAND_COLORS[id] || tool.bg;

  // Aurora: colored gradient tile + white brand mark + highlight
  if (skin === "aurora") {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: tool.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
          boxShadow: `0 8px 24px -8px hsla(${tool.h},80%,55%,0.55),
                      0 1px 0 0 rgba(255,255,255,0.35) inset,
                      0 0 0 1px rgba(255,255,255,0.12) inset,
                      0 -8px 16px -8px rgba(0,0,0,0.25) inset`,
          flexShrink: 0,
          color: "#fff",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            background: "radial-gradient(120% 80% at 30% 0%, rgba(255,255,255,0.3), transparent 60%)",
            pointerEvents: "none",
          }}
        />
        <BrandMark id={id} size={size * 0.58} inverted />
      </div>
    );
  }

  // Arc / Baseline: subtle brand-tinted tile + colored brand mark
  const pad = size >= 18;
  const tint = pad ? brandColor + (theme === "dark" ? "20" : "10") : "transparent";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: pad
          ? `linear-gradient(180deg, ${tint}, transparent 70%), var(--aurora-surface-solid)`
          : "transparent",
        border: pad ? "1px solid var(--aurora-border)" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        boxShadow: size >= 32 ? "0 1px 0 var(--aurora-border)" : "none",
      }}
    >
      <BrandMark id={id} size={pad ? size * 0.64 : size * 0.9} colored />
    </div>
  );
}

export function PlatformGlyph({ name, size = 32 }: { name: string; size?: number }) {
  const platform = name.match(/\((\w+)\)/)?.[1] ?? name;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        background: "linear-gradient(135deg,#1F1B3A,#2A1F4F)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: "0 4px 14px -4px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08) inset",
        flexShrink: 0,
        color: "#E5E7EB",
      }}
    >
      <Icon name={PLATFORM_ICON_NAME[platform] ?? "cube"} size={size * 0.55} />
    </div>
  );
}

export function CategoryIcon({ category, size = 14 }: { category: string; size?: number }) {
  return <Icon name={CATEGORY_ICON_NAME[category] ?? "file_text"} size={size} />;
}
