/// Health model for the tryveriqo console.
///
/// Mirrors the public `GET /health` payload. It reports process health, the
/// configured AI provider/model and the database name — never a credential.
library;

class HealthStatus {
  final String status; // "healthy" | "degraded" | "down"
  final String service;
  final String apiVersion;
  final String environment;
  final String aiProvider;
  final String aiModel;
  final String database;
  final int uptimeSeconds;

  const HealthStatus({
    required this.status,
    required this.service,
    required this.apiVersion,
    required this.environment,
    required this.aiProvider,
    required this.aiModel,
    required this.database,
    required this.uptimeSeconds,
  });

  factory HealthStatus.fromJson(Map<String, dynamic> json) {
    return HealthStatus(
      status: json['status'] as String? ?? 'unknown',
      service: json['service'] as String? ?? 'tryveriqo-api',
      apiVersion: json['version'] as String? ?? '0.0.0',
      environment: json['environment'] as String? ?? 'unknown',
      aiProvider: json['aiProvider'] as String? ?? 'unknown',
      aiModel: json['aiModel'] as String? ?? 'unknown',
      database: json['database'] as String? ?? 'unknown',
      uptimeSeconds: (json['uptimeSeconds'] as num?)?.toInt() ?? 0,
    );
  }

  bool get isHealthy => status == 'healthy';
}
