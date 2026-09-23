import 'package:flutter/material.dart';

/// Light and dark themes for the tryveriqo console.

class AppTheme {
  static const Color brandTeal = Color(0xFF00BFA5);
  static const Color brandAmber = Color(0xFFFFAB00);
  static const Color brandRed = Color(0xFFEF5350);
  static const Color brandGreen = Color(0xFF66BB6A);

  static ThemeData get light => _build(Brightness.light);
  static ThemeData get dark => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorSchemeSeed: brandTeal,
    );

    return base.copyWith(
      scaffoldBackgroundColor: isDark
          ? const Color(0xFF10141A)
          : const Color(0xFFF7F9FB),
      cardTheme: base.cardTheme.copyWith(
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: base.colorScheme.surfaceContainerLow,
        selectedIconTheme: const IconThemeData(color: brandTeal, size: 22),
        indicatorColor: brandTeal.withValues(alpha: 0.16),
      ),
      extensions: const <ThemeExtension<dynamic>>[],
    );
  }

  /// Colour for an integrity severity band. Advisory signalling only.
  static Color severityColor(String severity) {
    switch (severity) {
      case 'critical':
        return brandRed;
      case 'high':
        return brandRed;
      case 'elevated':
      case 'medium':
        return brandAmber;
      case 'warning':
        return brandAmber;
      case 'low':
        return brandGreen;
      case 'nominal':
        return brandGreen;
      default:
        return brandTeal;
    }
  }
}
