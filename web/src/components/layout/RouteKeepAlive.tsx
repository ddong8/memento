"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

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
const WEBGL_HEAVY_ROUTES = new Set(["/memory", "/memory/persona", "/skills"]);

export default function RouteKeepAlive({ children }: RouteKeepAliveProps) {
  const pathname = usePathname();
  const currentKey = getRouteKeepAliveKey(pathname);

  // Store rendered views keyed by route key synchronously during render (zero double-render lag)
  const cachedViewsRef = useRef<Record<string, React.ReactNode>>({});
  const lruOrderRef = useRef<string[]>([]);

  if (currentKey) {
    if (!cachedViewsRef.current[currentKey]) {
      cachedViewsRef.current[currentKey] = children;
    }
    lruOrderRef.current = [
      currentKey,
      ...lruOrderRef.current.filter((k) => k !== currentKey),
    ];

    const isMobile =
      typeof window !== "undefined" &&
      (window.innerWidth < 768 || /Mobi|Android|iPhone/i.test(navigator.userAgent));

    if (isMobile) {
      // 移动端防显存溢出：最多保留 1 个重型 3D WebGL 路由驻留，防止同时维持 3 个 WebGL 上下文导致手机发热或闪退
      if (WEBGL_HEAVY_ROUTES.has(currentKey)) {
        for (const k of Object.keys(cachedViewsRef.current)) {
          if (k !== currentKey && WEBGL_HEAVY_ROUTES.has(k)) {
            delete cachedViewsRef.current[k];
            lruOrderRef.current = lruOrderRef.current.filter((item) => item !== k);
          }
        }
      }
      // 移动端 LRU 容量上限：常驻保留 /ask 主对话，其余最多缓存最近访问的 3 个高频菜单页（共 4 页）
      const maxMobileCached = 4;
      const keys = Object.keys(cachedViewsRef.current);
      if (keys.length > maxMobileCached) {
        for (let i = lruOrderRef.current.length - 1; i >= 0; i--) {
          const candidate = lruOrderRef.current[i];
          if (candidate !== currentKey && candidate !== "/ask") {
            delete cachedViewsRef.current[candidate];
            lruOrderRef.current.splice(i, 1);
            if (Object.keys(cachedViewsRef.current).length <= maxMobileCached) {
              break;
            }
          }
        }
      }
    }
  }

  // Track window-level scroll position across route switches
  const scrollMapRef = useRef<Record<string, number>>({});
  const activeKeyRef = useRef<string | null>(currentKey);

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
      {Object.entries(cachedViewsRef.current).map(([key, view]) => {
        const isCurrent = key === currentKey;
        return (
          <div
            key={key}
            id={`memento-keepalive-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
            data-memento-route-keepalive={key}
            style={{
              display: isCurrent ? "block" : "none",
              height: "100%",
              contain: "style",
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
