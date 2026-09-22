import 'package:flutter/foundation.dart';

import '../models/integrity.dart';
import '../services/api_client.dart';

/// Holds the integrity reports observed for the selected session and submits
/// candidate telemetry to the ingestion endpoint.
///
/// This provider deliberately holds no polling loop: the API does not expose a
/// streaming endpoint, so the console refreshes reports on demand (and after a
/// telemetry batch). That keeps the client honest about what the server offers.

class IntegrityProvider extends ChangeNotifier {
  final ApiService _api;

  final List<IntegrityReport> _reports = [];
  String? _error;
  bool _isSubmitting = false;

  IntegrityProvider(this._api);

  List<IntegrityReport> get reports => List.unmodifiable(_reports);
  String? get error => _error;
  bool get isSubmitting => _isSubmitting;

  IntegrityReport? get latest => _reports.isEmpty ? null : _reports.last;

  double get latestScore => latest?.overallScore ?? 0.0;

  int get elevatedOrCriticalFlagCount =>
      _reports.fold(0, (total, report) => total + report.highSeverityFlagCount);

  /// Replaces the tracked reports with the ones from a review payload.
  void loadFromReview(ReviewRecord record) {
    _reports
      ..clear()
      ..addAll(record.integritySummary);
    _error = null;
    notifyListeners();
  }

  void clear() {
    _reports.clear();
    _error = null;
    notifyListeners();
  }

  /// Submits one telemetry batch. Returns true when the server accepted it.
  Future<bool> ingest(List<MicroEvent> events) async {
    if (events.isEmpty) return true;

    _isSubmitting = true;
    _error = null;
    notifyListeners();

    try {
      final accepted = await _api.ingestTelemetry(events);
      if (!accepted) {
        _error = 'Telemetry was not accepted by the server.';
      }
      return accepted;
    } catch (e) {
      _error = 'Telemetry submission failed: $e';
      return false;
    } finally {
      _isSubmitting = false;
      notifyListeners();
    }
  }
}
