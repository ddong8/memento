"use client";

import React, { Activity, createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  NavigationPromisesContext,
  PathParamsContext,
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// What Next's route tree and its navigation hooks (usePathname, useSearchParams, useParams) read. The
// `children` kept for a view is Next's slot, which renders the route the router is on *now* from these:
// kept bare, every kept view rendered the current page (on 2026-10-28 the ask page ran in up to 4
// copies on the phone and 6 on the desktop, each following the answer and polling on its own) and the
// page left behind was gone. Each view gets the values it had when it was last shown.
interface RouterView {
  layout: React.ContextType<typeof LayoutRouterContext>;
  pathname: React.ContextType<typeof PathnameContext>;
  searchParams: React.ContextType<typeof SearchParamsContext>;
  params: React.ContextType<typeof PathParamsContext>;
  navigation: React.ContextType<typeof NavigationPromisesContext>;
}

function RouterViewProvider({ view, children }: { view: RouterView; children: React.ReactNode }) {
  return (
    <LayoutRouterContext.Provider value={view.layout}>
      <PathnameContext.Provider value={view.pathname}>
        <SearchParamsContext.Provider value={view.searchParams}>
          <PathParamsContext.Provider value={view.params}>
            <NavigationPromisesContext.Provider value={view.navigation}>{children}</NavigationPromisesContext.Provider>
          </PathParamsContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </LayoutRouterContext.Provider>
  );
}

// Kept views that go on while hidden: the ask page keeps following a running answer, so coming back
// shows it at once. The others are paused (effects off, state and DOM kept): their polling and
// animation stop while out of sight and start again when shown.
const LIVE_WHILE_HIDDEN = new Set(["/ask"]);

interface KeptView {
  shownListeners: Set<() => void>;
}

const KeptViewContext = createContext<KeptView | null>(null);

/**
 * Calls `listener` when the kept view it's in is shown again after another menu was open, before the
 * browser draws it. Hiding a view loses the scroll position of the lists inside it.
 */
export function useRouteShown(listener: () => void): void {
  const view = useContext(KeptViewContext);
  const latest = useRef(listener);
  useIsomorphicLayoutEffect(() => {
    latest.current = listener;
  });
  useIsomorphicLayoutEffect(() => {
    if (!view) return;
    const call = () => latest.current();
    view.shownListeners.add(call);
    return () => {
      view.shownListeners.delete(call);
    };
  }, [view]);
}

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
  // 个人设置 (Profile)
  if (pathname === "/profile" || pathname.startsWith("/profile/")) {
    return "/profile";
  }
  // 任务管理 (Tasks)
  if (pathname === "/tasks") {
    return "/tasks";
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
 * 1) Component states and React hooks, each view on the route it was left at
 * 2) The ask page's running answer (the other hidden views are paused)
 * 3) Draft input text, and the window's scroll position
 * 4) Zero network refetching and zero flickering upon menu switches.
 */
const WEBGL_HEAVY_ROUTES = new Set(["/memory", "/memory/persona", "/skills"]);

export default function RouteKeepAlive({ children }: RouteKeepAliveProps) {
  const pathname = usePathname();
  const currentKey = getRouteKeepAliveKey(pathname);

  // Managed list of mounted route keys to ensure safe React reconciliation
  const [mountedKeys, setMountedKeys] = useState<string[]>(() => (currentKey ? [currentKey] : []));
  const viewsCacheRef = useRef<Record<string, React.ReactNode>>({});
  const routerViewsRef = useRef<Record<string, RouterView>>({});
  const keptViewsRef = useRef<Record<string, KeptView>>({});
  const lruOrderRef = useRef<string[]>(currentKey ? [currentKey] : []);
  const scrollMapRef = useRef<Record<string, number>>({});
  const activeKeyRef = useRef<string | null>(currentKey);
  const shownKeysRef = useRef<Set<string>>(new Set());

  const liveRouter: RouterView = {
    layout: useContext(LayoutRouterContext),
    pathname: useContext(PathnameContext),
    searchParams: useContext(SearchParamsContext),
    params: useContext(PathParamsContext),
    navigation: useContext(NavigationPromisesContext),
  };

  // Always update the cached view of the current active route with latest children
  if (currentKey) {
    viewsCacheRef.current[currentKey] = children;
    routerViewsRef.current[currentKey] = liveRouter;
    keptViewsRef.current[currentKey] ??= { shownListeners: new Set() };
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
        delete routerViewsRef.current[key];
        delete keptViewsRef.current[key];
        shownKeysRef.current.delete(key);
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

    // A view shown before, hidden since, is back (not one just opened for the first time)
    if (currentKey && currentKey !== prevKey && shownKeysRef.current.has(currentKey)) {
      for (const listener of keptViewsRef.current[currentKey]?.shownListeners ?? []) {
        try {
          listener();
        } catch (err) {
          console.error(err);
        }
      }
    }
    if (currentKey) shownKeysRef.current.add(currentKey);
  }, [currentKey]);

  return (
    <>
      {effectiveMountedKeys.map((key) => {
        const isCurrent = key === currentKey;
        // Current route always receives latest live children; dormant routes display their preserved cache
        const content = isCurrent ? children : viewsCacheRef.current[key];
        const router = isCurrent ? liveRouter : (routerViewsRef.current[key] ?? liveRouter);
        return (
          <div
            key={key}
            id={`memento-keepalive-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`}
            data-memento-route-keepalive={key}
            data-memento-dormant={!isCurrent ? "true" : undefined}
            aria-hidden={!isCurrent ? true : undefined}
            tabIndex={!isCurrent ? -1 : undefined}
            style={{
              display: isCurrent ? "block" : "none",
              height: "100%",
              contain: isCurrent ? "style" : "strict",
              pointerEvents: isCurrent ? "auto" : "none",
            }}
          >
            <KeptViewContext.Provider value={keptViewsRef.current[key] ?? null}>
              <RouterViewProvider view={router}>
                <Activity mode={isCurrent || LIVE_WHILE_HIDDEN.has(key) ? "visible" : "hidden"}>{content}</Activity>
              </RouterViewProvider>
            </KeptViewContext.Provider>
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
