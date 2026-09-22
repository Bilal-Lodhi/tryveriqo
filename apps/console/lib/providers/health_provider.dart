import 'package:flutter/foundation.dart';
import '../models/health_model.dart';
import '../services/api_client.dart';

/// Loads API health so the console can show whether the backend, its AI
/// provider and its datastore are reachable before a reviewer relies on it.

class HealthProvider extends ChangeNotifier {
  final ApiService _api;
  HealthStatus? _status;
  String? _error;
  bool _isLoading = false;

  HealthProvider(this._api);

  HealthStatus? get status => _status;
  String? get error => _error;
  bool get isLoading => _isLoading;

  Future<void> checkHealth() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _status = await _api.fetchHealth();
    } on ApiException catch (e) {
      _error = e.message;
      _status = null;
    } catch (e) {
      _error = 'Health check unreachable: $e';
      _status = null;
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }
}
