"use client";

import { useEffect, useState } from "react";

/** Tracks mobile virtual keyboard height via window.visualViewport so bottom controls stay visible. */
export function useMobileKeyboardOffset(): number {
  const [viewportBottomOffset, setViewportBottomOffset] = useState<number>(0);

  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const handleViewportChange = () => {
      const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setViewportBottomOffset(keyboardHeight > 40 ? Math.round(keyboardHeight) : 0);
    };
    vv.addEventListener("resize", handleViewportChange);
    vv.addEventListener("scroll", handleViewportChange);
    return () => {
      vv.removeEventListener("resize", handleViewportChange);
      vv.removeEventListener("scroll", handleViewportChange);
    };
  }, []);

  return viewportBottomOffset;
}
