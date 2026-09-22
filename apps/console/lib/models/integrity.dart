/// Assessment console domain models.
///
/// These mirror the shapes returned by the Assessment API. Integrity data is
/// advisory reviewer assistance: a report surfaces suspicious behaviour
/// indicators for a human to verify, and never asserts that misconduct occurred.
library;


/// One integrity flag raised against a candidate's session.
class IntegrityFlag {
  final String flagType;
  final String severity; // "low" | "medium" | "high" | "critical"
  final String sourceEventId;
  final String description;
  final double confidence; // 0.0 - 1.0
  final String timestamp;

  const IntegrityFlag({
    required this.flagType,
    required this.severity,
    required this.sourceEventId,
    required this.description,
    required this.confidence,
    required this.timestamp,
  });

  factory IntegrityFlag.fromJson(Map<String, dynamic> json) {
    return IntegrityFlag(
      flagType: json['flagType'] as String? ?? 'UNKNOWN',
      severity: json['severity'] as String? ?? 'medium',
      sourceEventId: json['sourceEventId'] as String? ?? '',
      description: json['description'] as String? ?? '',
      confidence: (json['confidence'] as num?)?.toDouble() ?? 0.0,
      timestamp: json['timestamp'] as String? ?? '',
    );
  }

  /// Human-readable label derived from the machine flag type.
  String get label => flagType
      .split('_')
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
}

/// One matched snippet inside a similarity report.
class PlagiarismMatch {
  final String sourceSnippet;
  final String candidateSnippet;
  final double similarityScore; // 0.0 - 1.0
  final String sourceLabel;

  const PlagiarismMatch({
    required this.sourceSnippet,
    required this.candidateSnippet,
    required this.similarityScore,
    required this.sourceLabel,
  });

  factory PlagiarismMatch.fromJson(Map<String, dynamic> json) {
    return PlagiarismMatch(
      sourceSnippet: json['sourceSnippet'] as String? ?? '',
      candidateSnippet: json['candidateSnippet'] as String? ?? '',
      similarityScore: (json['similarityScore'] as num?)?.toDouble() ?? 0.0,
      sourceLabel: json['sourceLabel'] as String? ?? '',
    );
  }
}

/// Structured similarity report for a submission.
class PlagiarismReport {
  final double overallSimilarity; // 0.0 - 1.0
  final double aiCompletionLikelihood; // 0.0 - 1.0
  final List<PlagiarismMatch> matchedSnippets;

  const PlagiarismReport({
    required this.overallSimilarity,
    required this.aiCompletionLikelihood,
    required this.matchedSnippets,
  });

