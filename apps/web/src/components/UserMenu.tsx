"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";
import { desktop } from "@/lib/desktop";

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
  const { t } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (desktop()) setIsDesktop(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
          onClick={() => setOpen((v) => !v)}
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
                    textTransform: "uppercase",
                  }}
                >
                  {user.role}
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
          onClick={() => setOpen((v) => !v)}
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

      {/* Dropup (for sidebar) or Dropdown (for header) Menu */}
      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            ...(variant === "sidebar"
              ? {
                  bottom: "calc(100% + 8px)",
                  left: 0,
                  width: "100%",
                  minWidth: 236,
                }
              : {
                  top: "calc(100% + 8px)",
                  right: 0,
                  minWidth: 230,
                }),
            background: "var(--aurora-surface)",
            border: "1px solid var(--aurora-border)",
            borderRadius: 14,
            boxShadow: "0 20px 48px -12px rgba(0,0,0,0.35), 0 0 0 1px var(--aurora-border)",
            backdropFilter: "blur(24px) saturate(180%)",
            WebkitBackdropFilter: "blur(24px) saturate(180%)",
            padding: 6,
            zIndex: 60,
          }}
        >
          {/* Header Profile Summary */}
          <div
            style={{
              padding: "10px 12px 12px",
              borderBottom: "1px solid var(--aurora-border)",
              marginBottom: 4,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9999,
                overflow: "hidden",
                background: "var(--aurora-primary-grad)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 600,
                flexShrink: 0,
                border: "1px solid var(--aurora-border)",
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
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--aurora-fg1)",
                  letterSpacing: "-0.01em",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={displayName}
              >
                {displayName}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--aurora-fg4)",
                  marginTop: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={user.email}
              >
                {user.email}
              </div>
              <div
                style={{
                  display: "inline-block",
                  marginTop: 4,
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 9999,
                  background: "var(--aurora-chip)",
                  color: "var(--aurora-fg3)",
                  fontWeight: 500,
                }}
              >
                {user.role}
              </div>
            </div>
          </div>

          {/* Quick shortcuts */}
          <MenuLink href="/profile?tab=proactive" icon="sparkles" onClick={handleItemClick}>
            AI 执事
          </MenuLink>
          <MenuLink href="/profile?tab=life" icon="clock" onClick={handleItemClick}>
            作息与时间
          </MenuLink>
          <MenuLink href="/profile" icon="settings" onClick={handleItemClick}>
            {t.profile.title || "个人设置"}
          </MenuLink>
          <MenuLink href="/profile?tab=devices" icon="devices" onClick={handleItemClick}>
            {t.profile.tabs?.devices || "我的设备"}
          </MenuLink>
          <MenuLink href="/profile?tab=health" icon="activity" onClick={handleItemClick}>
            {t.profile.tabs?.health || "系统健康"}
          </MenuLink>
          {isDesktop && (
            <MenuLink href="/profile?tab=collector" icon="terminal" onClick={handleItemClick}>
              {t.profile.tabs?.collector || "本机采集"}
            </MenuLink>
          )}

          {isAdmin && (
            <>
              <div style={{ height: 1, background: "var(--aurora-border)", margin: "4px 8px" }} />
              <MenuLink href="/admin" icon="lock" onClick={handleItemClick}>
                {t.nav.admin || "管理后台"}
              </MenuLink>
            </>
          )}

          <div style={{ height: 1, background: "var(--aurora-border)", margin: "4px 8px" }} />

          <MenuButton
            icon="log_out"
            onClick={() => {
              setOpen(false);
              logout();
            }}
            tone="danger"
          >
            {t.profile.logout}
          </MenuButton>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 13,
  textDecoration: "none",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  textAlign: "left",
  transition: "background .1s",
};

function MenuLink({
  href,
  icon,
  children,
  onClick,
}: {
  href: string;
  icon: IconName;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      style={{ ...menuItemStyle, color: "var(--aurora-fg1)" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--aurora-chip)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={icon} size={15} />
      {children}
    </Link>
  );
}

function MenuButton({
  icon,
  children,
  onClick,
  tone = "default",
}: {
  icon: IconName;
  children: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  const color = tone === "danger" ? "#DC2626" : "var(--aurora-fg1)";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ ...menuItemStyle, color }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--aurora-chip)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={icon} size={15} />
      {children}
    </button>
  );
}
