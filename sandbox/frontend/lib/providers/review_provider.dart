import 'package:flutter/foundation.dart';
import '../models/guardian_model.dart';
import '../services/api_service.dart';

/// ─── Cerberus AI — Review Provider ──────────────────────────────────────────
/// Loads session summaries (drawer list) and full review records (detail view)
/// for the split-panel analytical review log.

class ReviewProvider extends ChangeNotifier {
  final ApiService _api;

  List<SessionSummary> _sessions = [];
  ReviewRecord? _selected;
  String? _error;
  bool _isLoading = false;

  ReviewProvider(this._api);

  List<SessionSummary> get sessions => _sessions;
  ReviewRecord? get selected => _selected;
  String? get error => _error;
  bool get isLoading => _isLoading;

  Future<void> loadSessions() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _sessions = await _api.fetchSessions();
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'Failed to load sessions: $e';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  Future<void> loadReview(String sessionId) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _selected = await _api.fetchReview(sessionId);
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'Failed to load review: $e';
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void selectSession(String sessionId) {
    if (_sessions.any((s) => s.sessionId == sessionId)) {
      loadReview(sessionId);
    }
  }

  void clearSelection() {
    _selected = null;
    notifyListeners();
  }
}
