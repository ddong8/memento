"use client";

import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

export default function TopProgressBar() {
  const pathname = usePathname();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  // Trigger loading animation on optimistic route start
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const handleStart = () => {
      if (timer) clearTimeout(timer);
      setLoading(true);
      setProgress(30);
      timer = setTimeout(() => {
        setProgress((prev) => (prev < 80 ? 80 : prev));
      }, 150);
    };

    window.addEventListener("memento:route-start", handleStart);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("memento:route-start", handleStart);
    };
  }, []);

  // Complete and fade out when pathname actually changes
  useEffect(() => {
    if (!loading) return;
    setProgress(100);
    const hideTimer = setTimeout(() => {
      setLoading(false);
      setProgress(0);
    }, 280);
    return () => clearTimeout(hideTimer);
  }, [pathname, loading]);

  if (!loading && progress === 0) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 z-50 pointer-events-none"
      style={{ height: 2.5 }}
    >
      <div
        className="h-full transition-all duration-200 ease-out"
        style={{
          width: `${progress}%`,
          background: "linear-gradient(90deg, var(--aurora-accent, #7C3AED), #06B6D4, #10B981, var(--aurora-accent, #7C3AED))",
          backgroundSize: "200% 100%",
          boxShadow: "0 0 10px rgba(124, 58, 237, 0.7), 0 0 4px rgba(6, 182, 212, 0.5)",
          opacity: progress === 100 ? 0 : 1,
          transition: progress === 100 ? "width 120ms ease-out, opacity 200ms 80ms ease-out" : "width 240ms ease-out",
        }}
      />
    </div>
  );
}
