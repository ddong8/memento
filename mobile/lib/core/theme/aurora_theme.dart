import 'package:flutter/material.dart';

/// Aurora Design System - Colors matching the Memento Web UI
class AuroraColors {
  // Backgrounds
  // Neutral graphite rather than saturated navy: surfaces separate by tone, so
  // cards don't need heavy outlines to read as cards.
  static const Color bg = Color(0xFF0B0E14);
  static const Color bg2 = Color(0xFF10141B);
  static const Color surface = Color(0xFF12161E);
  static const Color surfaceSolid = Color(0xFF161B24);
  static const Color surfaceElevated = Color(0xFF1D2330);

  // Borders
  static const Color border = Color(0x12FFFFFF); // rgba(255,255,255,0.07)
  static const Color borderStrong = Color(0x24FFFFFF); // rgba(255,255,255,0.14)
  static const Color chip = Color(0x0FFFFFFF); // rgba(255,255,255,0.06)

  // Accents & Brands
  static const Color accent = Color(0xFF38BDF8); // Sky 400
  static const Color accentHover = Color(0xFF0284C7); // Sky 600
  static const Color accentSoft = Color(0x2638BDF8); // rgba(56,189,248,0.15)
  static const Color brandFrom = Color(0xFF6366F1); // Indigo
  static const Color brandTo = Color(0xFF38BDF8); // Sky

  // Foreground / Typography
  static const Color fg1 = Color(0xFFF8FAFC); // Primary White
  static const Color fg2 = Color(0xFF94A3B8); // Muted Silver
  static const Color fg3 = Color(0xFF7B879C); // Slate Grey (≥4.5:1 on bg for small text)
  static const Color fg4 = Color(0xFF56637A); // Dark Slate

  // Status
  static const Color success = Color(0xFF10B981);
  static const Color successSoft = Color(0x2610B981);
  static const Color warn = Color(0xFFF59E0B);
  static const Color warnSoft = Color(0x26F59E0B);
  static const Color danger = Color(0xFFEF4444);
  static const Color dangerSoft = Color(0x26EF4444);

  // Gradients
  static const LinearGradient brandGradient = LinearGradient(
    colors: [Color(0xFF6366F1), Color(0xFF38BDF8)],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );

  static const LinearGradient glassCardGradient = LinearGradient(
    colors: [
      Color(0x1FFFFFFF),
      Color(0x0AFFFFFF),
    ],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );
}

class AuroraTheme {
  static const List<String> monospaceFontFamilyFallback = [
    'JetBrains Mono',
    'Fira Code',
    'Cascadia Code',
    'SF Mono',
    'Menlo',
    'Consolas',
    'Courier New',
    'monospace',
  ];

  static const List<String> defaultFontFamilyFallback = [
    'Inter',
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'PingFang SC',
    'Hiragino Sans GB',
    'Microsoft YaHei',
    'sans-serif',
  ];

  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AuroraColors.bg,
      colorScheme: const ColorScheme.dark(
        primary: AuroraColors.accent,
        secondary: AuroraColors.brandFrom,
        surface: AuroraColors.surface,
        error: AuroraColors.danger,
        onPrimary: Colors.black,
        onSurface: AuroraColors.fg1,
      ),
      fontFamily: 'SF Pro Display',
      fontFamilyFallback: defaultFontFamilyFallback,
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleSpacing: 20,
        titleTextStyle: TextStyle(
          color: AuroraColors.fg1,
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.3,
        ),
        iconTheme: IconThemeData(color: AuroraColors.fg2),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AuroraColors.surface,
        selectedItemColor: AuroraColors.accent,
        unselectedItemColor: AuroraColors.fg3,
        type: BottomNavigationBarType.fixed,
        elevation: 10,
        selectedLabelStyle: TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
        unselectedLabelStyle: TextStyle(fontSize: 11, fontWeight: FontWeight.w500),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: AuroraColors.chip,
        hintStyle: const TextStyle(color: AuroraColors.fg3, fontSize: 13.5),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AuroraColors.border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AuroraColors.border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: AuroraColors.accent, width: 1.5),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AuroraColors.fg1,
          side: const BorderSide(color: AuroraColors.borderStrong),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        ),
      ),
      elevatedButtonTheme: ElevatedButtonThemeData(
        style: ElevatedButton.styleFrom(
          backgroundColor: AuroraColors.accent,
          foregroundColor: Colors.black,
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
        ),
      ),
    );
  }
}
