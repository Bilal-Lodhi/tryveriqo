/// ─── Cerberus AI — Identity Model ────────────────────────────────────────────
/// Lightweight identity types matching the Hono API identity endpoints.

class IdentityPayload {
  final String displayName;
  final String candidateId;
  final String? role;

  IdentityPayload({
    required this.displayName,
    required this.candidateId,
    this.role,
  });

  factory IdentityPayload.fromJson(Map<String, dynamic> json) {
    return IdentityPayload(
      displayName: json['displayName'] as String,
      candidateId: json['candidateId'] as String,
      role: json['role'] as String?,
    );
  }
}

class IdentityResponse {
  final bool success;
  final IdentityPayload identity;
  final String sessionToken;

  IdentityResponse({
    required this.success,
    required this.identity,
    required this.sessionToken,
  });

  factory IdentityResponse.fromJson(Map<String, dynamic> json) {
    return IdentityResponse(
      success: json['success'] as bool,
      identity: IdentityPayload.fromJson(
        json['identity'] as Map<String, dynamic>,
      ),
      sessionToken: json['sessionToken'] as String,
    );
  }
}
