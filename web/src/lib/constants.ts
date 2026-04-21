/** Shared constants — icons, colors, and display mappings used across pages. */

export const TOOL_ICONS: Record<string, string> = {
  claude_code: "🤖",
  openclaw: "🐙",
  codex: "📦",
  antigravity: "🚀",
  obsidian: "💎",
  cursor: "⚡",
  windsurf: "🏄",
  vscode: "💠",
};

export const PLATFORM_ICONS: Record<string, string> = {
  Darwin: "🍎",
  Linux: "🐧",
  Windows: "🪟",
};

/** Tool card left-border accent colors (Tailwind classes). */
export const TOOL_COLORS: Record<string, string> = {
  claude_code: "border-l-orange-500",
  openclaw: "border-l-purple-500",
  codex: "border-l-green-500",
  antigravity: "border-l-blue-500",
  obsidian: "border-l-violet-500",
  cursor: "border-l-cyan-500",
  windsurf: "border-l-teal-500",
  vscode: "border-l-indigo-500",
};

/** Category display icons. */
export const CATEGORY_ICONS: Record<string, string> = {
  config: "⚙️",
  conversation: "💬",
  memory: "🧠",
  history: "📜",
  plan: "📋",
  identity: "🪪",
  state: "📊",
  learning: "📚",
  extension: "🧩",
  note: "📝",
  skill: "🎯",
};

export function getToolIcon(toolId: string): string {
  return TOOL_ICONS[toolId] || "🔧";
}

export function getPlatformIcon(platform: string): string {
  return PLATFORM_ICONS[platform] || "💻";
}

export function getCategoryIcon(category: string): string {
  return CATEGORY_ICONS[category] || "📄";
}

/** Format byte sizes to human-readable strings. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/** Get browser timezone offset as query param string (e.g. "&tz_offset=-480" for UTC+8). */
export function tzParam(): string {
  return `tz_offset=${new Date().getTimezoneOffset()}`;
}

/** Format timestamp to relative time string. */
export function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
