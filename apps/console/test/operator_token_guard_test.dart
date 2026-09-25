/// Embedded operator-token guard tests.
///
/// The console compiles `--dart-define=API_TOKEN` into its web bundle, where
/// anyone who can load the page can read it. That is acceptable against loopback,
/// where the bundle is only readable by whoever is already on the machine, and
/// unacceptable over a network, where it would hand full operator access to every
/// visitor.
///
/// These tests pin the guard, and prove the header is genuinely absent from the
/// request rather than merely reported as withheld.
library;

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tryveriqo_console/services/api_client.dart';

const _token = 'operator-token-value';

/// Records the headers of every request it is given, and answers with `body`.
class _Recorder {
  final List<Map<String, String>> requests = [];
  String? lastAuthorization;

  http.Client client({int status = 200, Object? body}) {
    return MockClient((request) async {
      requests.add(Map<String, String>.from(request.headers));
      lastAuthorization = request.headers['Authorization'];
      return http.Response(
        body == null
            ? jsonEncode({'success': true, 'data': []})
            : jsonEncode(body),
        status,
        headers: {'content-type': 'application/json'},
      );
    });
  }
}

void main() {
  group('loopback detection', () {
    test('localhost and 127.0.0.1 are loopback', () {
      expect(ApiService.isLoopbackHost('localhost'), isTrue);
      expect(ApiService.isLoopbackHost('LOCALHOST'), isTrue);
      expect(ApiService.isLoopbackHost('127.0.0.1'), isTrue);
      expect(ApiService.isLoopbackHost('127.0.0.53'), isTrue);
    });

    test('IPv6 loopback is recognised with or without brackets', () {
      expect(ApiService.isLoopbackHost('::1'), isTrue);
      expect(ApiService.isLoopbackHost('[::1]'), isTrue);
    });

    test('a remote host is not loopback', () {
      for (final host in [
        'review.example.org',
        'api.internal',
        '10.0.0.5',
        '192.168.1.10',
        '0.0.0.0',
        // Lookalikes that must not pass.
        '127.0.0.1.evil.example',
        'localhost.evil.example',
      ]) {
        expect(
          ApiService.isLoopbackHost(host),
          isFalse,
          reason: '$host must not be loopback',
        );
      }
    });
  });

  group('the guard is derived from configuration', () {
    test('a loopback console may use its embedded token', () {
      final api = ApiService(
        baseUrl: 'http://localhost:8080',
        operatorToken: _token,
      );

      expect(api.hasUsableOperatorToken, isTrue);
      expect(api.embeddedTokenWithheld, isFalse);
      expect(api.embeddedTokenWithheldReason, isNull);
    });

    test('a remote console withholds its embedded token', () {
      // The defect this guards: building with a token and pointing the console at
      // a public origin would publish full operator access to every visitor.
      final api = ApiService(
        baseUrl: 'https://review.example.org',
        operatorToken: _token,
      );

      expect(
        api.hasOperatorToken,
        isTrue,
        reason: 'the token is still compiled in',
      );
      expect(api.hasUsableOperatorToken, isFalse);
      expect(api.embeddedTokenWithheld, isTrue);
      expect(api.embeddedTokenWithheldReason, contains('not this machine'));
      expect(
        api.embeddedTokenWithheldReason,
        contains('--dart-define=API_TOKEN'),
      );
    });

    test('the explicit override permits a remote embedded token', () {
      final api = ApiService(
        baseUrl: 'https://review.example.org',
        operatorToken: _token,
        allowRemoteEmbeddedToken: true,
      );

      expect(api.hasUsableOperatorToken, isTrue);
      expect(api.embeddedTokenWithheld, isFalse);
    });

    test('a console with no embedded token is not "withheld"', () {
      // The proxy deployment path: no token in the bundle at all.
      final api = ApiService(baseUrl: 'https://review.example.org');

      expect(api.hasOperatorToken, isFalse);
      expect(api.hasUsableOperatorToken, isFalse);
      expect(api.embeddedTokenWithheld, isFalse);
      expect(api.embeddedTokenWithheldReason, isNull);
    });

    test('an unparseable base URL does not get the token', () {
      final api = ApiService(baseUrl: 'not a url', operatorToken: _token);

      expect(api.hasUsableOperatorToken, isFalse);
      expect(api.embeddedTokenWithheld, isTrue);
    });

    test('the reason is available before any request is attempted', () {
      // Derived from configuration, not recorded as a side effect, so the UI can
      // explain the situation up front.
      final recorder = _Recorder();
      final api = ApiService(
        baseUrl: 'https://review.example.org',
        operatorToken: _token,
        client: recorder.client(),
      );

      expect(api.embeddedTokenWithheldReason, isNotNull);
      expect(
        recorder.requests,
        isEmpty,
        reason: 'no request should have been made yet',
      );
    });
  });

  group('the withheld token is genuinely absent from the request', () {
    test('a loopback console sends the operator token', () async {
      final recorder = _Recorder();
      final api = ApiService(
        baseUrl: 'http://localhost:8080',
        operatorToken: _token,
        client: recorder.client(),
      );

      await api.fetchSessions();

      expect(recorder.requests, hasLength(1));
      expect(recorder.lastAuthorization, 'Bearer $_token');
    });

    test('a remote console sends no Authorization header at all', () async {
      final recorder = _Recorder();
      final api = ApiService(
        baseUrl: 'https://review.example.org',
        operatorToken: _token,
        client: recorder.client(),
      );

      await api.fetchSessions();

      expect(recorder.requests, hasLength(1));
      expect(
        recorder.lastAuthorization,
        isNull,
        reason: 'the embedded token must not reach a non-loopback host',
      );
      expect(recorder.requests.single.containsKey('Authorization'), isFalse);
    });

    test(
      'the override does send it, which is the documented tradeoff',
      () async {
        final recorder = _Recorder();
        final api = ApiService(
          baseUrl: 'https://review.example.org',
          operatorToken: _token,
          allowRemoteEmbeddedToken: true,
          client: recorder.client(),
        );

        await api.fetchSessions();
        expect(recorder.lastAuthorization, 'Bearer $_token');
      },
    );

    test(
      'a candidate token is still sent when the operator token is withheld',
      () async {
        // A candidate console is unaffected: it never had an embedded operator
        // token, and its own session token is scoped to one candidate.
        final recorder = _Recorder();
        final api = ApiService(
          baseUrl: 'https://review.example.org',
          operatorToken: _token,
          client: recorder.client(),
        )..sessionToken = 'candidate-token-value';

        await api.fetchSessions();

        expect(api.embeddedTokenWithheld, isTrue);
        expect(
          recorder.lastAuthorization,
          'Bearer candidate-token-value',
          reason:
              'a withheld operator token must not suppress a candidate token',
        );
      },
    );

    test('a proxy deployment sends no Authorization header', () async {
      // The reference deployment: the console is built without a token and the
      // proxy adds one server-side.
      final recorder = _Recorder();
      final api = ApiService(
        baseUrl: 'https://review.example.org',
        client: recorder.client(),
      );

      await api.fetchSessions();

      expect(recorder.lastAuthorization, isNull);
      expect(
        api.embeddedTokenWithheld,
        isFalse,
        reason: 'there is nothing to withhold',
      );
    });
  });
}
