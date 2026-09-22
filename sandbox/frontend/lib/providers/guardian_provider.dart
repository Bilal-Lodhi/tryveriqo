import 'dart:async';
import 'package:flutter/foundation.dart';
import '../models/guardian_model.dart';
import '../services/api_service.dart';

/// ─── Cerberus AI — Guardian Provider ────────────────────────────────────────
/// Manages the SSE stream of suspicion payloads from the Real-Time Intent &
/// Plagiarism Guardian. Accumulates events into a session timeline and exposes
/// the latest aggregated suspicion score.

class GuardianProvider extends ChangeNotifier {
  final ApiService _api;

  final List<SuspicionPayload> _events = [];
  StreamSubscription<SuspicionPayload>? _subscription;
  String? _error;
  bool _isStreaming = false;

  GuardianProvider(this._api);

  List<SuspicionPayload> get events => List.unmodifiable(_events);
  String? get error => _error;
  bool get isStreaming => _isStreaming;

  double get latestScore {
    if (_events.isEmpty) return 0.0;
    return _events.last.suspicionScore;
  }

  int get criticalCount =>
      _events.where((e) => e.severity == 'critical').length;
  int get elevatedCount =>
      _events.where((e) => e.severity == 'elevated').length;

  void startStreaming(String sessionId) {
    if (_isStreaming) return;

    _isStreaming = true;
    _error = null;
    _events.clear();
    notifyListeners();

    _subscription = _api
        .streamGuardianEvents(sessionId)
        .listen(
          (payload) {
            _events.add(payload);
            notifyListeners();
          },
          onError: (err) {
            _error = 'Guardian stream error: $err';
            _isStreaming = false;
            notifyListeners();
          },
          onDone: () {
            _isStreaming = false;
            notifyListeners();
          },
          cancelOnError: true,
        );
  }

  void stopStreaming() {
    _subscription?.cancel();
    _subscription = null;
    _isStreaming = false;
    notifyListeners();
  }

  /// Submits candidate behavioral telemetry events for server-side analysis.
  /// Returns `true` if the events were accepted by the Hono Guardian endpoint.
  Future<bool> ingestEvents(List<MicroEvent> events) {
    return _api.ingestMicroEvents(events);
  }

  @override
  void dispose() {
    stopStreaming();
    super.dispose();
  }
}
