/// Candidate identity model for the Assessment console.
///
/// Matches `POST /api/v1/identity/set`, which registers a candidate and returns
/// a short-lived, candidate-scoped session token.
library;


class IdentityPayload {
  final String displayName;
  final String candidateId;
  final String? role;

  const IdentityPayload({
    required this.displayName,
    required this.candidateId,
    this.role,
  });

  factory IdentityPayload.fromJson(Map<String, dynamic> json) {
    return IdentityPayload(
      displayName: json['displayName'] as String? ?? '',
      candidateId: json['candidateId'] as String? ?? '',
      role: json['role'] as String?,
    );
  }

  Map<String, dynamic> toJson() => {
    'displayName': displayName,
    'candidateId': candidateId,
    if (role != null && role!.isNotEmpty) 'role': role,
  };
}

class IdentityResponse {
  final bool success;
  final IdentityPayload identity;
  final String sessionToken;
  final String expiresAt;

  const IdentityResponse({
    required this.success,
    required this.identity,
    required this.sessionToken,
    required this.expiresAt,
  });

  factory IdentityResponse.fromJson(Map<String, dynamic> json) {
    return IdentityResponse(
      success: json['success'] as bool? ?? false,
      identity: IdentityPayload.fromJson(
        json['identity'] as Map<String, dynamic>? ?? const {},
      ),
      sessionToken: json['sessionToken'] as String? ?? '',
      expiresAt: json['expiresAt'] as String? ?? '',
    );
  }
}
