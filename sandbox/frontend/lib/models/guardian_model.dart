class SuspicionPayload {
  /// ─── Cerberus AI — Intent & Plagiarism Guardian Model ─────────────────────
  /// Captures streaming micro-event suspicion payloads emitted by the Guardian
  /// Agent when it detects paste triggers, structural code shifts, fast token
  /// injections, or semantic similarity against known AI completions.
  final String sessionId;
  final String candidateId;
  final String problemId;
  final double suspicionScore; // 0.0 - 100.0
  final String severity; // "nominal" | "elevated" | "critical"
  final List<MicroEvent> flaggedEvents;
  final String generatedAt;

  const SuspicionPayload({
    required this.sessionId,
    required this.candidateId,
    required this.problemId,
    required this.suspicionScore,
    required this.severity,
    required this.flaggedEvents,
    required this.generatedAt,
  });

  factory SuspicionPayload.fromJson(Map<String, dynamic> json) {
    return SuspicionPayload(
      sessionId: json['session_id'] as String? ?? '',
      candidateId: json['candidate_id'] as String? ?? '',
      problemId: json['problem_id'] as String? ?? '',
      suspicionScore: (json['suspicion_score'] as num?)?.toDouble() ?? 0.0,
      severity: json['severity'] as String? ?? 'nominal',
      flaggedEvents: (json['flagged_events'] as List<dynamic>? ?? [])
          .map((e) => MicroEvent.fromJson(e as Map<String, dynamic>))
          .toList(),
      generatedAt: json['generated_at'] as String? ?? '',
    );
  }
}

class MicroEvent {
  final String eventType;
  // "paste_trigger" | "structural_shift" | "token_injection" |
  // "semantic_similarity" | "tab_blur" | "heartbeat_gap"
  final String timestamp;
  final Map<String, dynamic> evidence;
  final double confidence; // 0.0 - 1.0

  const MicroEvent({
    required this.eventType,
    required this.timestamp,
    required this.evidence,
    required this.confidence,
  });

  factory MicroEvent.fromJson(Map<String, dynamic> json) {
    return MicroEvent(
      eventType: json['event_type'] as String? ?? 'unknown',
      timestamp: json['timestamp'] as String? ?? '',
      evidence: json['evidence'] as Map<String, dynamic>? ?? const {},
      confidence: (json['confidence'] as num?)?.toDouble() ?? 0.0,
    );
  }

  Map<String, dynamic> toJson() => {
    'event_type': eventType,
    'timestamp': timestamp,
    'evidence': evidence,
    'confidence': confidence,
  };
}

/// Parses a timestamp field that may arrive as a numeric epoch (ms),
/// an ISO-8601 string, or null.
String? _parseTimestamp(dynamic value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is num) {
    return DateTime.fromMillisecondsSinceEpoch(
      value.toInt(),
    ).toUtc().toIso8601String();
  }
  return value.toString();
}

/// Lightweight session summary returned by GET /api/v1/sessions.
/// Contains just enough metadata to populate the drawer list.
class SessionSummary {
  final String sessionId;
  final String candidateId;
  final String assessmentId;
  final String status;
  final int eventCount;
  final int pasteCount;
  final int tabSwitchCount;
  final double suspicionScore;
  final String? lastEventTimestamp;

  const SessionSummary({
    required this.sessionId,
    required this.candidateId,
    required this.assessmentId,
    required this.status,
    required this.eventCount,
    required this.pasteCount,
    required this.tabSwitchCount,
    required this.suspicionScore,
    this.lastEventTimestamp,
  });

  factory SessionSummary.fromJson(Map<String, dynamic> json) {
    return SessionSummary(
      sessionId: json['sessionId'] as String? ?? '',
      candidateId: json['candidateId'] as String? ?? '',
      assessmentId: json['assessmentId'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      eventCount: (json['eventCount'] as num?)?.toInt() ?? 0,
      pasteCount: (json['pasteCount'] as num?)?.toInt() ?? 0,
      tabSwitchCount: (json['tabSwitchCount'] as num?)?.toInt() ?? 0,
      suspicionScore: (json['suspicionScore'] as num?)?.toDouble() ?? 0.0,
      lastEventTimestamp: _parseTimestamp(json['lastEventTimestamp']),
    );
  }
}

/// Aggregated review record combining the security timeline with the
/// candidate's final code submission for the split-panel UI.
/// Maps to GET /api/v1/sessions/:sessionId response shape.
class ReviewRecord {
  final String sessionId;
  final String candidateId;
  final String assessmentId;
  final String status;
  final String codeSubmission;
  final List<Map<String, dynamic>> timeline;
  final SuspicionPayload? latestSuspicion;
  final double finalScore;

  const ReviewRecord({
    required this.sessionId,
    required this.candidateId,
    required this.assessmentId,
    required this.status,
    required this.codeSubmission,
    required this.timeline,
    this.latestSuspicion,
    this.finalScore = 0,
  });

  factory ReviewRecord.fromJson(Map<String, dynamic> json) {
    // Parse suspicionSummary array — take the most recent report
    SuspicionPayload? latest;
    final reports = json['suspicionSummary'] as List<dynamic>? ?? [];
    if (reports.isNotEmpty) {
      latest = SuspicionPayload.fromJson(reports.last as Map<String, dynamic>);
    }

    return ReviewRecord(
      sessionId: json['sessionId'] as String? ?? '',
      candidateId: json['candidateId'] as String? ?? '',
      assessmentId: json['assessmentId'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      codeSubmission: json['submittedCode'] as String? ?? '',
      timeline:
          (json['timeline'] as List<dynamic>?)
              ?.map((e) => e as Map<String, dynamic>)
              .toList() ??
          [],
      latestSuspicion: latest,
      finalScore: (json['finalScore'] as num?)?.toDouble() ?? 0,
    );
  }
}

class BehavioralFlag {
  final String flagId;
  final String label;
  final String description;
  final String severity; // "info" | "warning" | "critical"
  final String detectedAt;

  const BehavioralFlag({
    required this.flagId,
    required this.label,
    required this.description,
    required this.severity,
    required this.detectedAt,
  });

  factory BehavioralFlag.fromJson(Map<String, dynamic> json) {
    return BehavioralFlag(
      flagId: json['flag_id'] as String? ?? '',
      label: json['label'] as String? ?? '',
      description: json['description'] as String? ?? '',
      severity: json['severity'] as String? ?? 'info',
      detectedAt: json['detected_at'] as String? ?? '',
    );
  }
}
