/**
 * Cross-platform haptic feedback trigger.
 * In Memento mobile app (WebView), it delegates to Expo Haptics (Taptic Engine).
 * In mobile web browsers, it falls back to navigator.vibrate.
 */
export function triggerHaptic(
  style: "light" | "medium" | "heavy" | "selection" | "success" | "warning" | "error" = "light"
): void {
  if (typeof window === "undefined") return;

  const fn = (window as unknown as { __memento_haptic?: (s: string) => void }).__memento_haptic;
  if (typeof fn === "function") {
    try {
      fn(style);
      return;
    } catch {}
  }

  if (typeof navigator !== "undefined" && "vibrate" in navigator) {
    try {
      if (style === "light" || style === "selection") navigator.vibrate(10);
      else if (style === "medium") navigator.vibrate(20);
      else if (style === "heavy") navigator.vibrate(35);
      else if (style === "success") navigator.vibrate([10, 30, 15]);
      else if (style === "error") navigator.vibrate([20, 40, 20, 40, 20]);
    } catch {}
  }
}
