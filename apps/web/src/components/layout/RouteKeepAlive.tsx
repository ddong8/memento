"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Returns the canonical KeepAlive key for supported top-level menu routes.
 * Sub-detail pages (e.g. /projects/[id], /daily/[date]) return null so they render transiently.
 */
function getRouteKeepAliveKey(pathname: string | null): string | null {
  if (!pathname) return null;
  // AI 执事 (Ask Butler) - covers /ask and /ask?id=...
  if (pathname === "/ask" || (pathname.startsWith("/ask/") && !pathname.startsWith("/ask/tools"))) {
    return "/ask";
  }
  // 全景总览 (Executive Overview)
  if (pathname === "/app") {
    return "/app";
  }
  // 个人画像 (Persona 3D)
  if (pathname.startsWith("/memory/persona")) {
    return "/memory/persona";
  }
  // 长期记忆 (Long-term Memory)
  if (pathname === "/memory") {
    return "/memory";
  }
  // 技能进化 (Skills)
  if (pathname === "/skills") {
    return "/skills";
  }
  // 工作待办 (Inbox / Todos)
  if (pathname === "/inbox") {
    return "/inbox";
  }
  // 项目工程 (Projects overview)
  if (pathname === "/projects") {
    return "/projects";
  }
  // 作息节律 (Daily rhythm)
  if (pathname === "/daily") {
    return "/daily";
  }
  // 设备管理 (Devices)
  if (pathname === "/devices") {
    return "/devices";
  }
  return null;
}

interface RouteKeepAliveProps {
  children: React.ReactNode;
}

/**
 * RouteKeepAlive keeps visited top-level views mounted in the DOM using display: block / none.
 * This completely avoids unmounting components when switching between sidebar menus
 * (e.g. AI 执事 and 全景总览), preserving:
 * 1) Component states and React hooks
 * 2) Ongoing active streams and SSE connections
 * 3) DOM scroll positions and draft input text
 * 4) Zero network refetching and zero flickering upon menu switches.
 */
const WEBGL_HEAVY_ROUTES = new Set(["/memory", "/memory/persona", "/skills"]);

export default function RouteKeepAlive({ children }: RouteKeepAliveProps) {
  const pathname = usePathname();
  const currentKey = getRouteKeepAliveKey(pathname);

  // Managed list of mounted route keys to ensure safe React reconciliation
  const [mountedKeys, setMountedKeys] = useState<string[]>(() => (currentKey ? [currentKey] : []));
  const viewsCacheRef = useRef<Record<string, React.ReactNode>>({});
  const lruOrderRef = useRef<string[]>(currentKey ? [currentKey] : []);
  const scrollMapRef = useRef<Record<string, number>>({});
  const activeKeyRef = useRef<string | null>(currentKey);

  // Always update the cached view of the current active route with latest children
  if (currentKey) {
    viewsCacheRef.current[currentKey] = children;
  }

  // Ensure currentKey is tracked immediately during render phase (zero blank frame)
  if (currentKey && !mountedKeys.includes(currentKey)) {
    setMountedKeys((prev) => (prev.includes(currentKey) ? prev : [...prev, currentKey]));
  }

  const effectiveMountedKeys =
    currentKey && !mountedKeys.includes(currentKey) ? [...mountedKeys, currentKey] : mountedKeys;

  // Safely update LRU order on route change
  useIsomorphicLayoutEffect(() => {
    if (!currentKey) return;

    lruOrderRef.current = [
      currentKey,
      ...lruOrderRef.current.filter((k) => k !== currentKey),
    ];
  }, [currentKey]);

  // Safely manage WebGL isolation and memory bounds in lifecycle commit phase (not during render)
  useEffect(() => {
    if (!currentKey) return;

    const isMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent));

    let updatedKeys = [...lruOrderRef.current];

    // 1. WebGL heavy route isolation: keep at most 1 heavy 3D route mounted to prevent GPU memory exhaustion
    if (WEBGL_HEAVY_ROUTES.has(currentKey)) {
      updatedKeys = updatedKeys.filter((k) => k === currentKey || !WEBGL_HEAVY_ROUTES.has(k));
    }

    // 2. Platform LRU capacity bounds: always keep /ask, plus top frequent tabs (desktop 6, mobile 4)
    const maxCached = isMobile ? 4 : 6;
    if (updatedKeys.length > maxCached) {
      const retained: string[] = [];
      for (const k of updatedKeys) {
        if (k === currentKey || k === "/ask" || retained.length < maxCached) {
          retained.push(k);
        }
      }
      updatedKeys = retained;
    }

    lruOrderRef.current = updatedKeys;

    // Clean up cache objects for evicted routes
    for (const key of Object.keys(viewsCacheRef.current)) {
      if (!updatedKeys.includes(key) && key !== currentKey) {
        delete viewsCacheRef.current[key];
        delete scrollMapRef.current[key];
      }
    }

    setMountedKeys((prev) => {
      const next = prev.filter((k) => updatedKeys.includes(k) || k === currentKey);
      if (next.length === prev.length && next.every((k, i) => k === prev[i])) {
        return prev;
      }
      return next;
    });
  }, [currentKey]);

  // Track window-level scroll position across route switches
  useIsomorphicLayoutEffect(() => {
    const prevKey = activeKeyRef.current;
    if (prevKey && typeof window !== "undefined") {
      scrollMapRef.current[prevKey] = window.scrollY;
    }

    activeKeyRef.current = currentKey;

    if (currentKey && typeof window !== "undefined") {
      const savedScroll = scrollMapRef.current[currentKey] ?? 0;
      window.scrollTo({ top: savedScroll, behavior: "instant" as ScrollBehavior });
    }
  }, [currentKey]);

  return (
    <>
      {effectiveMountedKeys.map((key) => {
        const isCurrent = key === currentKey;
        // Current route always receives latest live children; dormant routes display their preserved cache
        const content = isCurrent ? children : viewsCacheRef.current[key];
        return (
          <div
            key={key}
            id={`memento-keepalive-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
            data-memento-route-keepalive={key}
            data-memento-dormant={!isCurrent ? "true" : undefined}
            style={{
              display: isCurrent ? "block" : "none",
              height: "100%",
              contain: "style",
            }}
          >
            {content}
          </div>
        );
      })}
      {/* Non-keepalive transient routes (e.g. /projects/[id], /daily/[date], /profile) */}
      {!currentKey && (
        <div key={pathname} style={{ height: "100%" }}>
          {children}
        </div>
      )}
    </>
  );
}
