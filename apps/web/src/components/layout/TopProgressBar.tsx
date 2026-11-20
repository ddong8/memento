"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// How long a menu switch may take before the bar shows. Kept views (RouteKeepAlive) and prefetched
// routes switch within a frame or two; a bar that flashes on every click reads like a web page
// reloading, not an app (the user, 2026-11-17: "为什么客户端打开页面时有像浏览器一样的进度条一刷而过").
// Only a switch that is really waiting (first visit to a route on a slow network) shows it.
export const SHOW_AFTER_MS = 200;

export default function TopProgressBar() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const pending = useRef(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = useRef(false);

  useEffect(() => {
    const clear = () => {
      if (showTimer.current) clearTimeout(showTimer.current);
      if (creepTimer.current) clearTimeout(creepTimer.current);
      showTimer.current = creepTimer.current = null;
    };
    const handleStart = (e: Event) => {
      const href = (e as CustomEvent<{ href?: string }>).detail?.href;
      if (href && href === window.location.pathname) return;
      clear();
      pending.current = true;
      showTimer.current = setTimeout(() => {
        if (!pending.current) return;
        shown.current = true;
        setProgress(30);
        creepTimer.current = setTimeout(() => setProgress((p) => (p > 0 && p < 80 ? 80 : p)), 300);
      }, SHOW_AFTER_MS);
    };
    window.addEventListener("memento:route-start", handleStart);
    return () => {
      clear();
      window.removeEventListener("memento:route-start", handleStart);
    };
  }, []);

  // The route arrived: if the bar never showed, nothing is drawn; otherwise it finishes and fades.
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    if (showTimer.current) clearTimeout(showTimer.current);
    if (creepTimer.current) clearTimeout(creepTimer.current);
    showTimer.current = creepTimer.current = null;
    if (!shown.current) return;
    shown.current = false;
    const finish = setTimeout(() => setProgress(100), 0);
    const hide = setTimeout(() => setProgress(0), 280);
    return () => {
      clearTimeout(finish);
      clearTimeout(hide);
    };
  }, [pathname]);

  if (progress === 0) return null;

  return (
    <div aria-hidden="true" data-testid="top-progress" className="fixed top-0 left-0 right-0 z-50 pointer-events-none" style={{ height: 2.5 }}>
      <div
        className="h-full"
        style={{
          width: `${progress}%`,
          background: "var(--aurora-accent, #2563EB)",
          boxShadow: "0 0 8px color-mix(in srgb, var(--aurora-accent, #2563EB) 55%, transparent)",
          opacity: progress === 100 ? 0 : 1,
          transition: progress === 100 ? "width 120ms ease-out, opacity 200ms 80ms ease-out" : "width 240ms ease-out",
        }}
      />
    </div>
  );
}
