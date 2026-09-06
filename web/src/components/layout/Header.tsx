"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { useDevice } from "@/lib/device-context";
import { useI18n, locales, type Locale } from "@/lib/i18n";
import { Icon, PlatformGlyph } from "@/components/aurora/Icon";
import { SkinPicker, ThemeToggle } from "@/components/aurora/primitives";
import { UserMenu } from "@/components/UserMenu";

export default function Header({ onMenuToggle }: { onMenuToggle: () => void }) {
  const { user } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const { devices, selectedDeviceId, setSelectedDeviceId } = useDevice();
  const selectedDevice = devices.find((d) => d.device_id === selectedDeviceId);

  return (
    <header
      className="h-14 flex items-center justify-between px-3 sm:px-4 md:px-6 fixed top-0 left-0 lg:left-60 right-0 z-20"
      style={{
        background: "var(--aurora-surface)",
        backdropFilter: "blur(20px) saturate(180%)",
        WebkitBackdropFilter: "blur(20px) saturate(180%)",
        borderBottom: "1px solid var(--aurora-border)",
      }}
    >
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        {/* Mobile menu */}
        <button
          onClick={onMenuToggle}
          aria-label="Menu"
          className="lg:hidden p-1"
          style={{ color: "var(--aurora-fg2)" }}
        >
          <Icon name="menu" size={22} />
        </button>

        {/* Device selector */}
        {devices.length > 0 && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 10px 5px 6px",
              background: "var(--aurora-surface)",
              border: "1px solid var(--aurora-border)",
              borderRadius: 10,
              boxShadow: "0 1px 0 rgba(255,255,255,0.5) inset",
              maxWidth: 220,
              minWidth: 0,
            }}
          >
            {selectedDevice ? (
              <PlatformGlyph name={selectedDevice.name} size={20} />
            ) : (
              <Icon name="devices" size={14} style={{ color: "var(--aurora-fg3)" }} />
            )}
            <select
              value={selectedDeviceId || "all"}
              onChange={(e) => setSelectedDeviceId(e.target.value === "all" ? null : e.target.value)}
              className="bg-transparent text-xs outline-none min-w-0 truncate"
              style={{
                color: "var(--aurora-fg1)",
                appearance: "none",
                border: 0,
                maxWidth: 160,
                cursor: "pointer",
              }}
            >
              <option value="all">{t.all} ({devices.length})</option>
              {devices.map((d) => {
                const shortName = d.name.replace(/ \(\w+\)$/, "");
                return (
                  <option key={d.device_id} value={d.device_id}>
                    {shortName}
                  </option>
                );
              })}
            </select>
            <Icon name="chevron_down" size={12} style={{ color: "var(--aurora-fg4)" }} />
          </div>
        )}

        {/* Quick Ask / Search trigger */}
        <button
          onClick={() => {
            const event = new KeyboardEvent("keydown", { key: "k", metaKey: true });
            window.dispatchEvent(event);
          }}
          className="hidden md:flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-xl transition-all"
          style={{
            background: "var(--aurora-input)",
            border: "1px solid var(--aurora-border)",
            color: "var(--aurora-fg3)",
            cursor: "pointer",
            minWidth: 160,
            maxWidth: 220,
            justifyContent: "space-between",
          }}
        >
          <span className="flex items-center gap-1.5 truncate">
            <Icon name="sparkles" size={13} style={{ color: "var(--aurora-brand-from)" }} />
            <span>{t.nav.ask || "问记忆"} · 搜索...</span>
          </span>
          <kbd
            style={{
              fontSize: 10,
              padding: "1px 4px",
              borderRadius: 4,
              background: "var(--aurora-chip)",
              border: "1px solid var(--aurora-border)",
              color: "var(--aurora-fg4)",
            }}
          >
            ⌘K
          </kbd>
        </button>

        {/* Language switcher */}
        <div className="hidden sm:flex gap-1">
          {(Object.keys(locales) as Locale[]).map((l) => {
            const active = locale === l;
            return (
              <button
                key={l}
                onClick={() => setLocale(l)}
                style={{
                  padding: "5px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: "-0.005em",
                  border: 0,
                  cursor: "pointer",
                  background: active ? "var(--aurora-accent-soft)" : "transparent",
                  color: active ? "var(--aurora-accent)" : "var(--aurora-fg3)",
                  transition: "all .15s",
                }}
              >
                {locales[l].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="hidden md:block"><SkinPicker /></div>
        <ThemeToggle />
        {user ? (
          <UserMenu />
        ) : (
          <Link
            href="/auth/login"
            style={{ fontSize: 13, color: "var(--aurora-accent)", fontWeight: 500, letterSpacing: "-0.01em" }}
          >
            {t.login}
          </Link>
        )}
      </div>
    </header>
  );
}
