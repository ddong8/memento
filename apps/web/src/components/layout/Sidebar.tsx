"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { memo, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth-context";
import { getApiBase, authFetch, api } from "@/lib/api-client";
import { Icon } from "@/components/aurora/Icon";
import { UserMenu } from "@/components/UserMenu";
import { desktop } from "@/lib/desktop";
import { useSidebar } from "@/lib/sidebar-context";
import pkg from "../../../package.json";

const WEB_VERSION = `v${(pkg as { version: string }).version}`;

type IconName = Parameters<typeof Icon>[0]["name"];

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const { user } = useAuth();
  const { collapsed, toggleCollapsed } = useSidebar();
  const [onlineCount, setOnlineCount] = useState<number>(0);
  const [totalDevices, setTotalDevices] = useState<number>(0);
  const [todoCount, setTodoCount] = useState<number>(0);
  const [isMacDesktop, setIsMacDesktop] = useState(false);
  const [appVersion, setAppVersion] = useState(WEB_VERSION);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);

  useEffect(() => {
    const d = desktop();
    if (d) {
      const isMac =
        typeof navigator !== "undefined" &&
        (/Mac/i.test(navigator.userAgent) || /Mac/i.test((navigator as { platform?: string }).platform || ""));
      if (isMac) setIsMacDesktop(true);

      d.info()
        .then((info) => {
          if (info?.version) {
            setAppVersion(info.version.startsWith("v") ? info.version : `v${info.version}`);
          }
        })
        .catch(() => {});
    }
  }, []);

  // Fetch online devices
  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("dr_token") : null;
    if (!token) return;

    const fetchDevices = (force = false) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!force && typeof window !== "undefined" && window.innerWidth < 1024 && !open) return;
      api.getDevices()
        .then((devs) => {
          if (!Array.isArray(devs)) return;
          setTotalDevices(devs.length);
          const now = Date.now();
          const online = devs.filter(
            (d) =>
              d.online ??
              (!!d.last_heartbeat && now - new Date(d.last_heartbeat).getTime() < 180000)
          ).length;
          setOnlineCount(online);
        })
        .catch(() => {});
    };

    fetchDevices(true);
    const timer = setInterval(() => fetchDevices(false), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Fetch uncompleted todos for badge
  useEffect(() => {
    const token = typeof window !== "undefined" ? localStorage.getItem("dr_token") : null;
    if (!token) return;

    const fetchTodos = async (force = false) => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (!force && typeof window !== "undefined" && window.innerWidth < 1024 && !open) return;
      try {
        const data = (await api.getTodos()) as { counts?: Record<string, number>; open?: unknown[] };
        const counts = data?.counts;
        const openTodos = typeof counts?.open === "number" ? counts.open : (Array.isArray(data?.open) ? data.open.length : 0);
        setTodoCount(openTodos);
      } catch {}
    };

    void fetchTodos(true);
    const timer = setInterval(() => void fetchTodos(false), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Check update version
  useEffect(() => {
    const d = desktop();
    const check = async () => {
      let plat = "web";
      let currentVer = WEB_VERSION.replace(/^v/, "");
      if (d) {
        try {
          const info = await d.info();
          if (info?.platform) plat = info.platform;
          if (info?.version) currentVer = info.version.replace(/^v/, "");
        } catch {}
      }
      try {
        const r = await authFetch(`${getApiBase()}/api/system/update/check?platform=${encodeURIComponent(plat)}&version=${encodeURIComponent(currentVer)}`);
        const data = await r.json();
        if (data?.has_update && data.latest_version) {
          const lv = data.latest_version.startsWith("v") ? data.latest_version : `v${data.latest_version}`;
          setUpdateAvailable(lv);
        }
      } catch {}
    };
    void check();
  }, []);

  const [optimisticPath, setOptimisticPath] = useState<string | null>(null);

  useEffect(() => {
    setOptimisticPath(null);
  }, [pathname]);

  const effectivePath = optimisticPath ?? pathname;

  // Pre-warm primary top routes during browser idle time (zero delay on first visit)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prewarmRoutes = () => {
      const routes = ["/ask", "/app", "/inbox", "/memory", "/projects", "/daily", "/skills"];
      for (const r of routes) {
        try {
          router.prefetch(r);
        } catch {}
      }
    };

    if ("requestIdleCallback" in window) {
      const handle = (
        window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }
      ).requestIdleCallback(prewarmRoutes, { timeout: 2500 });
      return () => {
        if ("cancelIdleCallback" in window) {
          (window as unknown as { cancelIdleCallback: (id: number) => void }).cancelIdleCallback(handle);
        }
      };
    } else {
      const timer = setTimeout(prewarmRoutes, 1200);
      return () => clearTimeout(timer);
    }
  }, [router]);

  const handleNavClick = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) onClose();
  };

  const handleItemHover = (targetHref: string) => {
    try {
      router.prefetch(targetHref);
    } catch {}

    // Pre-warm data caches for specific modules on mouse hover
    if (targetHref === "/inbox") {
      void api.getTodos().catch(() => {});
    } else if (targetHref === "/projects") {
      void api.listProjects().catch(() => {});
    } else if (targetHref === "/app") {
      void api.getDevices().catch(() => {});
    }
  };

  const handleItemClick = (targetHref: string) => {
    // Redundant click guard: prevent re-triggering concurrent transitions when already on route
    if (effectivePath === targetHref) {
      if (typeof window !== "undefined" && window.innerWidth < 1024) onClose();
      return;
    }

    setOptimisticPath(targetHref);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("memento:route-start", { detail: { href: targetHref } }));
      try {
        localStorage.setItem("memento_last_route", targetHref);
        localStorage.setItem("memento_last_menu_route", targetHref);
      } catch {}

      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate(8);
        } catch {}
      }

      if (window.innerWidth < 1024) {
        onClose();
      }
    }
  };

  const handleOpenSearch = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("memento:open-search"));
    }
  };

  const [askHref, setAskHref] = useState<string>(() => {
    if (typeof window === "undefined") return "/ask";
    try {
      const lastId = localStorage.getItem("memento_last_ask_conv_id");
      return lastId ? `/ask?id=${encodeURIComponent(lastId)}` : "/ask";
    } catch {
      return "/ask";
    }
  });

  useEffect(() => {
    const updateHref = () => {
      try {
        const lastId = localStorage.getItem("memento_last_ask_conv_id");
        const nextHref = lastId ? `/ask?id=${encodeURIComponent(lastId)}` : "/ask";
        setAskHref((prev) => (prev !== nextHref ? nextHref : prev));
      } catch {}
    };
    window.addEventListener("storage", updateHref);
    window.addEventListener("memento_switch_chat", updateHref);
    return () => {
      window.removeEventListener("storage", updateHref);
      window.removeEventListener("memento_switch_chat", updateHref);
    };
  }, []);

  const isAskActive = effectivePath === "/ask" || (effectivePath.startsWith("/ask/") && !effectivePath.startsWith("/ask/tools"));
  const isOverviewActive = effectivePath === "/app";
  const isPersonaActive = effectivePath.startsWith("/memory/persona");
  const isMemoryActive = (effectivePath === "/memory" || effectivePath.startsWith("/memory/")) && !isPersonaActive;
  const isSkillsActive = effectivePath === "/skills" || effectivePath.startsWith("/skills/");
  const isDailyActive = effectivePath === "/daily" || effectivePath.startsWith("/daily/");
  const isProjectsActive = effectivePath === "/projects" || effectivePath.startsWith("/projects/");
  const isInboxActive = effectivePath === "/inbox" || effectivePath.startsWith("/inbox/");

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={onClose} />}

      <aside
        className={[
          "fixed left-0 top-0 z-40 flex flex-col h-screen h-[100dvh] select-none",
          "transition-[width,transform] duration-200 ease-in-out",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:!translate-x-0",
          collapsed ? "w-[68px]" : "w-60",
        ].join(" ")}
        style={{
          background: "var(--aurora-sidebar)",
          backdropFilter: "var(--aurora-blur)",
          WebkitBackdropFilter: "var(--aurora-blur)",
          borderRight: "1px solid var(--aurora-border)",
          color: "var(--aurora-fg2)",
        }}
      >
        {/* Brand & Collapse Header */}
        <div
          className={`px-3.5 pb-2.5 flex items-center justify-between ${
            isMacDesktop ? "pt-12 app-region-drag" : "pt-4"
          }`}
        >
          <Link
            href={askHref}
            prefetch={true}
            onClick={() => handleItemClick(askHref)}
            className={`flex items-center gap-2.5 min-w-0 app-region-no-drag ${
              collapsed ? "w-full justify-center" : "flex-1"
            }`}
            title={collapsed ? "Memento · 展开侧边栏 (⌘B)" : undefined}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 10,
                background: "var(--aurora-brand-grad)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 14px -4px rgba(124,58,237,0.5)",
                flexShrink: 0,
              }}
            >
              <Icon name="sparkles" size={16} style={{ color: "#fff" }} strokeWidth={2} />
            </div>
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div
                  style={{
                    fontSize: 13.5,
                    fontWeight: 600,
                    color: "var(--aurora-fg1)",
                    letterSpacing: "-0.02em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.app.title}
                </div>
                <div style={{ fontSize: 10.5, color: "var(--aurora-fg4)", marginTop: 0.5 }}>
                  {t.app.subtitle}
                </div>
              </div>
            )}
          </Link>

          {/* Desktop Collapse Toggle */}
          {!collapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="折叠侧边栏 (⌘B)"
              className="hidden lg:flex items-center justify-center w-7 h-7 rounded-lg text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] transition-colors app-region-no-drag"
              style={{ border: "none", background: "transparent", cursor: "pointer" }}
            >
              <Icon name="sidebar" size={15} />
            </button>
          )}

          {/* Mobile close button */}
          <button
            onClick={onClose}
            aria-label="Close"
            className="lg:hidden app-region-no-drag"
            style={{ color: "var(--aurora-fg3)", padding: 4 }}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        {/* Global Search Button (⌘K) */}
        <div className={`px-2.5 pb-2 ${collapsed ? "flex justify-center" : ""}`}>
          <button
            type="button"
            onClick={handleOpenSearch}
            className={`flex items-center rounded-xl transition-all group ${
              collapsed
                ? "w-10 h-10 justify-center hover:bg-[var(--aurora-chip)]"
                : "w-full justify-between px-2.5 py-1.5 hover:border-[var(--aurora-accent)]"
            }`}
            style={{
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg3)",
              cursor: "pointer",
              outline: "none",
            }}
            title={collapsed ? "快速检索记忆与会话 (⌘K)" : undefined}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Icon name="search" size={14} style={{ color: "var(--aurora-fg3)", flexShrink: 0 }} />
              {!collapsed && (
                <span
                  style={{ fontSize: 12, color: "var(--aurora-fg4)" }}
                  className="group-hover:text-[var(--aurora-fg2)] transition-colors"
                >
                  {t.nav.searchPlaceholder || "快速检索..."}
                </span>
              )}
            </div>
            {!collapsed && (
              <kbd
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 10,
                  fontWeight: 600,
                  background: "var(--aurora-surface)",
                  border: "1px solid var(--aurora-border)",
                  borderRadius: 5,
                  padding: "1px 5px",
                  color: "var(--aurora-fg4)",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
                }}
              >
                ⌘K
              </kbd>
            )}
          </button>
        </div>

        <div style={{ height: 1, background: "var(--aurora-border)", margin: "0 12px" }} />

        {/* Navigation Sections */}
        <nav className="flex-1 overflow-y-auto py-1.5 scrollbar-none">
          {/* Section 1: 主控制台 */}
          <SectionHeader label={t.nav.sectionExecutive || "主控制台"} collapsed={collapsed} />
          <NavRow
            href={askHref}
            label={t.nav.ask || "AI 执事"}
            icon="sparkles"
            active={isAskActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
          <NavRow
            href="/app"
            label={t.nav.overview || "全景总览"}
            icon="home"
            active={isOverviewActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />

          {/* Section 2: 认知大脑 */}
          <SectionHeader
            label={t.nav.sectionBrain || "认知大脑"}
            collapsed={collapsed}
            style={{ marginTop: collapsed ? 0 : 12 }}
          />
          <NavRow
            href="/memory"
            label={t.nav.memory || "长期记忆"}
            icon="brain"
            active={isMemoryActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
          <NavRow
            href="/memory/persona"
            label={t.nav.persona || "个人画像"}
            icon="user"
            active={isPersonaActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
          <NavRow
            href="/skills"
            label={t.nav.skills || "技能进化"}
            icon="zap"
            active={isSkillsActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />

          {/* Section 3: 任务与资产 (待办置顶) */}
          <SectionHeader
            label={t.nav.sectionWorkspace || "任务与资产"}
            collapsed={collapsed}
            style={{ marginTop: collapsed ? 0 : 12 }}
          />
          <NavRow
            href="/inbox"
            label={t.nav.inbox || "工作待办"}
            icon="inbox"
            active={isInboxActive}
            badge={todoCount > 0 ? String(todoCount) : undefined}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
          <NavRow
            href="/projects"
            label={t.nav.projects || "项目工程"}
            icon="folder"
            active={isProjectsActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
          <NavRow
            href="/daily"
            label={t.nav.daily || "作息节律"}
            icon="calendar"
            active={isDailyActive}
            collapsed={collapsed}
            onNavigate={handleItemClick}
            onHover={handleItemHover}
          />
        </nav>

        {/* Bottom Section: Device status indicator + User Menu + Collapse / Version */}
        <div
          className="p-2.5"
          style={{
            borderTop: "1px solid var(--aurora-border)",
            paddingBottom: "max(0.625rem, env(safe-area-inset-bottom, 0.625rem))",
          }}
        >
          {/* Online devices indicator */}
          <Link
            href="/profile?tab=devices"
            prefetch={true}
            onClick={() => handleItemClick("/profile?tab=devices")}
            className={`flex items-center rounded-xl text-xs transition-all hover:opacity-90 mb-1.5 ${
              collapsed ? "w-10 h-9 mx-auto justify-center" : "justify-between px-3 py-1.5"
            }`}
            style={{
              background: onlineCount > 0 ? "rgba(16,185,129,0.08)" : "var(--aurora-chip)",
              border: onlineCount > 0 ? "1px solid rgba(16,185,129,0.25)" : "1px solid var(--aurora-border)",
              color: "var(--aurora-fg2)",
              textDecoration: "none",
            }}
            title={
              collapsed
                ? onlineCount > 0
                  ? `${onlineCount} 台设备在线 (点击管理)`
                  : "无在线设备 (点击管理)"
                : "点击管理终端设备"
            }
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 9999,
                  background: onlineCount > 0 ? "#10B981" : "var(--aurora-fg4)",
                  boxShadow: onlineCount > 0 ? "0 0 6px #10B981" : "none",
                  flexShrink: 0,
                }}
              />
              {!collapsed && (
                <span
                  style={{
                    fontSize: 11.5,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {onlineCount > 0
                    ? (t.nav.onlineCount || "{n} 台设备在线").replace("{n}", String(onlineCount))
                    : t.nav.noOnline || "无在线设备"}
                </span>
              )}
            </div>
            {!collapsed && (
              <span style={{ color: "var(--aurora-fg4)", fontSize: 10.5 }}>
                {totalDevices > 0 ? `${totalDevices}台` : "管理"} &rarr;
              </span>
            )}
          </Link>

          {/* User profile identity card & dropup menu */}
          <UserMenu variant="sidebar" collapsed={collapsed} onNavClick={handleNavClick} />

          {/* Version badge or expand toggle */}
          {collapsed ? (
            <button
              type="button"
              onClick={toggleCollapsed}
              title="展开侧边栏 (⌘B)"
              className="w-full flex items-center justify-center pt-2 text-[var(--aurora-fg4)] hover:text-[var(--aurora-fg1)] transition-colors"
              style={{ background: "transparent", border: "none", cursor: "pointer" }}
            >
              <Icon name="sidebar" size={14} />
            </button>
          ) : (
            <div
              style={{
                fontSize: 10.5,
                color: "var(--aurora-fg4)",
                textAlign: "center",
                paddingTop: 6,
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                letterSpacing: "0.03em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
            >
              <span>{appVersion}</span>
              {updateAvailable && (
                <button
                  type="button"
                  title={`发现新版本 ${updateAvailable}，点击检查更新`}
                  onClick={() => {
                    const d = desktop();
                    if (d?.checkForUpdates) {
                      void d.checkForUpdates();
                    }
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 2,
                    padding: "1px 5px",
                    borderRadius: 9999,
                    fontSize: 9,
                    background: "rgba(124, 58, 237, 0.15)",
                    color: "var(--aurora-accent, #7C3AED)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      backgroundColor: "var(--aurora-accent, #7C3AED)",
                    }}
                  />
                  <span>↑</span>
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

const SectionHeader = memo(function SectionHeader({
  label,
  collapsed = false,
  style,
}: {
  label: string;
  collapsed?: boolean;
  style?: React.CSSProperties;
}) {
  if (collapsed) {
    return (
      <div
        style={{
          height: 1,
          background: "var(--aurora-border)",
          margin: "8px 12px",
          opacity: 0.5,
          ...style,
        }}
      />
    );
  }

  return (
    <div
      style={{
        padding: "6px 14px 4px 16px",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--aurora-fg4)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        display: "flex",
        alignItems: "center",
        ...style,
      }}
    >
      {label}
    </div>
  );
});

const NavRow = memo(function NavRow({
  href,
  label,
  icon,
  active,
  badge,
  collapsed = false,
  onClick,
  onNavigate,
  onHover,
}: {
  href: string;
  label: string;
  icon: IconName;
  active: boolean;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  onNavigate?: (href: string) => void;
  onHover?: (href: string) => void;
}) {
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (onNavigate) {
      onNavigate(href);
    }
    if (onClick) {
      onClick();
    }
  };

  const handleMouseEnter = () => {
    if (onHover) {
      onHover(href);
    }
  };

  return (
    <Link
      href={href}
      prefetch={true}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onTouchStart={handleMouseEnter}
      title={label + (badge ? ` (${badge})` : "")}
      className={`group flex items-center relative select-none transition-colors duration-150 ${
        collapsed ? "justify-center py-2 px-0 mx-2 my-0.5" : "justify-start py-2 px-3.5 mx-2 my-0.5"
      } rounded-xl ${
        active
          ? "text-[var(--aurora-accent)] bg-[var(--aurora-accent-soft)] font-semibold"
          : "text-[var(--aurora-fg2)] hover:text-[var(--aurora-fg1)] hover:bg-[var(--aurora-chip)] font-normal"
      }`}
      style={{
        letterSpacing: "-0.01em",
        fontSize: 13,
        textDecoration: "none",
      }}
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Icon name={icon} size={16} color={active ? "var(--aurora-accent)" : undefined} />
        {collapsed && badge && (
          <span
            style={{
              position: "absolute",
              top: -5,
              right: -7,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: 9999,
              background: "var(--aurora-accent, #7C3AED)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1.5px solid var(--aurora-sidebar)",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
            }}
          >
            {badge}
          </span>
        )}
      </div>

      {!collapsed && (
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginLeft: 11 }}>
          {label}
        </span>
      )}

      {!collapsed && badge && (
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            padding: "1px 6px",
            borderRadius: 6,
            background: active ? "var(--aurora-accent)" : "rgba(124,58,237,0.14)",
            color: active ? "#fff" : "var(--aurora-accent)",
            letterSpacing: "0.02em",
          }}
        >
          {badge}
        </span>
      )}

      {active && !badge && !collapsed && (
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 9999,
            background: "var(--aurora-accent)",
            flexShrink: 0,
            marginLeft: 8,
          }}
        />
      )}
    </Link>
  );
});
