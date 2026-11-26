import type { ReactNode, RefObject } from "react";
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

export type MobileGlassMode = "solid" | "liquid-glass" | "ios-blur" | "android-blur";

/**
 * Pure platform resolver for native frosted / liquid glass surfaces:
 * - User disabled glass -> solid
 * - iOS 26+ with Liquid Glass API -> native GlassView (UIVisualEffectView Liquid Glass)
 * - iOS 16-25 -> native BlurView (systemChromeMaterial)
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
  blurTarget?: RefObject<View | null>;
  variant?: "tabbar" | "card";
  /** A small surface with text right behind it (the shrunk tab pill): a much denser tint, or the glass lens
   *  magnifies the words underneath into the icon */
  dense?: boolean;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function GlassSurface({
  enabled,
  dark,
  blurTarget,
  variant = "tabbar",
  dense = false,
  style,
  children,
}: GlassSurfaceProps) {
  const mode = resolveMobileGlassMode(Platform.OS, safeIsLiquidGlassAvailable(), enabled);
  const borderColor = dark ? "rgba(255, 255, 255, 0.14)" : "rgba(15, 15, 30, 0.09)";
  const specularTop = dark ? "rgba(255, 255, 255, 0.16)" : "rgba(255, 255, 255, 0.78)";

  if (mode === "solid") {
    return (
      <View
        style={[
          styles.base,
          {
            backgroundColor: dark ? "#161622" : "#FFFFFF",
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
    // Native iOS 26+ UIGlassEffect(.regular) provides its own optical Fresnel rim and
    // adaptive refraction. Use a delicate frost tint (never opaque 0.50 white) so icons
    // and labels stay legible even when dark cards or code blocks scroll behind the pill,
    // while outer drop shadows render on a separate wrapper (not clipped by overflow: hidden).
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme={dark ? "dark" : "light"}
        isInteractive={variant === "tabbar"}
        tintColor={
          dense
            ? (dark ? "rgba(20, 20, 30, 0.86)" : "rgba(255, 255, 255, 0.86)")
            : (dark ? "rgba(18, 18, 30, 0.24)" : "rgba(255, 255, 255, 0.22)")
        }
        style={[styles.liquidBase, style]}
      >
        {children}
      </GlassView>
    );
  }

  if (mode === "ios-blur") {
    return (
      <BlurView
        intensity={dark ? 72 : 82}
        tint={dark ? "systemChromeMaterialDark" : "systemChromeMaterialLight"}
        style={[styles.base, { borderColor }, style]}
      >
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: dense
                ? (dark ? "rgba(20, 20, 30, 0.86)" : "rgba(255, 255, 255, 0.86)")
                : (dark ? "rgba(18, 18, 28, 0.34)" : "rgba(255, 255, 255, 0.38)"),
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
      intensity={dark ? 68 : 78}
      tint={dark ? "dark" : "light"}
      style={[styles.base, { borderColor }, style]}
    >
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: dense
              ? (dark ? "rgba(20, 20, 30, 0.88)" : "rgba(255, 255, 255, 0.88)")
              : (dark ? "rgba(20, 20, 30, 0.56)" : "rgba(255, 255, 255, 0.66)"),
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
