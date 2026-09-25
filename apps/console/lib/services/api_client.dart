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

  /// Candidate session token, set after registration.
  String? sessionToken;

  /// Explicit opt-out of the embedded-token guard below.
  ///
  /// A `--dart-define` value is compiled into the bundle and readable by anyone
  /// who can load the page, so an embedded operator token is a real credential
  /// only for a console served from the same trusted machine as the API. Sending
  /// it to a remote host over a network would publish full operator access to
  /// every visitor, which is why that is refused unless this is set deliberately.
  final bool allowRemoteEmbeddedToken;

  ApiService({
    required this.baseUrl,
    this.operatorToken = '',
    this.allowRemoteEmbeddedToken = false,
    http.Client? client,
  }) : _client = client ?? http.Client();

  /// True when an operator token was compiled in but will not be sent.
  ///
  /// Derived from configuration rather than recorded as a side effect of making a
  /// request, so the UI can explain the situation before anything is attempted.
  bool get embeddedTokenWithheld =>
      operatorToken.isNotEmpty && !_maySendEmbeddedToken;

  /// Why the embedded token is not being sent, for the UI to state plainly.
  String? get embeddedTokenWithheldReason => embeddedTokenWithheld
      ? 'This console was built with an operator token compiled into its bundle, '
            'and it is pointed at $baseUrl, which is not this machine. Sending it '
            'would hand full operator access to anyone who loads the page, so it '
            'is withheld. Serve the console from a proxy that injects the '
            'Authorization header server-side, or rebuild without '
            '--dart-define=API_TOKEN.'
      : null;

  /// True when [host] is this machine.
  ///
  /// A token embedded in the bundle is acceptable against loopback because the
  /// bundle is only readable by whoever is already on the machine; it is not
  /// acceptable over a network.
  static bool isLoopbackHost(String host) {
    final normalised = host
        .toLowerCase()
        .replaceAll('[', '')
        .replaceAll(']', '');
    if (normalised == 'localhost' || normalised == '::1') return true;
    return RegExp(r'^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$').hasMatch(normalised);
  }

  /// Whether the embedded operator token may be attached to a request.
  bool get _maySendEmbeddedToken {
    if (operatorToken.isEmpty) return false;
    if (allowRemoteEmbeddedToken) return true;
    try {
      return isLoopbackHost(Uri.parse(baseUrl).host);
    } catch (_) {
      // An unparseable base URL is not a host we can vouch for.
      return false;
    }
  }

  /// Headers common to every call. The bearer token is attached only when a
  /// credential exists; an unauthenticated call is left unauthenticated so the
  /// server can answer 401 rather than the client inventing one.
  Map<String, String> _commonHeaders() {
    final headers = <String, String>{'Content-Type': 'application/json'};
    final token = _maySendEmbeddedToken ? operatorToken : (sessionToken ?? '');
    if (token.isNotEmpty) {
      headers['Authorization'] = 'Bearer $token';
    }
    return headers;
  }

  bool get hasOperatorToken => operatorToken.isNotEmpty;

  /// True when an operator credential is actually usable for requests.
  bool get hasUsableOperatorToken => _maySendEmbeddedToken;

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
