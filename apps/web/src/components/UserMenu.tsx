"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { useAuth } from "@/lib/auth-context";
import { useI18n, locales, type Locale } from "@/lib/i18n";
import { useTheme, type Skin } from "@/lib/theme-context";
import { Icon } from "@/components/aurora/Icon";
import { useIsDesktopApp } from "@/hooks/useClientEnv";
import { openServerSwitchModal } from "@/lib/api-client";

type IconName = Parameters<typeof Icon>[0]["name"];

interface UserMenuProps {
  variant?: "sidebar" | "header";
  collapsed?: boolean;
  onNavClick?: () => void;
}

/**
 * User Identity Card & Menu.
 * - In 'sidebar' mode: Renders a sleek full-width profile card with avatar, name, role and dropup menu.
 * - In 'header' mode: Renders a compact circular avatar button with dropdown menu.
 */
export function UserMenu({ variant = "sidebar", collapsed = false, onNavClick }: UserMenuProps) {
  const { user, logout } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { skin, setSkin, glass, setGlass } = useTheme();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isDesktop = useIsDesktopApp();
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const handleItemClick = () => {
    setOpen(false);
    onNavClick?.();
  };

  // The desktop app showed this as a system menu (317a187c): 20-odd plain rows with greyed headings
  // for language and skin, which can't be styled. Every client now opens the same panel.
  const toggleMenu = (el: Element) => {
    setAnchor(el);
    setOpen((v) => !v);
  };

  if (!user) {
    if (variant === "sidebar") {
      return (
        <Link
          href="/auth/login"
          onClick={onNavClick}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            borderRadius: 12,
            background: "var(--aurora-chip)",
            border: "1px solid var(--aurora-border)",
            color: "var(--aurora-accent)",
            fontSize: 13,
            fontWeight: 500,
            textDecoration: "none",
            transition: "all .15s",
          }}
        >
          <Icon name="user" size={16} />
          <span>{t.login || "登录账号"}</span>
        </Link>
      );
    }
    return (
      <Link
        href="/auth/login"
        style={{ fontSize: 13, color: "var(--aurora-accent)", fontWeight: 500, letterSpacing: "-0.01em" }}
      >
        {t.login}
      </Link>
    );
  }

  const initial = (user.name || user.email)[0]?.toUpperCase() || "?";
  const displayName = user.name || user.email;
  const isAdmin = user.role === "admin" || user.role === "owner";
  const isProfileActive = pathname === "/profile" || pathname.startsWith("/profile");

  return (
    <div ref={ref} style={{ position: "relative", width: variant === "sidebar" ? "100%" : "auto" }}>
      {variant === "sidebar" ? (
        /* Sidebar User Card Trigger */
        <button
          type="button"
          onClick={(e) => toggleMenu(e.currentTarget)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          aria-label={t.profile.title}
          aria-expanded={open}
          aria-haspopup="menu"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            gap: 10,
            width: "100%",
            padding: collapsed ? "7px 0" : "7px 10px",
            borderRadius: 12,
            background: open
              ? "var(--aurora-chip)"
              : isProfileActive
              ? "var(--aurora-accent-soft)"
              : hovered
              ? "var(--aurora-chip)"
              : "transparent",
            border: open
              ? "1px solid color-mix(in srgb, var(--aurora-accent) 30%, var(--aurora-border))"
              : isProfileActive
              ? "1px solid color-mix(in srgb, var(--aurora-accent) 25%, transparent)"
              : "1px solid transparent",
            color: "var(--aurora-fg1)",
            cursor: "pointer",
            textAlign: "left",
            transition: "all .15s ease",
            outline: "none",
          }}
        >
          {/* Avatar with Online Indicator */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 9999,
                overflow: "hidden",
                background: "var(--aurora-primary-grad)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 13,
                fontWeight: 600,
                border: "1px solid var(--aurora-border)",
                boxShadow: "0 2px 8px -2px rgba(0,0,0,0.15)",
              }}
            >
              {user.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatar_url}
                  alt={displayName}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                initial
              )}
            </div>
            <span
              style={{
                position: "absolute",
                bottom: -1,
                right: -1,
                width: 8,
                height: 8,
                borderRadius: 9999,
                background: "#10B981",
                border: "2px solid var(--aurora-sidebar)",
              }}
              title="在线"
            />
          </div>

          {/* User Details */}
          {!collapsed && (
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: isProfileActive ? "var(--aurora-accent)" : "var(--aurora-fg1)",
                  letterSpacing: "-0.01em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  lineHeight: 1.3,
                }}
                title={displayName}
              >
                {displayName}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  marginTop: 2,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--aurora-fg4)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 90,
                  }}
                  title={user.email}
                >
                  {user.email || user.role}
                </span>
                <span
                  style={{
                    fontSize: 9,
                    lineHeight: 1,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: "var(--aurora-chip)",
                    color: "var(--aurora-fg3)",
                    border: "1px solid var(--aurora-border)",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {roleLabel(user.role)}
                </span>
              </div>
            </div>
          )}

          {/* Action icon (settings / chevron) */}
          {!collapsed && (
            <div
              style={{
                color: "var(--aurora-fg4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transform: open ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform .2s ease",
              }}
            >
              <Icon name="chevron_up" size={14} />
            </div>
          )}
        </button>
      ) : (
        /* Header Compact Avatar Trigger */
        <button
          type="button"
          onClick={(e) => toggleMenu(e.currentTarget)}
          aria-label={t.profile.title}
          aria-expanded={open}
          aria-haspopup="menu"
          style={{
            width: 32,
            height: 32,
            borderRadius: 9999,
            overflow: "hidden",
            background: "var(--aurora-primary-grad)",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            border: "1px solid var(--aurora-border)",
            padding: 0,
            boxShadow: open
              ? "0 0 0 2px color-mix(in srgb, var(--aurora-accent) 40%, transparent)"
              : "none",
            transition: "box-shadow .15s",
          }}
        >
          {user.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.avatar_url}
              alt={displayName}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            initial
          )}
        </button>
      )}

      {open && (
        <UserMenuPanel
          anchor={anchor}
          variant={variant}
          collapsed={collapsed}
          panelRef={panelRef}
          user={user}
          displayName={displayName}
          initial={initial}
          isAdmin={isAdmin}
          isDesktop={isDesktop}
          onNav={handleItemClick}
          onServer={() => {
            setOpen(false);
            openServerSwitchModal();
          }}
          onLogout={() => {
            setOpen(false);
            logout();
          }}
          lang={{ value: locale, options: (Object.keys(locales) as Locale[]).map((l) => ({ id: l, label: locales[l].label })), onChange: (v) => setLocale(v as Locale) }}
          look={{ value: skin, options: SKINS, onChange: (v) => setSkin(v as Skin) }}
          glass={{ value: glass ? "on" : "off", options: GLASS_OPTIONS, onChange: (v) => setGlass(v === "on") }}
          labels={{
            settings: t.profile.title || "个人设置",
            devices: t.profile.tabs?.devices || "我的设备",
            health: t.profile.tabs?.health || "系统健康",
            collector: t.profile.tabs?.collector || "本机采集",
            admin: t.nav.admin || "管理后台",
            server: t.serverSwitch?.title || "切换服务器",
            logout: t.profile.logout,
          }}
        />
      )}
    </div>
  );
}

