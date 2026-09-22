import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

import '../models/health_model.dart';
import '../models/generate_model.dart';
import '../models/guardian_model.dart';
import '../models/identity_model.dart';

/// ─── Cerberus AI — API Service ──────────────────────────────────────────────
/// Thin HTTP / SSE connectivity layer targeting the Hono API gateway.
/// Every call routes through Google Cloud-native fetch bindings (via Dart http)
/// with zero legacy dependencies.

class GenerateResult {
  final GeneratedSuite? suite;
  final String? generationRequestId;
  final bool cancelled;
  final String? error;

  GenerateResult({
    this.suite,
    this.generationRequestId,
    this.cancelled = false,
    this.error,
  });

  factory GenerateResult.fromJson(Map<String, dynamic> json) {
    final cancelled = json['cancelled'] == true;
    final suiteJson = json['suite'] as Map<String, dynamic>?;
    return GenerateResult(
      suite: suiteJson != null ? GeneratedSuite.fromJson(suiteJson) : null,
      generationRequestId: json['generationRequestId'] as String?,
      cancelled: cancelled,
      error: json['error'] as String?,
    );
  }
}

class ApiService {
  final String baseUrl;
  final http.Client _client;

  /// Ephemeral session token injected into all API requests after
  /// identity is set. Null = anonymous/no identity.
  String? sessionToken;

  ApiService({required this.baseUrl}) : _client = http.Client();

