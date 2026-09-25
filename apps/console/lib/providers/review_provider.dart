import 'package:flutter/foundation.dart';

import '../models/integrity.dart';
import '../services/api_client.dart';

/// Loads the reviewer session list and the selected session's review, and can
/// terminate a session.

class ReviewProvider extends ChangeNotifier {
  final ApiService _api;

  List<SessionSummary> _sessions = [];
  ReviewRecord? _selected;
  String? _error;
  bool _isLoading = false;
  bool _isLoadingOlder = false;

  ReviewProvider(this._api);

  List<SessionSummary> get sessions => _sessions;
  ReviewRecord? get selected => _selected;
  String? get error => _error;
  bool get isLoading => _isLoading;
  bool get isLoadingOlder => _isLoadingOlder;

  Future<void> loadSessions() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _sessions = await _api.fetchSessions();
    } on ApiException catch (e) {
      _error = e.isUnauthorised
          ? 'The console credential was rejected. Supply a valid operator token.'
          : e.message;
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

  /// Fetches the next older page of telemetry and prepends it.
  ///
  /// The timeline is rendered oldest-first while each page arrives newest-first,
  /// so older events belong at the front. Deduplicated on the way in, because a
  /// live session can gain events between pages and shift the offset.
  Future<void> loadOlderEvents() async {
    final current = _selected;
    final offset = current?.nextEventOffset;
    if (current == null || offset == null) return;

    _isLoadingOlder = true;
    _error = null;
    notifyListeners();

    try {
      final page = await _api.fetchReview(
        current.sessionId,
        eventOffset: offset,
      );
      final seen = current.timeline
          .map(
            (entry) => '${entry.timestamp}|${entry.eventType}|${entry.detail}',
          )
          .toSet();
      final older = page.timeline
          .where(
            (entry) => seen.add(
              '${entry.timestamp}|${entry.eventType}|${entry.detail}',
            ),
          )
          .toList();

      _selected = current.withOlderEvents(older);
    } on ApiException catch (e) {
      _error = e.message;
    } catch (e) {
      _error = 'Failed to load older events: $e';
    } finally {
      _isLoadingOlder = false;
      notifyListeners();
    }
  }

  /// Refreshes both the list and, when one is selected, the open review.
  Future<void> refresh() async {
    final selectedId = _selected?.sessionId;
    await loadSessions();
    if (selectedId != null) {
      await loadReview(selectedId);
    }
  }

  void selectSession(String sessionId) {
    if (_sessions.any((s) => s.sessionId == sessionId)) {
      loadReview(sessionId);
    }
  }

  /// Terminates a session and removes it from the local list.
  Future<bool> terminateSession(String sessionId) async {
    _error = null;
    try {
      await _api.terminateSession(sessionId);
      _sessions = _sessions.where((s) => s.sessionId != sessionId).toList();
      if (_selected?.sessionId == sessionId) _selected = null;
      notifyListeners();
      return true;
    } on ApiException catch (e) {
      _error = e.message;
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'Failed to terminate session: $e';
      notifyListeners();
      return false;
    }
  }

  void clearSelection() {
    _selected = null;
    notifyListeners();
  }
}
