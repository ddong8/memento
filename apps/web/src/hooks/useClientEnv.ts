"use client";

import { useSyncExternalStore } from "react";
import { desktop } from "@/lib/desktop";

const noopSubscribe = () => () => {};

/** SSR-safe detection of the Memento desktop Electron shell without a mount-time setState effect. */
export function useIsDesktopApp(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => Boolean(desktop()),
    () => false,
  );
}

/** SSR-safe detection of macOS running inside the Memento desktop Electron shell. */
export function useIsMacDesktop(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () =>
      Boolean(desktop()) &&
      typeof navigator !== "undefined" &&
      (/Mac/i.test(navigator.userAgent) ||
        /Mac/i.test((navigator as { platform?: string }).platform || "")),
    () => false,
  );
}

/** SSR-safe detection of Windows running inside the Memento desktop Electron shell. */
export function useIsWindowsDesktop(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      if (typeof document === "undefined") return false;
      const d = document.documentElement.dataset;
      return d.client === "desktop" && d.os === "windows";
    },
    () => false,
  );
}
