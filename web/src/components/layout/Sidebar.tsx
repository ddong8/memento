"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth-context";
import { getApiBase, authFetch } from "@/lib/api-client";
import { Icon, ToolGlyph, PlatformGlyph } from "@/components/aurora/Icon";

interface SidebarDevice {
  device_id: string;
  name: string;
  total_files: number;
  tools: { id: string; file_count: number }[];
}

type IconName = Parameters<typeof Icon>[0]["name"];

export default function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { t } = useI18n();
  const { user } = useAuth();
  const [devices, setDevices] = useState<SidebarDevice[]>([]);

  useEffect(() => {
    const token = localStorage.getItem("dr_token");
    if (!token) return;
    authFetch(`${getApiBase()}/api/hierarchy/devices`)
      .then((r) => r.json())
      .then(setDevices)
      .catch(() => {});
  }, []);

  const handleNavClick = () => {
    if (typeof window !== "undefined" && window.innerWidth < 1024) onClose();
  };

  const pathParts = pathname.split("/");
  const currentDeviceId = pathParts[2] || "";
  const currentToolId = pathParts[4] || "";

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleDevice = (id: string) => setCollapsed((p) => ({ ...p, [id]: !p[id] }));
  const isCollapsed = (id: string) => {
    if (id in collapsed) return collapsed[id];
    return devices.length > 1 && id !== currentDeviceId;
  };

  const isAdmin = user?.role === "admin" || user?.role === "owner";
  const STATIC_NAV: { href: string; label: string; icon: IconName }[] = [
    { href: "/projects", label: t.nav.projects, icon: "folder" },
    { href: "/memory", label: t.nav.memory || "Memory", icon: "brain" },
    { href: "/daily", label: t.nav.daily, icon: "calendar" },
    { href: "/search", label: t.nav.search, icon: "search" },
    { href: "/devices", label: t.nav.devices, icon: "devices" },
    ...(isAdmin ? [{ href: "/admin", label: t.nav.admin, icon: "lock" as IconName }] : []),
  ];

  const OVERVIEW_HREF = "/app";

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={onClose} />}

      <aside
        className={[
          "fixed left-0 top-0 z-40 w-60 flex flex-col h-screen",
          "transition-transform duration-200 ease-in-out",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:!translate-x-0",
        ].join(" ")}
        style={{
          background: "var(--aurora-sidebar)",
          backdropFilter: "blur(24px) saturate(180%)",
          WebkitBackdropFilter: "blur(24px) saturate(180%)",
          borderRight: "1px solid var(--aurora-border)",
          color: "var(--aurora-fg2)",
        }}
      >
        {/* Brand */}
        <div className="px-4 pt-5 pb-3 flex items-center gap-3">
          <Link href="/app" onClick={handleNavClick} className="flex items-center gap-3 flex-1 min-w-0">
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 11,
                background: "var(--aurora-brand-grad)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 14px -4px rgba(124,58,237,0.5)",
                flexShrink: 0,
              }}
            >
              <Icon name="sparkles" size={17} style={{ color: "#fff" }} strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <div
                style={{
                  fontSize: 14,
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
              <div style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 1 }}>{t.app.subtitle}</div>
            </div>
          </Link>
          <button
            onClick={onClose}
            aria-label="Close"
            className="lg:hidden"
            style={{ color: "var(--aurora-fg3)", padding: 4 }}
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div style={{ height: 1, background: "var(--aurora-border)", margin: "0 16px" }} />

        <nav className="flex-1 overflow-y-auto py-2">
          {/* Overview link (dashboard) */}
          <NavRow
            href={OVERVIEW_HREF}
            label={t.nav.dashboard || "Overview"}
            icon="home"
            active={pathname === OVERVIEW_HREF}
            onClick={handleNavClick}
          />

          {/* Static nav */}
          {STATIC_NAV.map((item) => {
            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
            return <NavRow key={item.href} {...item} active={active} onClick={handleNavClick} />;
          })}

          {/* Device tree */}
          {devices.length > 0 && (
            <div style={{ height: 1, background: "var(--aurora-border)", margin: "10px 20px 4px" }} />
          )}

          {devices.map((device) => {
            const shortName = device.name.replace(/ \(\w+\)$/, "");
            const isCurrentDevice = device.device_id === currentDeviceId;
            const deviceCollapsed = isCollapsed(device.device_id);

            return (
              <div key={device.device_id} style={{ marginTop: 6 }}>
                <button
                  onClick={() => toggleDevice(device.device_id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 18px 6px 14px",
                    color: "var(--aurora-fg3)",
                    fontSize: 11,
                    fontWeight: 500,
                    letterSpacing: "-0.005em",
                    background: "transparent",
                    border: 0,
                    cursor: "pointer",
                  }}
                >
                  <PlatformGlyph name={device.name} size={18} />
                  <span
                    style={{
                      flex: 1,
                      textAlign: "left",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--aurora-fg2)",
                    }}
                  >
                    {shortName}
                  </span>
                  <span style={{ color: "var(--aurora-fg4)", fontSize: 11 }}>{device.total_files}</span>
                  <Icon
                    name="chevron_right"
                    size={11}
                    style={{
                      color: "var(--aurora-fg4)",
                      transform: deviceCollapsed ? "rotate(0)" : "rotate(90deg)",
                      transition: "transform .15s",
                    }}
                  />
                </button>

                {!deviceCollapsed && (
                  <div style={{ padding: "2px 0" }}>
                    {device.tools.map((tool) => {
                      const href = `/devices/${device.device_id}/tools/${tool.id}`;
                      const active = isCurrentDevice && tool.id === currentToolId;
                      return (
                        <ToolRow
                          key={tool.id}
                          href={href}
                          toolId={tool.id}
                          fileCount={tool.file_count}
                          active={active}
                          onClick={handleNavClick}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {devices.length === 0 && (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                fontSize: 12,
                color: "var(--aurora-fg4)",
              }}
            >
              {t.devices.noDevices}
            </div>
          )}
        </nav>

        <div className="p-3">
          <div
            style={{
              fontSize: 10.5,
              color: "var(--aurora-fg4)",
              textAlign: "center",
              padding: "6px 0",
            }}
          >
            {t.app.version}
          </div>
        </div>
      </aside>
    </>
  );
}

function NavRow({
  href, label, icon, active, onClick,
}: {
  href: string; label: string; icon: IconName; active: boolean; onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const color = active ? "var(--aurora-accent)" : hover ? "var(--aurora-fg1)" : "var(--aurora-fg2)";
  const bg = active ? "var(--aurora-accent-soft)" : hover ? "var(--aurora-chip)" : "transparent";
  return (
    <Link
      href={href}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        margin: "1px 10px",
        borderRadius: 12,
        color,
        background: bg,
        fontSize: 13.5,
        fontWeight: active ? 500 : 400,
        letterSpacing: "-0.01em",
        transition: "all .15s",
      }}
    >
      <Icon name={icon} size={16} />
      <span style={{ flex: 1 }}>{label}</span>
      {active && <span style={{ width: 5, height: 5, borderRadius: 9999, background: "var(--aurora-accent)" }} />}
    </Link>
  );
}

function ToolRow({
  href, toolId, fileCount, active, onClick,
}: {
  href: string; toolId: string; fileCount: number; active: boolean; onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const bg = active ? "var(--aurora-chip)" : hover ? "var(--aurora-chip)" : "transparent";
  const color = active || hover ? "var(--aurora-fg1)" : "var(--aurora-fg2)";
  return (
    <Link
      href={href}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 14px",
        margin: "1px 10px",
        borderRadius: 12,
        color,
        background: bg,
        transition: "all .15s",
      }}
    >
      <ToolGlyph id={toolId} size={20} />
      <span
        style={{
          flex: 1,
          fontSize: 13,
          textTransform: "capitalize",
          letterSpacing: "-0.01em",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {toolId.replace("_", " ")}
      </span>
      <span style={{ fontSize: 11, color: "var(--aurora-fg4)" }}>{fileCount}</span>
    </Link>
  );
}
