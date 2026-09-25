/// Entry point for the tryveriqo review console.
///
/// Build-time configuration:
///   `--dart-define=API_BASE_URL=http://localhost:8080`
///   `--dart-define=API_TOKEN=<operator token>` (optional; required for
///   generation and cohort review **against loopback**)
///   `--dart-define=ALLOW_REMOTE_EMBEDDED_TOKEN=true` (see below)
///
/// The operator token is compiled into the bundle, so it must never be a real
/// production secret for a publicly hosted console. The console enforces that
/// rather than only documenting it: an embedded token is **withheld** unless the
/// API base URL is loopback, or `ALLOW_REMOTE_EMBEDDED_TOKEN` is set
/// deliberately. For a hosted console, build without `API_TOKEN` and put a proxy
/// in front that injects `Authorization` server-side — see
/// `deploy/console-proxy/`.
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
  const allowRemoteEmbeddedToken =
      String.fromEnvironment('ALLOW_REMOTE_EMBEDDED_TOKEN') == 'true';

  final api = ApiService(
    baseUrl: apiBaseUrl,
    operatorToken: operatorToken,
    allowRemoteEmbeddedToken: allowRemoteEmbeddedToken,
  );

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