  /// Returns headers common to all API calls, including the session
  /// token when an identity has been established.
  Map<String, String> _commonHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (sessionToken != null && sessionToken!.isNotEmpty) {
      headers['X-Session-Token'] = sessionToken!;
    }
    return headers;
  }

  // ── Identity ───────────────────────────────────────────────────────────────
  /// POST /api/v1/identity/set — registers display name + candidate ID,
  /// returns ephemeral session token.
  Future<IdentityResponse> setIdentity({
    required String displayName,
    required String candidateId,
    String? role,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/identity/set');
    final body = <String, dynamic>{
      'displayName': displayName,
      'candidateId': candidateId,
    };
    if (role != null && role.isNotEmpty) {
      body['role'] = role;
    }
    final response = await _client
        .post(uri, headers: _commonHeaders(), body: jsonEncode(body))
        .timeout(const Duration(seconds: 10));
    final responseBody = jsonDecode(response.body) as Map<String, dynamic>;
    if (response.statusCode == 201) {
      return IdentityResponse.fromJson(responseBody);
    }
    throw ApiException(
      response.statusCode,
      (responseBody['error'] as String?) ?? 'Identity registration failed',
    );
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  Future<HealthStatus> fetchHealth() async {
    final uri = Uri.parse('$baseUrl/health');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Health check failed');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    return HealthStatus.fromJson(body);
  }

  // ── Autonomous Test Suite Generator ────────────────────────────────────────
  Future<GenerateResult> generateSuite(
    String prompt, {
    required int problemCount,
    required String roleContext,
    String? generationRequestId,
  }) async {
    final uri = Uri.parse('$baseUrl/api/v1/generate');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (generationRequestId != null && generationRequestId.isNotEmpty) {
      headers['X-Generation-Request-Id'] = generationRequestId;
    }
    http.Response response;
    try {
      response = await _client
          .post(
            uri,
            headers: {..._commonHeaders(), ...headers},
            body: jsonEncode({
              'prompt': prompt,
              'roleContext': roleContext,
              'problemCount': problemCount,
            }),
          )
          .timeout(const Duration(seconds: 120));
    } on TimeoutException {
      throw ApiException(
        503,
        'Suite generation timed out — Gemini may be overloaded',
      );
    }

    final body = jsonDecode(response.body) as Map<String, dynamic>;

    if (response.statusCode == 200 || response.statusCode == 201) {
      // Parse the full envelope to capture generationRequestId and cancelled flag
      return GenerateResult.fromJson(body);
    }

    // ── Extract server-side error detail for better UX ────────────────────
    String detail;
    try {
      detail = (body['error'] as String?) ?? response.body;
      if (detail.isEmpty) detail = response.body;
    } catch (_) {
      detail = response.body.isNotEmpty
          ? response.body.substring(0, Math.min(response.body.length, 256))
          : 'Suite generation failed';
    }

    throw ApiException(response.statusCode, detail);
  }

  // ── Cancel in-flight generation ─────────────────────────────────────────
  Future<void> cancelGeneration(String generationRequestId) async {
    final uri = Uri.parse('$baseUrl/api/v1/generate/cancel');
    try {
      await _client
          .post(
            uri,
            headers: _commonHeaders(),
            body: jsonEncode({'generationRequestId': generationRequestId}),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      // If cancel request itself fails (e.g. network), the generation
      // will still complete or time out naturally — safe to ignore.
    }
  }

  // ── Live Guardian Stream (SSE with Polling Fallback) ───────────────────────
  Stream<SuspicionPayload> streamGuardianEvents(
    String sessionId, {
    Duration pollInterval = const Duration(seconds: 5),
  }) async* {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/stream/$sessionId');

    try {
      final request = http.Request('GET', uri);
      request.headers.addAll(_commonHeaders());
      final streamedResponse = await _client
          .send(request)
          .timeout(const Duration(seconds: 15));

      if (streamedResponse.statusCode == 200) {
        // ── SSE streaming active ─────────────────────────────────────────────
        final lineStream = streamedResponse.stream
            .transform(utf8.decoder)
            .transform(const LineSplitter());

        await for (final line in lineStream) {
          if (line.startsWith('data: ')) {
            final raw = line.substring(6).trim();
            if (raw.isEmpty || raw == '[DONE]') continue;
            try {
              final json = jsonDecode(raw) as Map<String, dynamic>;
              yield SuspicionPayload.fromJson(json);
            } catch (_) {
              // Skip malformed events
            }
          }
        }
        return; // SSE stream ended naturally
      }
    } on Exception {
      // SSE unavailable — fall through to polling
    }

    // ── Polling Fallback ────────────────────────────────────────────────────
    while (true) {
      try {
        final review = await fetchReview(sessionId);
        if (review.latestSuspicion != null) {
          yield review.latestSuspicion!;
        }
      } catch (_) {
        // Silently swallow polling errors to keep the stream alive
      }
      await Future.delayed(pollInterval);
    }
  }

  // ── Ingest Micro-Events ────────────────────────────────────────────────────
  /// Submits candidate behavioral telemetry events to the Hono Guardian
  /// endpoint for real-time analysis. Returns `true` on successful ingestion.
  Future<bool> ingestMicroEvents(List<MicroEvent> events) async {
    final uri = Uri.parse('$baseUrl/api/v1/guardian/ingest');

    try {
      final response = await _client
          .post(
            uri,
            headers: _commonHeaders(),
            body: jsonEncode({
              'events': events.map((e) => e.toJson()).toList(),
            }),
          )
          .timeout(const Duration(seconds: 15));

      return response.statusCode == 200 || response.statusCode == 201;
    } catch (_) {
      return false;
    }
  }

  // ── Fetch Review Record ────────────────────────────────────────────────────
  /// Fetches a single session's full review payload from
  /// GET /api/v1/sessions/:sessionId which returns { success, data }.
  Future<ReviewRecord> fetchReview(String sessionId) async {
    final uri = Uri.parse('$baseUrl/api/v1/sessions/$sessionId');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Review fetch failed');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final data = body['data'] as Map<String, dynamic>?;
    if (data == null) {
      throw ApiException(response.statusCode, 'Review data missing');
    }
    return ReviewRecord.fromJson(data);
  }

  // ── List All Sessions (Drawer) ─────────────────────────────────────────────
  /// Fetches the session list from GET /api/v1/sessions
  /// which returns { success, data: [...] }.
  Future<List<SessionSummary>> fetchSessions() async {
    final uri = Uri.parse('$baseUrl/api/v1/sessions');
    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Sessions list failed');
    }
    final body = jsonDecode(response.body) as Map<String, dynamic>;
    final items = body['data'] as List<dynamic>? ?? [];
    return items
        .map((s) => SessionSummary.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  void dispose() {
    _client.close();
  }
}

class Math {
  static int min(int a, int b) => a < b ? a : b;
}

class ApiException implements Exception {
  final int statusCode;
  final String message;

  const ApiException(this.statusCode, this.message);

  /// 503 Service Unavailable or 504 Gateway Timeout — temporary,
  /// downstream service (Gemini) may recover.
  bool get isRetryable =>
      statusCode == 503 ||
      statusCode == 504 ||
      (statusCode >= 500 && message.toLowerCase().contains('timed out')) ||
      message.toLowerCase().contains('overloaded');

  /// True when auto-retries are appropriate (5xx except explicitly terminal).
  bool get isTransient => statusCode >= 500 && statusCode < 600;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
