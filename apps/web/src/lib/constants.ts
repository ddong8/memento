/** Shared display helpers used across pages. */

/** Format byte sizes to human-readable strings. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${sizes[i]}`;
}

/** Format timestamp to relative time string, in the interface's language (Chinese unless English was picked). */
export function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  let en = false;
  try {
    en = typeof window !== "undefined" && localStorage.getItem("dr_locale") === "en-US";
  } catch {}
  if (mins < 1) return en ? "just now" : "刚刚";
  if (mins < 60) return en ? `${mins}m ago` : `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return en ? `${hrs}h ago` : `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return en ? `${days}d ago` : `${days} 天前`;
}
