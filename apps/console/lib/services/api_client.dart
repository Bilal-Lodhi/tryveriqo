import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/health_model.dart';
import '../models/identity_model.dart';
import '../models/integrity.dart';

/// Result of an assessment generation request.
///
/// The API can answer `200` with `success: false` — a generation cancelled at the
/// client's request — and a successful generation can still fail to persist. Both
/// are carried here so the UI never has to infer an outcome from the absence of an
/// error.
class GenerateResult {
  final Map<String, dynamic>? suite;
  final String? generationRequestId;
  final bool cancelled;
  final String? error;

  /// Whether the API reported the request as successful.
  final bool success;

  /// Whether the generated suite reached the store. `false` means it exists only
  /// in this response.
  final bool persisted;

  const GenerateResult({
    this.suite,
    this.generationRequestId,
    this.cancelled = false,
    this.error,
    this.success = false,
    this.persisted = false,
  });

  factory GenerateResult.fromJson(Map<String, dynamic> json) {
    return GenerateResult(
      suite: json['suite'] as Map<String, dynamic>?,
      generationRequestId: json['generationRequestId'] as String?,
      cancelled: json['cancelled'] == true,
      error: json['error'] as String?,
      success: json['success'] == true,
      persisted: json['persisted'] == true,
    );
  }

  /// True when there is a suite to show the operator.
  bool get hasSuite => suite != null;
}

/// HTTP connectivity layer for the tryveriqo API.
///
/// Two credentials exist and both are bearer tokens:
///   * [operatorToken] — the console/reviewer credential, supplied at build time
///     with `--dart-define=API_TOKEN=...`; unlocks assessment generation and the
///     reviewer surfaces.
///   * [sessionToken]  — a short-lived candidate token obtained from
///     `POST /api/v1/identity/set`; confines a candidate to their own data.
///
/// The operator token takes precedence when both are present.
class ApiService {
  final String baseUrl;
  final http.Client _client;

  /// Reviewer/console credential. Never logged.
  final String operatorToken;

  /// Candidate session token, set after identity registration.
  String? sessionToken;

  ApiService({required this.baseUrl, this.operatorToken = ''})
    : _client = http.Client();

  /// Headers common to every call. The bearer token is attached only when a
  /// credential exists; an unauthenticated call is left unauthenticated so the
  /// server can answer 401 rather than the client inventing one.
  Map<String, String> _commonHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    final token = operatorToken.isNotEmpty ? operatorToken : sessionToken;
    if (token != null && token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }

  bool get hasOperatorToken => operatorToken.isNotEmpty;

  // ── Health ─────────────────────────────────────────────────────────────────
  Future<HealthStatus> fetchHealth() async {
    final response = await _client
        .get(Uri.parse('$baseUrl/health'), headers: _commonHeaders())
        .timeout(const Duration(seconds: 10));
    if (response.statusCode != 200) {
      throw ApiException(response.statusCode, 'Health check failed');
    }
    return HealthStatus.fromJson(
      jsonDecode(response.body) as Map<String, dynamic>,
    );
  }

  // ── Candidate identity ─────────────────────────────────────────────────────
  /// Registers a candidate and returns a candidate-scoped session token.
  ///
  /// [registrationCapability] is an operator-issued grant bound to this
  /// candidate id. Registration requires one unless the API is running in the
  /// development-only open mode, so a candidate id on its own is not enough to
  /// obtain a token.
  Future<IdentityResponse> setIdentity({
    required String displayName,
    required String candidateId,
    String? role,
    String? assessmentId,
    String? registrationCapability,
  }) async {
    final body = <String, dynamic>{
      'displayName': displayName,
      'candidateId': candidateId,
    };
    if (role != null && role.isNotEmpty) body['role'] = role;
    if (assessmentId != null && assessmentId.isNotEmpty) {
      body['assessmentId'] = assessmentId;
    }
    if (registrationCapability != null && registrationCapability.isNotEmpty) {
      body['registrationCapability'] = registrationCapability;
    }

    final response = await _client
        .post(
          Uri.parse('$baseUrl/api/v1/identity/set'),
          headers: _commonHeaders(),
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 10));

