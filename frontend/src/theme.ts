// Dark cyberpunk / Firestorm-inspired theme for GridLink SL communicator.
// All color literals live here. Components read tokens via useTheme() / makeStyles.

import { useMemo } from "react";
import { Appearance, Platform, StyleSheet, useColorScheme } from "react-native";

export type ColorScheme = "light" | "dark";

const dark = {
  // Surfaces
  surface: "#050810",
  onSurface: "#E2E8F0",
  surfaceSecondary: "#0C1322",
  onSurfaceSecondary: "#B0BEC5",
  surfaceTertiary: "#141E30",
  onSurfaceTertiary: "#CFD8DC",
  surfaceInverse: "#00F0FF",
  onSurfaceInverse: "#050810",
  muted: "#64748B",

  // Brand
  brand: "#00F0FF",
  onBrand: "#050810",
  brandPrimary: "#00F0FF",
  onBrandPrimary: "#050810",
  brandSecondary: "#B026FF",
  onBrandSecondary: "#FFFFFF",
  brandTertiary: "#1A3B5C",
  onBrandTertiary: "#00F0FF",

  // Status
  success: "#00FF66",
  onSuccess: "#050810",
  warning: "#FFEA00",
  onWarning: "#050810",
  error: "#FF1744",
  onError: "#FFFFFF",
  info: "#29B6F6",
  onInfo: "#050810",

  // Lines
  border: "#1E2D4A",
  borderStrong: "#00F0FF",
  divider: "#121C2D",
};

export type ThemeColors = typeof dark;

export const defaultScheme = "dark" satisfies ColorScheme;

export const themes: { light?: ThemeColors; dark: ThemeColors } = { dark };

export const monoFont = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) as string;
export const displayFont = Platform.select({ ios: "Avenir Next", android: "sans-serif-medium", default: "System" }) as string;

export function setColorScheme(scheme: ColorScheme | null) {
  Appearance.setColorScheme?.(scheme);
}

setColorScheme?.(defaultScheme);

export function useTheme(): { scheme: ColorScheme; colors: ThemeColors } {
  const system = useColorScheme();
  const scheme: ColorScheme = "dark";
  return { scheme, colors: themes.dark };
}

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}

export const colors = dark;
