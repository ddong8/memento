"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/aurora/Icon";

/** Avatar button + popup menu (profile / logout). Click outside to close. */
export function UserMenu() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  if (!user) return null;

  const initial = (user.name || user.email)[0]?.toUpperCase() || "?";
  const displayName = user.name || user.email;

  return (
    <div ref={ref} style={{ position: "relative" }}>
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
          background: "var(--aurora-primary-grad)",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          border: 0,
          boxShadow: open
            ? "0 0 0 2px color-mix(in srgb, var(--aurora-accent) 40%, transparent)"
            : "none",
          transition: "box-shadow .15s",
        }}
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 220,
            background: "var(--aurora-surface)",
            border: "1px solid var(--aurora-border)",
            borderRadius: 14,
            boxShadow: "0 16px 40px -12px rgba(0,0,0,0.25)",
            backdropFilter: "blur(24px) saturate(180%)",
            WebkitBackdropFilter: "blur(24px) saturate(180%)",
            padding: 6,
            zIndex: 50,
          }}
        >
          {/* Header: name + email + role chip */}
          <div
            style={{
              padding: "10px 12px 12px",
              borderBottom: "1px solid var(--aurora-border)",
              marginBottom: 4,
            }}
          >
            <div
              style={{
                fontSize: 14,
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
            {user.name && (
              <div
                style={{
                  fontSize: 11,
                  color: "var(--aurora-fg4)",
                  marginTop: 2,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={user.email}
              >
                {user.email}
              </div>
            )}
            <div
              style={{
                display: "inline-block",
                marginTop: 6,
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 9999,
                background: "var(--aurora-chip)",
                color: "var(--aurora-fg3)",
                fontWeight: 500,
              }}
            >
              {user.role}
            </div>
          </div>

          {/* Items */}
          <MenuLink href="/profile" icon="user" onClick={() => setOpen(false)}>
            {t.profile.title}
          </MenuLink>
          <MenuButton icon="log_out" onClick={() => { setOpen(false); logout(); }} tone="danger">
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
  href, icon, children, onClick,
}: {
  href: string; icon: "user" | "log_out"; children: React.ReactNode; onClick?: () => void;
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
  icon, children, onClick, tone = "default",
}: {
  icon: "user" | "log_out";
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