/** Roles in plain words: "owner" read as an untranslated leftover. */
export function roleLabel(role: string | undefined): string {
  return ({ owner: "所有者", admin: "管理员", member: "成员", user: "成员", viewer: "只读" } as Record<string, string>)[role || ""] || role || "";
}

const SKINS: { id: Skin; label: string }[] = [
  { id: "aurora", label: "极光" },
  { id: "arc", label: "纸感" },
  { id: "baseline", label: "经典" },
];

const GLASS_OPTIONS: { id: string; label: string }[] = [
  { id: "on", label: "开启" },
  { id: "off", label: "关闭" },
];

/** A setting picked in place: its name, then a small segmented control. */
function SegmentRow({ label, value, options, onChange }: { label: string; value: string; options: { id: string; label: string }[]; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <span style={{ fontSize: 12, color: "var(--aurora-fg2)", fontWeight: 500 }}>{label}</span>
      <div style={{ display: "inline-flex", padding: 2, gap: 2, background: "color-mix(in srgb, var(--aurora-fg1) 6%, transparent)", borderRadius: 8 }}>
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              style={{
                padding: "3px 9px",
                fontSize: 11.5,
                fontWeight: active ? 600 : 500,
                border: 0,
                borderRadius: 6,
                cursor: "pointer",
                background: active ? "var(--aurora-surface-solid)" : "transparent",
                color: active ? "var(--aurora-fg1)" : "var(--aurora-fg3)",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface Segment {
  value: string;
  options: { id: string; label: string }[];
  onChange: (id: string) => void;
}

const PANEL_WIDTH = 288;
const GAP = 8;

/** Where the panel goes: above the sidebar card (beside it when the sidebar is collapsed), below the header avatar. */
export function panelPosition(
  r: { left: number; right: number; top: number; bottom: number },
  variant: "sidebar" | "header",
  collapsed: boolean,
  vw: number,
  vh: number,
): React.CSSProperties {
  const width = Math.min(PANEL_WIDTH, vw - GAP * 2);
  const clampLeft = (x: number) => Math.max(GAP, Math.min(x, vw - width - GAP));
  if (variant === "header") return { top: r.bottom + GAP, left: clampLeft(r.right - width), width };
  if (collapsed) return { bottom: Math.max(GAP, vh - r.bottom), left: clampLeft(r.right + GAP), width };
  return { bottom: vh - r.top + GAP, left: clampLeft(r.left), width };
}

function Avatar({ url, name, initial, size }: { url?: string | null; name: string; initial: string; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 9999,
        overflow: "hidden",
        flexShrink: 0,
        background: "var(--aurora-primary-grad)",
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.4),
        fontWeight: 600,
        boxShadow: "0 0 0 2px var(--aurora-surface-solid), 0 0 0 3.5px color-mix(in srgb, var(--aurora-accent) 35%, transparent)",
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        initial
      )}
    </div>
  );
}

function UserMenuPanel({
  anchor,
  variant,
  collapsed,
  panelRef,
  user,
  displayName,
  initial,
  isAdmin,
  isDesktop,
  onNav,
  onServer,
  onLogout,
  lang,
  look,
  glass,
  labels,
}: {
  anchor: Element | null;
  variant: "sidebar" | "header";
  collapsed: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  user: { email: string; role: string; avatar_url?: string | null };
  displayName: string;
  initial: string;
  isAdmin: boolean;
  isDesktop: boolean;
  onNav: () => void;
  onServer: () => void;
  onLogout: () => void;
  lang: Segment;
  look: Segment;
  glass: Segment;
  labels: Record<"settings" | "devices" | "health" | "collector" | "admin" | "server" | "logout", string>;
}) {
  const [pos, setPos] = useState<React.CSSProperties | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const place = () => {
      if (!anchor) return;
      setPos(panelPosition(anchor.getBoundingClientRect(), variant, collapsed, window.innerWidth, window.innerHeight));
    };
    place();
    const raf = requestAnimationFrame(() => setShown(true));
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
    };
  }, [anchor, variant, collapsed]);

  if (!pos || typeof document === "undefined") return null;

  const tiles: { href: string; icon: IconName; label: string }[] = [
    { href: "/profile?tab=proactive", icon: "sparkles", label: "AI 执事" },
    { href: "/profile?tab=life", icon: "clock", label: "作息与时间" },
    { href: "/profile?tab=devices", icon: "devices", label: labels.devices },
    { href: "/profile?tab=health", icon: "activity", label: labels.health },
    ...(isDesktop ? [{ href: "/profile?tab=collector", icon: "terminal" as IconName, label: labels.collector }] : []),
    ...(isAdmin ? [{ href: "/admin", icon: "lock" as IconName, label: labels.admin }] : []),
  ];
  const fromBelow = variant === "sidebar";
  const maxHeight =
    pos.bottom !== undefined
      ? `calc(100dvh - ${Number(pos.bottom) + GAP}px)`
      : `calc(100dvh - ${Number(pos.top ?? 0) + GAP}px - var(--memento-tabbar-inset, 0px))`;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={labels.settings}
      className="memento-glass-chrome"
      style={{
        position: "fixed",
        ...pos,
        maxHeight,
        overflowY: "auto",
        overscrollBehavior: "contain",
        zIndex: 1000,
        background: "var(--aurora-surface-solid)",
        border: "1px solid var(--aurora-border)",
        borderRadius: 16,
        boxShadow: "0 24px 56px -18px rgba(15, 10, 40, 0.38), 0 4px 14px -6px rgba(15, 10, 40, 0.12)",
        padding: 8,
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : `translateY(${fromBelow ? 6 : -6}px) scale(0.98)`,
        transformOrigin: fromBelow ? "bottom left" : "top right",
        transition: "opacity 140ms ease-out, transform 180ms cubic-bezier(0.2, 0.9, 0.3, 1.1)",
      }}
    >
      {/* Who is signed in; the card itself opens the settings */}
      <Link
        href="/profile"
        role="menuitem"
        onClick={onNav}
        className="um-hover"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px 12px",
          borderRadius: 12,
          textDecoration: "none",
          background: "var(--aurora-accent-soft)",
        }}
      >
        <Avatar url={user.avatar_url} name={displayName} initial={initial} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <span
              style={{ fontSize: 14, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={displayName}
            >
              {displayName}
            </span>
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                lineHeight: "16px",
                padding: "0 6px",
                borderRadius: 9999,
                background: "color-mix(in srgb, var(--aurora-accent) 14%, transparent)",
                color: "var(--aurora-accent)",
                fontWeight: 600,
              }}
            >
              {roleLabel(user.role)}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--aurora-fg3)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.email}>
            {user.email}
          </div>
        </div>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: 11, color: "var(--aurora-fg3)", flexShrink: 0 }}>
          <Icon name="settings" size={13} />
          <Icon name="chevron_right" size={12} />
        </span>
      </Link>

      {/* Shortcuts */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginTop: 8 }}>
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            role="menuitem"
            onClick={onNav}
            className="um-hover"
            style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", borderRadius: 10, textDecoration: "none", color: "var(--aurora-fg1)", minWidth: 0 }}
          >
            <span
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--aurora-chip)",
                border: "1px solid var(--aurora-border)",
                color: "var(--aurora-accent)",
              }}
            >
              <Icon name={tile.icon} size={15} />
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tile.label}</span>
          </Link>
        ))}
      </div>

      {/* Appearance */}
      <div style={{ margin: "8px 0 0", padding: "10px 10px 8px", borderRadius: 12, background: "var(--aurora-chip)", display: "grid", gap: 8 }}>
        <SegmentRow label="界面语言" {...lang} />
        <SegmentRow label="界面风格" {...look} />
        <SegmentRow label="毛玻璃质感" {...glass} />
      </div>

      {/* Account */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
        <button type="button" role="menuitem" onClick={onServer} className="um-btn" style={footBtn("var(--aurora-fg2)")}>
          <Icon name="server" size={14} />
          {labels.server}
        </button>
        <button type="button" role="menuitem" onClick={onLogout} className="um-btn um-danger" style={footBtn("#DC2626")}>
          <Icon name="log_out" size={14} />
          {labels.logout}
        </button>
      </div>
      <style>{`
        .um-hover { transition: background-color .12s ease; }
        .um-hover:hover { background-color: var(--aurora-chip) !important; }
        .um-hover:focus-visible, .um-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--aurora-accent) 55%, transparent); outline-offset: 1px; }
        .um-btn { transition: background-color .12s ease, border-color .12s ease; }
        .um-btn:hover { background-color: var(--aurora-chip); }
        .um-danger:hover { background-color: rgba(220, 38, 38, 0.08); border-color: rgba(220, 38, 38, 0.28); }
        html[data-theme="dark"] .um-danger { color: #F87171 !important; }
      `}</style>
    </div>,
    document.body,
  );
}

function footBtn(color: string): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 34,
    borderRadius: 10,
    border: "1px solid var(--aurora-border)",
    background: "transparent",
    color,
    fontSize: 12.5,
    fontWeight: 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
