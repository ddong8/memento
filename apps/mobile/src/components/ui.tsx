import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { radius, useTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icon";

export function Button({
  children,
  onPress,
  variant = "primary",
  icon,
  disabled,
  busy,
  small,
}: {
  children?: ReactNode;
  onPress?: () => void;
  variant?: "primary" | "ghost" | "soft" | "danger";
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
}) {
  const t = useTheme();
  const bg =
    variant === "primary"
      ? t.accentPrimary
      : variant === "soft"
        ? t.accentSoft
        : variant === "danger"
          ? t.dangerSoft
          : "transparent";
  const fg =
    variant === "primary"
      ? t.onAccent
      : variant === "danger"
        ? t.danger
        : variant === "ghost"
          ? t.fg2
          : t.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: bg,
        borderRadius: radius.control,
        paddingHorizontal: small ? 12 : 16,
        paddingVertical: small ? 7 : 12,
        opacity: disabled ? 0.45 : pressed ? 0.84 : 1,
        transform: [{ scale: pressed && !disabled ? 0.985 : 1 }],
        borderWidth: variant === "ghost" ? 1 : 0,
        borderColor: t.borderStrong,
      })}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 14 : 16} color={fg} /> : null}
      {children != null && <Text style={{ color: fg, fontSize: small ? 13 : 14.5, fontWeight: "600" }}>{children}</Text>}
    </Pressable>
  );
}

export function Note({ children, tone = "danger" }: { children: ReactNode; tone?: "danger" | "warn" | "info" }) {
  const t = useTheme();
  const [bg, fg] = tone === "danger" ? [t.dangerSoft, t.danger] : tone === "warn" ? [t.warnSoft, t.warn] : [t.accentSoft, t.fg2];
  return (
    <View style={{ backgroundColor: bg, borderRadius: radius.control, padding: 12, marginBottom: 12 }}>
      <Text style={{ color: fg, fontSize: 13.5, lineHeight: 20 }}>{children}</Text>
    </View>
  );
}