  factory PlagiarismReport.fromJson(Map<String, dynamic> json) {
    return PlagiarismReport(
      overallSimilarity: (json['overallSimilarity'] as num?)?.toDouble() ?? 0.0,
      aiCompletionLikelihood:
          (json['aiCompletionLikelihood'] as num?)?.toDouble() ?? 0.0,
      matchedSnippets: (json['matchedSnippets'] as List<dynamic>? ?? [])
          .map((e) => PlagiarismMatch.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  static PlagiarismReport? fromJsonOrNull(dynamic value) {
    if (value is! Map<String, dynamic>) return null;
    return PlagiarismReport.fromJson(value);
  }
}

/// One behavioural anomaly within an evidence window.
class BehavioralAnomaly {
  final String anomalyType;
  final String description;
  final String evidenceWindowStart;
  final String evidenceWindowEnd;
  final double metricValue;
  final double threshold;

  const BehavioralAnomaly({
    required this.anomalyType,
    required this.description,
    required this.evidenceWindowStart,
    required this.evidenceWindowEnd,
    required this.metricValue,
    required this.threshold,
  });

  factory BehavioralAnomaly.fromJson(Map<String, dynamic> json) {
    return BehavioralAnomaly(
      anomalyType: json['anomalyType'] as String? ?? '',
      description: json['description'] as String? ?? '',
      evidenceWindowStart: json['evidenceWindowStart'] as String? ?? '',
      evidenceWindowEnd: json['evidenceWindowEnd'] as String? ?? '',
      metricValue: (json['metricValue'] as num?)?.toDouble() ?? 0.0,
      threshold: (json['threshold'] as num?)?.toDouble() ?? 0.0,
    );
  }
}

/// A full integrity report for one session, as produced by the analysis pass.
class IntegrityReport {
  final String integrityReportId;
  final String sessionId;
  final String candidateId;
  final String assessmentId;
  final double overallScore; // 0 - 100, higher means more suspicious signals
  final List<IntegrityFlag> flags;
  final PlagiarismReport? plagiarismReport;
  final List<BehavioralAnomaly> behavioralAnomalies;
  final String generatedAt;

  const IntegrityReport({
    required this.integrityReportId,
    required this.sessionId,
    required this.candidateId,
    required this.assessmentId,
    required this.overallScore,
    required this.flags,
    this.plagiarismReport,
    required this.behavioralAnomalies,
    required this.generatedAt,
  });

  factory IntegrityReport.fromJson(Map<String, dynamic> json) {
    return IntegrityReport(
      integrityReportId: json['integrityReportId'] as String? ?? '',
      sessionId: json['sessionId'] as String? ?? '',
      candidateId: json['candidateId'] as String? ?? '',
      assessmentId: json['assessmentId'] as String? ?? '',
      overallScore: (json['overallScore'] as num?)?.toDouble() ?? 0.0,
      flags: (json['flags'] as List<dynamic>? ?? [])
          .map((e) => IntegrityFlag.fromJson(e as Map<String, dynamic>))
          .toList(),
      plagiarismReport: PlagiarismReport.fromJsonOrNull(json['plagiarismReport']),
      behavioralAnomalies: (json['behavioralAnomalies'] as List<dynamic>? ?? [])
          .map((e) => BehavioralAnomaly.fromJson(e as Map<String, dynamic>))
          .toList(),
      generatedAt: json['generatedAt'] as String? ?? '',
    );
  }

  /// Severity band used for colour coding. Advisory, not a verdict.
  String get severity {
    if (overallScore >= 70) return 'critical';
    if (overallScore >= 40) return 'elevated';
    return 'nominal';
  }

  int get highSeverityFlagCount => flags
      .where((f) => f.severity == 'critical' || f.severity == 'high')
      .length;
}

/// One entry in a candidate's review timeline.
class TimelineEntry {
  final String timestamp;
  final String eventType;
  final String label;
  final String severity; // "info" | "warning" | "critical"
  final String detail;

  const TimelineEntry({
    required this.timestamp,
    required this.eventType,
    required this.label,
    required this.severity,
    required this.detail,
  });

  factory TimelineEntry.fromJson(Map<String, dynamic> json) {
    return TimelineEntry(
      timestamp: json['timestamp'] as String? ?? '',
      eventType: json['eventType'] as String? ?? 'unknown',
      label: json['label'] as String? ?? '',
      severity: json['severity'] as String? ?? 'info',
      detail: json['detail'] as String? ?? '',
    );
  }
}

/// One candidate observation, as sent to the telemetry ingestion endpoint.
class MicroEvent {
  final String eventType;
  final String timestamp;
  final Map<String, dynamic> payload;
  final String candidateId;
  final String sessionId;
  final String assessmentId;
  final String? problemId;

  const MicroEvent({
    required this.eventType,
    required this.timestamp,
    this.payload = const {},
    required this.candidateId,
    required this.sessionId,
    required this.assessmentId,
    this.problemId,
  });

  Map<String, dynamic> toJson() => {
    'eventId':
        '${sessionId}_${eventType}_${DateTime.now().microsecondsSinceEpoch}',
    'sessionId': sessionId,
    'candidateId': candidateId,
    'assessmentId': assessmentId,
    if (problemId != null) 'problemId': problemId,
    'eventType': eventType,
    'timestamp': timestamp,
    'payload': payload,
    'clientMetadata': const {
      'userAgent': 'assessment-console',
      'ipAddress': '',
      'screenResolution': '',
      'platform': 'web',
      'language': 'en',
    },
  };
}

/// A session as listed in the reviewer drawer.
class SessionSummary {
  final String sessionId;
  final String candidateId;
  final String assessmentId;
  final String status;
  final int eventCount;
  final int pasteCount;
  final int tabSwitchCount;
  final double integrityScore;
  final String? lastEventTimestamp;

  const SessionSummary({
    required this.sessionId,
    required this.candidateId,
    required this.assessmentId,
    required this.status,
    required this.eventCount,
    required this.pasteCount,
    required this.tabSwitchCount,
    required this.integrityScore,
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
      integrityScore: (json['integrityScore'] as num?)?.toDouble() ?? 0.0,
      lastEventTimestamp: parseTimestamp(json['lastEventTimestamp']),
    );
  }
}

/// The complete review payload for one session.
class ReviewRecord {
  final String sessionId;
  final String candidateId;
  final String assessmentId;
  final String status;
  final String codeSubmission;
  final List<TimelineEntry> timeline;
  final List<IntegrityReport> integritySummary;
  final double? finalScore;

  const ReviewRecord({
    required this.sessionId,
    required this.candidateId,
    required this.assessmentId,
    required this.status,
    required this.codeSubmission,
    required this.timeline,
    required this.integritySummary,
    this.finalScore,
  });

  factory ReviewRecord.fromJson(Map<String, dynamic> json) {
    return ReviewRecord(
      sessionId: json['sessionId'] as String? ?? '',
      candidateId: json['candidateId'] as String? ?? '',
      assessmentId: json['assessmentId'] as String? ?? '',
      status: json['status'] as String? ?? 'unknown',
      codeSubmission: json['submittedCode'] as String? ?? '',
      timeline: (json['timeline'] as List<dynamic>? ?? [])
          .map((e) => TimelineEntry.fromJson(e as Map<String, dynamic>))
          .toList(),
      integritySummary: (json['integritySummary'] as List<dynamic>? ?? [])
          .map((e) => IntegrityReport.fromJson(e as Map<String, dynamic>))
          .toList(),
      finalScore: (json['finalScore'] as num?)?.toDouble(),
    );
  }

  /// The most recent integrity report, if any analysis has run.
  IntegrityReport? get latestReport =>
      integritySummary.isEmpty ? null : integritySummary.last;

  /// A session whose result is settled: its code can no longer change.
  bool get isLocked =>
      status == 'submitted' ||
      status == 'flagged' ||
      status == 'terminated' ||
      status == 'evaluated';
}

/// Parses a timestamp that may arrive as a numeric epoch (ms) or an ISO string.
String? parseTimestamp(dynamic value) {
  if (value == null) return null;
  if (value is String) return value;
  if (value is num) {
    return DateTime.fromMillisecondsSinceEpoch(
      value.toInt(),
      isUtc: true,
    ).toIso8601String();
  }
  return value.toString();
}