    final decoded = _decode(response);
    if (response.statusCode == 201) {
      return IdentityResponse.fromJson(decoded);
    }
    throw ApiException(
      response.statusCode,
      (decoded['error'] as String?) ?? 'Candidate registration failed',
    );
  }

  // ── Assessment generation ──────────────────────────────────────────────────
  Future<GenerateResult> generateSuite(
    String prompt, {
    required int problemCount,
    required String roleContext,
    String? generationRequestId,
  }) async {
    final headers = _commonHeaders();
    if (generationRequestId != null && generationRequestId.isNotEmpty) {
      headers['X-Generation-Request-Id'] = generationRequestId;
    }

    http.Response response;
    try {
      response = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/generate'),
            headers: headers,
            body: jsonEncode({
              'prompt': prompt,
              'roleContext': roleContext,
              'problemCount': problemCount,
            }),
          )
          .timeout(const Duration(seconds: 120));
    } on TimeoutException {
      throw const ApiException(
        503,
        'Assessment generation timed out — the AI provider may be busy.',
      );
    }

    final decoded = _decode(response);
    if (response.statusCode == 200 || response.statusCode == 201) {
      return GenerateResult.fromJson(decoded);
    }
    throw ApiException(
      response.statusCode,
      (decoded['error'] as String?) ?? 'Assessment generation failed',
    );
  }

  Future<void> cancelGeneration(String generationRequestId) async {
    try {
      await _client
          .post(
            Uri.parse('$baseUrl/api/v1/generate/cancel'),
            headers: _commonHeaders(),
            body: jsonEncode({'generationRequestId': generationRequestId}),
          )
          .timeout(const Duration(seconds: 10));
    } catch (_) {
      // A failed cancel is harmless: the generation completes or times out.
    }
  }

  // ── Telemetry ingestion ────────────────────────────────────────────────────
  /// Submits candidate telemetry for integrity analysis.
  Future<bool> ingestTelemetry(List<MicroEvent> events) async {
    try {
      final response = await _client
          .post(
            Uri.parse('$baseUrl/api/v1/integrity/ingest'),
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

  // ── Reviewer surfaces ──────────────────────────────────────────────────────
  /// `GET /api/v1/sessions` — reviewer session list.
  Future<List<SessionSummary>> fetchSessions() async {
    final response = await _client
        .get(Uri.parse('$baseUrl/api/v1/sessions'), headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(
        response.statusCode,
        _errorFrom(response, 'Session list unavailable'),
      );
    }
    final items = _decode(response)['data'] as List<dynamic>? ?? [];
    return items
        .map((s) => SessionSummary.fromJson(s as Map<String, dynamic>))
        .toList();
  }

  /// `GET /api/v1/sessions/:sessionId/review` — full review payload.
  ///
  /// The response carries one page of telemetry, not necessarily the whole
  /// record. [eventOffset] walks backwards through it; the payload reports
  /// `timelineTotal` and `nextEventOffset` so the caller can tell whether it
  /// holds everything.
  Future<ReviewRecord> fetchReview(
    String sessionId, {
    int? eventLimit,
    int? eventOffset,
  }) async {
    final query = <String, String>{
      if (eventLimit != null) 'eventLimit': '$eventLimit',
      if (eventOffset != null) 'eventOffset': '$eventOffset',
    };
    final uri = Uri.parse(
      '$baseUrl/api/v1/sessions/$sessionId/review',
    ).replace(queryParameters: query.isEmpty ? null : query);

    final response = await _client
        .get(uri, headers: _commonHeaders())
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(
        response.statusCode,
        _errorFrom(response, 'Review unavailable'),
      );
    }
    final data = _decode(response)['data'] as Map<String, dynamic>?;
    if (data == null) {
      throw ApiException(response.statusCode, 'Review payload was missing');
    }
    return ReviewRecord.fromJson(data);
  }

  /// `DELETE /api/v1/integrity/sessions/:sessionId` — terminate and remove.
  Future<bool> terminateSession(String sessionId) async {
    final response = await _client
        .delete(
          Uri.parse('$baseUrl/api/v1/integrity/sessions/$sessionId'),
          headers: _commonHeaders(),
        )
        .timeout(const Duration(seconds: 15));
    if (response.statusCode != 200) {
      throw ApiException(
        response.statusCode,
        _errorFrom(response, 'Session termination failed'),
      );
    }
    return true;
  }

  // ── Internals ──────────────────────────────────────────────────────────────
  Map<String, dynamic> _decode(http.Response response) {
    if (response.body.isEmpty) return const {};
    try {
      final decoded = jsonDecode(response.body);
      return decoded is Map<String, dynamic> ? decoded : const {};
    } catch (_) {
      return const {};
    }
  }

  String _errorFrom(http.Response response, String fallback) {
    final message = _decode(response)['error'];
    return message is String && message.isNotEmpty ? message : fallback;
  }

  void dispose() {
    _client.close();
  }
}

class ApiException implements Exception {
  final int statusCode;
  final String message;

  const ApiException(this.statusCode, this.message);

  /// 401/403 mean the console is missing or holds an insufficient credential.
  bool get isUnauthorised => statusCode == 401 || statusCode == 403;

  bool get isRetryable => statusCode == 503 || statusCode == 504;

  @override
  String toString() => 'ApiException($statusCode): $message';
}
