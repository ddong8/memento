"use client";

import { useEffect, useState } from "react";

/**
 * Returns a "now" timestamp (ms) that ticks every `intervalMs`.
 *
 * Use this instead of bare `Date.now()` inside render — React 19's purity
 * rule (`react-hooks/purity`) flags `Date.now()` as non-deterministic.
 * Having state-bound time also means "N minutes ago" / online indicators
 * auto-refresh instead of being stuck at first-render time.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setNow(Date.now());
    };
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        setNow(Date.now());
      }
    };
    const id = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
  return now;
}
