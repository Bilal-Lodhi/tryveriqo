import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'providers/identity_provider.dart';
import 'providers/theme_provider.dart';
import 'screens/dashboard_screen.dart';
import 'screens/session_setup_screen.dart';
import 'services/api_client.dart';

/// Root widget. Shows candidate registration until a session exists, then the
/// reviewer console.

class AssessmentConsoleApp extends StatelessWidget {
  const AssessmentConsoleApp({required this.api, super.key});

  final ApiService api;

  @override
  Widget build(BuildContext context) {
    final themeProvider = context.watch<ThemeProvider>();
    final identity = context.watch<IdentityProvider>();

    return MaterialApp(
      title: 'tryveriqo console',
      debugShowCheckedModeBanner: false,
      theme: themeProvider.lightTheme,
      darkTheme: themeProvider.darkTheme,
      themeMode: themeProvider.themeMode,
      home: identity.isIdentified
          ? DashboardScreen(api: api)
          : const SessionSetupScreen(),
    );
  }
}
