import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:tryveriqo_console/app.dart';
import 'package:tryveriqo_console/models/integrity.dart';
import 'package:tryveriqo_console/providers/health_provider.dart';
import 'package:tryveriqo_console/providers/identity_provider.dart';
import 'package:tryveriqo_console/providers/integrity_provider.dart';
import 'package:tryveriqo_console/providers/review_provider.dart';
import 'package:tryveriqo_console/providers/theme_provider.dart';
import 'package:tryveriqo_console/services/api_client.dart';

Widget wrap(ApiService api) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider(create: (_) => ThemeProvider()),
      ChangeNotifierProvider(create: (_) => HealthProvider(api)),
      ChangeNotifierProvider(create: (_) => ReviewProvider(api)),
      ChangeNotifierProvider(create: (_) => IntegrityProvider(api)),
      ChangeNotifierProvider(create: (_) => IdentityProvider(api)),
    ],
    child: AssessmentConsoleApp(api: api),
  );
}

void main() {
  testWidgets('shows candidate registration before a session exists', (
    tester,
  ) async {
    final api = ApiService(baseUrl: 'http://127.0.0.1:1');
    await tester.pumpWidget(wrap(api));

    expect(find.text('Assessment review console'), findsOneWidget);
    expect(find.text('Start session'), findsOneWidget);
  });

  testWidgets('rejects an incomplete registration without calling the API', (
    tester,
  ) async {
    final api = ApiService(baseUrl: 'http://127.0.0.1:1');
    await tester.pumpWidget(wrap(api));

    await tester.tap(find.text('Start session'));
    await tester.pump();

    expect(find.text('A display name is required'), findsOneWidget);
    expect(find.text('A candidate id is required'), findsOneWidget);
  });

  testWidgets('renders the reviewer console once a candidate is identified', (
    tester,
  ) async {
    final api = ApiService(baseUrl: 'http://127.0.0.1:1');
    await tester.pumpWidget(wrap(api));

    // Drive the identity provider directly: the registration request itself is
    // covered by the API test suite, and this test asserts the UI transition.
    final context = tester.element(find.byType(AssessmentConsoleApp));
    context.read<IdentityProvider>().adoptSessionForTest(
      displayName: 'Ada Lovelace',
      candidateId: 'candidate-1',
    );
    await tester.pumpAndSettle();

    expect(find.text('Review console'), findsOneWidget);
    expect(find.text('Review'), findsOneWidget);
    expect(find.text('Generate'), findsOneWidget);
  });

  group('integrity model', () {
    test('parses a structured report', () {
      final report = IntegrityReport.fromJson({
        'integrityReportId': 'report-1',
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'overallScore': 72,
        'flags': [
          {
            'flagType': 'LARGE_PASTE',
            'severity': 'high',
            'sourceEventId': 'event-1',
            'description': 'A 900-character block was pasted at once.',
            'confidence': 0.88,
            'timestamp': '2026-01-01T00:05:00.000Z',
          },
        ],
        'plagiarismReport': {
          'overallSimilarity': 0.83,
          'aiCompletionLikelihood': 0.64,
          'matchedSnippets': [
            {
              'sourceSnippet': 'const a = 1;',
              'candidateSnippet': 'const a = 1;',
              'similarityScore': 0.97,
              'sourceLabel': 'reference completion',
            },
          ],
        },
        'behavioralAnomalies': [],
        'generatedAt': '2026-01-01T00:06:00.000Z',
      });

      expect(report.overallScore, 72);
      expect(report.severity, 'critical');
      expect(report.flags.single.label, 'Large Paste');
      expect(report.flags.single.severity, 'high');
      expect(report.plagiarismReport?.overallSimilarity, 0.83);
      expect(
        report.plagiarismReport?.matchedSnippets.single.sourceLabel,
        'reference completion',
      );
    });

    test('tolerates a missing similarity report', () {
      final report = IntegrityReport.fromJson({
        'overallScore': 12,
        'flags': [],
        'plagiarismReport': null,
        'behavioralAnomalies': [],
      });
      expect(report.plagiarismReport, isNull);
      expect(report.severity, 'nominal');
    });

    test('parses a review record and derives the lock state', () {
      final record = ReviewRecord.fromJson({
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'status': 'submitted',
        'submittedCode': 'export const answer = 42;',
        'timeline': [
          {
            'timestamp': '2026-01-01T00:03:00.000Z',
            'eventType': 'SUBMIT',
            'label': 'Submission',
            'severity': 'info',
            'detail': 'Candidate submitted their answer',
          },
        ],
        'integritySummary': [
          {'overallScore': 30, 'flags': [], 'behavioralAnomalies': []},
        ],
        'finalScore': 70,
      });

      expect(record.isLocked, isTrue);
      expect(record.timeline.single.eventType, 'SUBMIT');
      expect(record.latestReport?.overallScore, 30);
      expect(record.finalScore, 70);
    });
  });
}
