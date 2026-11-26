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
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}

export function GlassSurface({
  enabled,
  dark,
  blurTarget,
  variant = "tabbar",
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
    // adaptive translucency. Avoid painting an opaque white/dark tintColor or muddy gray
    // border on top of it, and render drop shadows on an outer wrapper (never clipped by
    // overflow: "hidden").
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme={dark ? "dark" : "light"}
        isInteractive={variant === "tabbar"}
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
              backgroundColor: dark ? "rgba(18, 18, 28, 0.34)" : "rgba(255, 255, 255, 0.38)",
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
            backgroundColor: dark ? "rgba(20, 20, 30, 0.56)" : "rgba(255, 255, 255, 0.66)",
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
