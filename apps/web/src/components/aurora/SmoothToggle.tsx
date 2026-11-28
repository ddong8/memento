"use client";

// Smooth modern iOS/Aurora style toggle switch
export function SmoothToggle({
  checked,
  onChange,
  disabled = false,
  size = "md",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const isSm = size === "sm";
  const w = isSm ? 38 : 46;
  const h = isSm ? 22 : 26;
  const dot = isSm ? 16 : 20;
  const off = 3;
  const on = w - dot - 3;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className="relative shrink-0 outline-none select-none cursor-pointer"
      style={{
        width: w,
        height: h,
        borderRadius: 9999,
        background: checked
          ? "var(--aurora-accent)"
          : "var(--aurora-chip, rgba(17, 17, 24, 0.08))",
        border: checked ? "1px solid transparent" : "1px solid var(--aurora-border-strong)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "background-color 200ms cubic-bezier(0.22, 1, 0.36, 1), border-color 200ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: (h - dot) / 2 - 1,
          left: checked ? on - 1 : off - 1,
          width: dot,
          height: dot,
          borderRadius: 9999,
          background: "#FFFFFF",
          boxShadow: "0 1px 3px rgba(0, 0, 0, 0.22)",
          transition: "left 220ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      />
    </button>
  );
}
