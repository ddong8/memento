import 'package:flutter/material.dart';

/// Aurora Design System - Colors matching the Memento Web UI
class AuroraColors {
  // Backgrounds
  static const Color bg = Color(0xFF080C14);
  static const Color bg2 = Color(0xFF0C1220);
  static const Color surface = Color(0xFF0F172A);
  static const Color surfaceSolid = Color(0xFF131D33);
  static const Color surfaceElevated = Color(0xFF1E293B);

  // Borders
  static const Color border = Color(0x1AFFFFFF); // rgba(255,255,255,0.10)
  static const Color borderStrong = Color(0x2EFFFFFF); // rgba(255,255,255,0.18)
  static const Color chip = Color(0x14FFFFFF); // rgba(255,255,255,0.08)

  // Accents & Brands
  static const Color accent = Color(0xFF38BDF8); // Sky 400
  static const Color accentHover = Color(0xFF0284C7); // Sky 600
  static const Color accentSoft = Color(0x2638BDF8); // rgba(56,189,248,0.15)
  static const Color brandFrom = Color(0xFF6366F1); // Indigo
  static const Color brandTo = Color(0xFF38BDF8); // Sky

  // Foreground / Typography
  static const Color fg1 = Color(0xFFF8FAFC); // Primary White
  static const Color fg2 = Color(0xFF94A3B8); // Muted Silver
  static const Color fg3 = Color(0xFF64748B); // Slate Grey
  static const Color fg4 = Color(0xFF475569); // Dark Slate

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
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          color: AuroraColors.fg1,
          fontSize: 20,
          fontWeight: FontWeight.bold,
          letterSpacing: -0.5,
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
