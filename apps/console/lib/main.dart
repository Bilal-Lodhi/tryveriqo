/// Entry point for the Assessment review console.
///
/// Build-time configuration:
///   `--dart-define=API_BASE_URL=http://localhost:8080`
///   `--dart-define=API_TOKEN=<operator token>` (optional; required for
///   generation and cohort review)
///
/// The operator token is compiled into the bundle, so it must never be a real
/// production secret for a publicly hosted console. See docs/security.
library;

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'providers/health_provider.dart';
import 'providers/identity_provider.dart';
import 'providers/integrity_provider.dart';
import 'providers/review_provider.dart';
import 'providers/theme_provider.dart';
import 'services/api_client.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  const apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://localhost:8080',
  );
  const operatorToken = String.fromEnvironment('API_TOKEN');

  final api = ApiService(baseUrl: apiBaseUrl, operatorToken: operatorToken);

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ThemeProvider()),
        ChangeNotifierProvider(create: (_) => HealthProvider(api)),
        ChangeNotifierProvider(create: (_) => ReviewProvider(api)),
        ChangeNotifierProvider(create: (_) => IntegrityProvider(api)),
        ChangeNotifierProvider(create: (_) => IdentityProvider(api)),
      ],
      child: AssessmentConsoleApp(api: api),
    ),
  );
}
