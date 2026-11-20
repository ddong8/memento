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
      className="relative shrink-0 transition-all duration-300 outline-none select-none cursor-pointer"
      style={{
        width: w,
        height: h,
        borderRadius: 9999,
        background: checked
          ? "linear-gradient(135deg, #7C3AED 0%, #6366F1 100%)"
          : "var(--aurora-chip, rgba(0, 0, 0, 0.08))",
        boxShadow: checked
          ? "0 3px 10px -2px rgba(124, 58, 237, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.3)"
          : "inset 0 1px 2px rgba(0, 0, 0, 0.08)",
        border: checked ? "1px solid rgba(255, 255, 255, 0.2)" : "1px solid var(--aurora-border, rgba(0,0,0,0.08))",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
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
          boxShadow: "0 2px 5px rgba(0, 0, 0, 0.18), 0 0 1px rgba(0, 0, 0, 0.15)",
          transition: "left 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      />
    </button>
  );
}
