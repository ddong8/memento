"use client";

import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode } from "react";
import { Icon } from "./Icon";

/* ───────── Glass card ───────── */

interface GlassProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  padding?: number | string;
  radius?: number;
  hover?: boolean;
  onClick?: () => void;
  /** hex/rgba glow for hover shadow */
  accent?: string;
}

export function Glass({
  children, className, style, padding = 20, radius = 20, hover, onClick, accent,
}: GlassProps) {
  return (
    <div
      onClick={onClick}
      className={[
        "aurora-card",
        hover ? "aurora-card-hover" : "",
        onClick ? "cursor-pointer" : "",
        className ?? "",
      ].join(" ")}
      style={{
        padding,
        borderRadius: radius,
        ...(accent ? { ["--aurora-card-shadow-hover" as never]: `0 1px 0 0 rgba(255,255,255,0.5) inset, 0 12px 40px -12px ${accent}` } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ───────── Chip ───────── */

interface ChipProps {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warn" | "danger";
  icon?: Parameters<typeof Icon>[0]["name"];
  style?: CSSProperties;
  className?: string;
}

export function Chip({ children, tone = "neutral", icon, style, className }: ChipProps) {
  const toneStyle: CSSProperties = {
    neutral: { background: "var(--aurora-chip)", color: "var(--aurora-fg2)" },
    accent: { background: "var(--aurora-accent-soft)", color: "var(--aurora-accent)" },
    success: { background: "rgba(16,185,129,0.12)", color: "#10B981" },
    warn: { background: "rgba(245,158,11,0.14)", color: "#D97706" },
    danger: { background: "rgba(239,68,68,0.14)", color: "#DC2626" },
  }[tone];

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 10px",
        fontSize: 11,
        fontWeight: 500,
        borderRadius: 9999,
        letterSpacing: "-0.005em",
        ...toneStyle,
        ...style,
      }}
    >
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

/* ───────── Button ───────── */

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  children?: ReactNode;
  variant?: "primary" | "glass" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: Parameters<typeof Icon>[0]["name"];
  iconRight?: Parameters<typeof Icon>[0]["name"];
}

export function Btn({
  children, variant = "primary", size = "md", icon, iconRight, className = "", style, ...rest
}: BtnProps) {
  const sizeClass = size === "sm" ? "aurora-btn-sm" : size === "lg" ? "aurora-btn-lg" : "";
  const variantClass =
    variant === "glass" ? "aurora-btn-glass" :
    variant === "ghost" ? "aurora-btn-ghost" :
    variant === "danger" ? "aurora-btn-danger" : "";
  const iconSize = size === "sm" ? 13 : size === "lg" ? 16 : 14;

  return (
    <button
      {...rest}
      className={["aurora-btn", sizeClass, variantClass, className].filter(Boolean).join(" ")}
      style={style}
    >
      {icon && <Icon name={icon} size={iconSize} />}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </button>
  );
}

/* ───────── Input ───────── */

interface GhostInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  icon?: Parameters<typeof Icon>[0]["name"];
  wrapStyle?: CSSProperties;
  wrapClassName?: string;
}

export function GhostInput({ icon, wrapStyle, wrapClassName, className, style, ...rest }: GhostInputProps) {
  return (
    <label className={["aurora-input", wrapClassName ?? ""].join(" ")} style={wrapStyle}>
      {icon && <Icon name={icon} size={15} style={{ color: "var(--aurora-fg3)" }} />}
      <input {...rest} className={className} style={style} />
    </label>
  );
}

/* ───────── Section heading (tiny caps) ───────── */

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: "var(--aurora-fg3)",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        margin: "8px 4px 12px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ───────── Page top bar (big title + subtitle + right-slot) ───────── */

interface TopBarProps {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
}

export function TopBar({ title, subtitle, right }: TopBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        padding: "18px 0 22px",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: "clamp(22px, 3.2vw, 32px)",
            fontWeight: 600,
            color: "var(--aurora-fg1)",
            letterSpacing: "-0.03em",
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            style={{
              margin: "6px 0 0",
              fontSize: 14,
              color: "var(--aurora-fg3)",
              letterSpacing: "-0.01em",
            }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {right && <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>{right}</div>}
    </div>
  );
}

/* ───────── StatCard (compact numeric card) ───────── */

export function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  const num = typeof value === "number" ? value.toLocaleString() : value;
  return (
    <Glass padding={16} radius={18}>
      <p style={{ fontSize: 11, color: "var(--aurora-fg4)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
        {label}
      </p>
      <p style={{ fontSize: 26, fontWeight: 600, color: "var(--aurora-fg1)", letterSpacing: "-0.03em", lineHeight: 1 }}>
        {num}
      </p>
      {sub && (
        <p style={{ fontSize: 11, color: "var(--aurora-fg4)", marginTop: 4 }}>{sub}</p>
      )}
    </Glass>
  );
}

/* ───────── Theme toggle ───────── */

import { useTheme } from "@/lib/theme-context";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      aria-label="Toggle theme"
      title="Toggle theme"
      style={{
        width: 34,
        height: 34,
        borderRadius: "var(--aurora-radius-btn, 10px)",
        background: "var(--aurora-surface)",
        border: "1px solid var(--aurora-border)",
        backdropFilter: "var(--aurora-blur, none)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: "var(--aurora-fg2)",
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
    </button>
  );
}

/** Skin picker — three-segment control */
export function SkinPicker() {
  const { skin, setSkin } = useTheme();
  const items: { id: "aurora" | "arc" | "baseline"; label: string; hint: string }[] = [
    { id: "aurora", label: "Aurora", hint: "Violet · glass" },
    { id: "arc", label: "Arc", hint: "Paper · blue" },
    { id: "baseline", label: "Baseline", hint: "Classic" },
  ];
  return (
    <div
      style={{
        display: "inline-flex",
        padding: 3,
        gap: 2,
        background: "var(--aurora-chip)",
        border: "1px solid var(--aurora-border)",
        borderRadius: "var(--aurora-radius-btn, 10px)",
      }}
    >
      {items.map((it) => {
        const active = skin === it.id;
        return (
          <button
            key={it.id}
            onClick={() => setSkin(it.id)}
            title={it.hint}
            style={{
              padding: "5px 10px",
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "-0.005em",
              border: 0,
              cursor: "pointer",
              background: active ? "var(--aurora-surface-solid)" : "transparent",
              color: active ? "var(--aurora-accent)" : "var(--aurora-fg3)",
              borderRadius: 7,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.05)" : "none",
              transition: "all .15s",
            }}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
