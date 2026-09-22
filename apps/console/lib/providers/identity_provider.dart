import 'package:flutter/foundation.dart';

import '../services/api_client.dart';

/// Candidate identity state: display name, candidate id, and the short-lived
/// candidate session token issued by the API.
///
/// Held in memory only; registration is repeated on each app start. There is no
/// stored credential and nothing is persisted to disk.

class IdentityProvider extends ChangeNotifier {
  final ApiService _apiService;

  String? _displayName;
  String? _candidateId;
  String? _role;
  String? _sessionToken;
  bool _isLoading = false;
  String? _error;

  IdentityProvider(this._apiService);

  String? get displayName => _displayName;
  String? get candidateId => _candidateId;
  String? get role => _role;
  String? get sessionToken => _sessionToken;
  bool get isIdentified => _sessionToken != null && _displayName != null;
  bool get isLoading => _isLoading;
  String? get error => _error;

  Future<bool> setIdentity({
    required String displayName,
    required String candidateId,
    String? role,
  }) async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final response = await _apiService.setIdentity(
        displayName: displayName,
        candidateId: candidateId,
        role: role,
      );

      _sessionToken = response.sessionToken;
      _displayName = response.identity.displayName;
      _candidateId = response.identity.candidateId;
      _role = response.identity.role;

      // Attach the candidate token to subsequent calls.
      _apiService.sessionToken = _sessionToken;

      _isLoading = false;
      notifyListeners();
      return true;
    } on ApiException catch (e) {
      _error = e.message;
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'Could not reach the identity service.';
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  /// Clears the candidate session locally.
  void clearIdentity() {
    _sessionToken = null;
    _displayName = null;
    _candidateId = null;
    _role = null;
    _error = null;
    _apiService.sessionToken = null;
    notifyListeners();
  }

  /// Seeds a session without contacting the API.
  ///
  /// Lets widget tests drive the identified state directly; the registration
  /// request itself is covered by the API test suite.
  @visibleForTesting
  void adoptSessionForTest({
    required String displayName,
    required String candidateId,
    String sessionToken = 'test-session-token',
    String? role,
  }) {
    _displayName = displayName;
    _candidateId = candidateId;
    _sessionToken = sessionToken;
    _role = role;
    _error = null;
    _apiService.sessionToken = sessionToken;
    notifyListeners();
  }
}
