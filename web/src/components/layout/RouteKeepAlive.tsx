"use client";

import React, { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Returns the canonical KeepAlive key for supported top-level menu routes.
 * Sub-detail pages (e.g. /projects/[id], /daily/[date]) return null so they render transiently.
 */
export function getRouteKeepAliveKey(pathname: string | null): string | null {
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
export default function RouteKeepAlive({ children }: RouteKeepAliveProps) {
  const pathname = usePathname();
  const currentKey = getRouteKeepAliveKey(pathname);

  // Store rendered views keyed by route key
  const [cachedViews, setCachedViews] = useState<Record<string, React.ReactNode>>(() => {
    if (currentKey) {
      return { [currentKey]: children };
    }
    return {};
  });

  // Track window-level scroll position across route switches
  const scrollMapRef = useRef<Record<string, number>>({});
  const activeKeyRef = useRef<string | null>(currentKey);

  useEffect(() => {
    // 1. Save scroll position of previous route
    const prevKey = activeKeyRef.current;
    if (prevKey && typeof window !== "undefined") {
      scrollMapRef.current[prevKey] = window.scrollY;
    }

    activeKeyRef.current = currentKey;

    // 2. Cache new route view if not yet cached
    if (currentKey) {
      setCachedViews((prev) => {
        if (!prev[currentKey]) {
          return { ...prev, [currentKey]: children };
        }
        return prev;
      });

      // 3. Restore window scroll position for current route
      if (typeof window !== "undefined") {
        const savedScroll = scrollMapRef.current[currentKey] ?? 0;
        requestAnimationFrame(() => {
          window.scrollTo(0, savedScroll);
        });
      }
    }
  }, [currentKey, pathname, children]);

  return (
    <>
      {Object.entries(cachedViews).map(([key, view]) => {
        const isCurrent = key === currentKey;
        return (
          <div
            key={key}
            id={`memento-keepalive-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
            data-memento-route-keepalive={key}
            style={{
              display: isCurrent ? "block" : "none",
              height: "100%",
            }}
          >
            {view}
          </div>
        );
      })}
      {/* Non-keepalive transient routes (e.g. /projects/[id], /profile) */}
      {!currentKey && (
        <div key={pathname} style={{ height: "100%" }}>
          {children}
        </div>
      )}
    </>
  );
}
