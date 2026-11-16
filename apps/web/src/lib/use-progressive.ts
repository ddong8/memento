"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Render a long list a slice at a time: `count` starts at `first` and grows by `step` whenever the
 * element behind `sentinelRef` comes within `margin` of the viewport. Nothing is dropped, the rest is
 * just built as the reader scrolls toward it. A Claude Code session can hold thousands of messages;
 * mounting all of them at once (115k DOM nodes for one page of a project's conversations) froze a
 * phone for about 4 s.
 */
export function useProgressiveCount(total: number, first = 60, step = 120, margin = "1600px 0px") {
  const [count, setCount] = useState(first);
  // A callback ref: the sentinel may mount later (a collapsed session expanded), and observing has to
  // start then, not only when count changes
  const [el, sentinelRef] = useState<HTMLElement | null>(null);
  const done = count >= total;

  useEffect(() => {
    if (!el || done || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step);
      },
      { rootMargin: margin },
    );
    io.observe(el);
    // Re-observed after each step, so a sentinel still in range keeps filling until it isn't
    return () => io.disconnect();
  }, [el, done, count, step, margin]);

  const reset = useCallback(() => setCount(first), [first]);
  return { count, done, sentinelRef, reset };
}
