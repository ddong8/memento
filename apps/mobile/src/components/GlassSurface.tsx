import type { ReactNode, RefObject } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

export type MobileGlassMode = "solid" | "liquid-glass" | "ios-blur" | "android-blur";

/**
 * Pure platform resolver for native frosted / liquid glass surfaces:
 * - User disabled glass -> solid
 * - iOS 26+ with Liquid Glass API -> native GlassView (UIVisualEffectView Liquid Glass)
 * - iOS 16-25 -> native BlurView
 * - Android -> BlurView with dimezisBlurViewSdk31Plus (hardware blur on Android 12+, clean tint on <=11)
 */
export function resolveMobileGlassMode(
  platform: string,
  liquidGlassAvailable: boolean,
  enabled: boolean,
): MobileGlassMode {
  if (!enabled) return "solid";
  if (platform === "ios") {
    return liquidGlassAvailable ? "liquid-glass" : "ios-blur";
  }
  if (platform === "android") {
    return "android-blur";
  }
  return "solid";
}

/** Converts #RGB, #RRGGBB, or rgb()/rgba() to rgba(r, g, b, alpha) so native bars match web CSS tokens 1:1. */
export function withAlpha(color: string, alpha: number): string {
  const c = (color || "").trim();
  const hex3 = /^#([0-9a-f]{3})$/i.exec(c);
  if (hex3) {
    const [r, g, b] = hex3[1].split("").map((ch) => parseInt(ch + ch, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hex6 = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex6) {
    const n = parseInt(hex6[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c);
  if (rgb) {
    return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  }
  return c;
}

function safeIsLiquidGlassAvailable(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return Boolean(isLiquidGlassAvailable());
  } catch {
    return false;
  }
}

export interface GlassSurfaceProps {
  enabled: boolean;
  dark: boolean;
  /** Exact surface color synced from web `--aurora-surface-solid` so bottom tab bar matches top bar & composer. */
  surfaceColor?: string;
  /** Exact border color synced from web `--aurora-border-strong`. */
  borderColor?: string;
  blurTarget?: RefObject<View | null>;
  variant?: "tabbar" | "card";
  /** A small surface with text right behind it (the shrunk tab pill): denser veil so text underneath stays clean. */
  dense?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function GlassSurface({
  enabled,
  dark,
  surfaceColor,
  borderColor: borderProp,
  blurTarget,
  variant = "tabbar",
  dense = false,
  style,
  children,
}: GlassSurfaceProps) {
  const mode = resolveMobileGlassMode(Platform.OS, safeIsLiquidGlassAvailable(), enabled);
  const baseSurface = surfaceColor || (dark ? "#15131F" : "#FFFFFF");
  const borderColor = borderProp || (dark ? "rgba(255, 255, 255, 0.14)" : "rgba(24, 18, 42, 0.145)");
  const specularTop = dark ? "rgba(255, 255, 255, 0.10)" : "rgba(255, 255, 255, 0.85)";
  const veilAlpha = dense ? 0.98 : 0.96;
  const surfaceVeil = withAlpha(baseSurface, veilAlpha);

  if (mode === "solid") {
    return (
      <View
        style={[
          styles.base,
          {
            backgroundColor: baseSurface,
            borderColor,
          },
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  if (mode === "liquid-glass") {
    // Use `clear` (not `regular`) + a calibrated inner surface veil matching `--aurora-surface-solid`:
    // Apple's UIGlassEffect(.regular) desaturates & shifts high-opacity tintColor toward neutral grey,
    // which clashed visibly with the crisp top bar and solid composer card right above the tab bar.
    // Mounting the veil inside GlassView's contentView keeps native iOS 26 press interaction & rounded
    // continuous corner clipping while locking exact color parity across all skins and light/dark themes.
    return (
      <GlassView
        glassEffectStyle="clear"
        colorScheme={dark ? "dark" : "light"}
        isInteractive={variant === "tabbar"}
        tintColor={withAlpha(baseSurface, 0.92)}
        style={[styles.base, { borderColor }, style]}
      >
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: surfaceVeil,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: specularTop,
            },
          ]}
        />
        {children}
      </GlassView>
    );
  }

  if (mode === "ios-blur") {
    return (
      <BlurView
        intensity={dark ? 60 : 70}
        tint={dark ? "dark" : "light"}
        style={[styles.base, { borderColor }, style]}
      >
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: surfaceVeil,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: specularTop,
            },
          ]}
        />
        {children}
      </BlurView>
    );
  }

  return (
    <BlurView
      blurTarget={blurTarget}
      blurMethod="dimezisBlurViewSdk31Plus"
      blurReductionFactor={4}
      intensity={dark ? 60 : 70}
      tint={dark ? "dark" : "light"}
      style={[styles.base, { borderColor }, style]}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: surfaceVeil,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: specularTop,
          },
        ]}
      />
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  liquidBase: {
    overflow: "hidden",
  },
  base: {
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
});
