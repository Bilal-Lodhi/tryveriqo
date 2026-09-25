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
import 'package:tryveriqo_console/widgets/generate_panel.dart';

/// An [ApiService] whose generation result is fixed, so the panel can be driven
/// through every outcome without a server.
class _StubApi extends ApiService {
  _StubApi(this.result) : super(baseUrl: 'http://127.0.0.1:1');

  final GenerateResult result;

  @override
  Future<GenerateResult> generateSuite(
    String prompt, {
    required int problemCount,
    required String roleContext,
    String? generationRequestId,
  }) async => result;
}

Map<String, dynamic> _suiteWith({
  required int problems,
  String id = 'suite-1',
}) => {
  'metadata': {'suiteId': id},
  'problems': List.generate(problems, (index) => {'problemId': 'p-$index'}),
};

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

/// Drives the generate panel to a result and returns its rendered text.
Future<String> generateWith(WidgetTester tester, GenerateResult result) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(body: GeneratePanel(api: _StubApi(result))),
    ),
  );

  await tester.enterText(find.byType(TextField).first, 'A backend assessment');
  await tester.tap(find.text('Generate assessment'));
  await tester.pumpAndSettle();

  return tester
      .widgetList<Text>(find.byType(Text))
      .map((text) => text.data ?? '')
      .join('\n');
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

  testWidgets('asks for a registration capability, obscured', (tester) async {
    final api = ApiService(baseUrl: 'http://127.0.0.1:1');
    await tester.pumpWidget(wrap(api));

    expect(find.text('Registration capability'), findsOneWidget);
    expect(find.text('Assessment id (optional)'), findsOneWidget);

    // A capability is a credential: it must not be rendered in clear text.
    final capabilityField = tester.widget<TextField>(
      find.descendant(
        of: find.ancestor(
          of: find.text('Registration capability'),
          matching: find.byType(TextFormField),
        ),
        matching: find.byType(TextField),
      ),
    );
    expect(capabilityField.obscureText, isTrue);
  });

  testWidgets('rejects an incomplete registration without calling the API', (
    tester,
  ) async {
    // The base URL is unreachable, so a real request would surface
    // "Could not reach the identity service." Absence of that message is what
    // proves the API was never called.
    final api = ApiService(baseUrl: 'http://127.0.0.1:1');
    await tester.pumpWidget(wrap(api));

    // The form is taller than the test viewport, so scroll the action into view.
    await tester.ensureVisible(find.text('Start session'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start session'));
    await tester.pump();

    expect(find.text('A display name is required'), findsOneWidget);
    expect(find.text('A candidate id is required'), findsOneWidget);
    expect(find.text('Could not reach the identity service.'), findsNothing);
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

  group('generation outcome reporting', () {
    testWidgets('a persisted suite is reported as saved', (tester) async {
      final text = await generateWith(
        tester,
        GenerateResult(
          suite: _suiteWith(problems: 3),
          success: true,
          persisted: true,
        ),
      );

      expect(text, contains('Generated 3 problem(s)'));
      expect(text, contains('suite-1'));
      expect(text, contains('saved and can be issued'));
    });

    testWidgets('an unpersisted suite never claims it was saved', (
      tester,
    ) async {
      // The defect this replaced: the panel said "The suite was persisted for
      // issue to candidates" whenever a suite came back, so an operator would
      // issue an assessment that does not exist in the store.
      final text = await generateWith(
        tester,
        GenerateResult(
          suite: _suiteWith(problems: 2),
          success: true,
          persisted: false,
        ),
      );

      expect(text, contains('NOT saved'));
      expect(text, contains('cannot be issued to candidates'));
      expect(
        text.contains('was saved and can be issued'),
        isFalse,
        reason: 'an unpersisted suite must never be described as saved',
      );
      expect(text.contains('was persisted'), isFalse);
    });

    testWidgets('a cancelled generation is not reported as a success', (
      tester,
    ) async {
      // The API answers 200 with success:false for a client-cancelled request.
      final text = await generateWith(
        tester,
        const GenerateResult(cancelled: true, error: 'cancelled'),
      );

      expect(text, contains('cancelled'));
      expect(text, contains('Nothing was generated'));
      expect(text.contains('Generated 0 problem'), isFalse);
      expect(
        text.contains('saved and can be issued'),
        isFalse,
        reason: 'a cancelled request must not claim the suite was saved',
      );
    });

    testWidgets('a success without a suite is treated as a failure', (
      tester,
    ) async {
      final text = await generateWith(
        tester,
        const GenerateResult(success: true, persisted: false),
      );

      expect(text, contains('did not return a suite'));
      expect(
        text.contains('saved and can be issued'),
        isFalse,
        reason: 'a response with no suite must not claim anything was saved',
      );
    });

    testWidgets('an explicit error is surfaced verbatim', (tester) async {
      final text = await generateWith(
        tester,
        const GenerateResult(error: 'The assessment provider is unavailable.'),
      );

      expect(text, contains('The assessment provider is unavailable.'));
    });

    testWidgets('a persisted:false response is parsed as unpersisted', (
      tester,
    ) async {
      final parsed = GenerateResult.fromJson({
        'success': true,
        'persisted': false,
        'suite': _suiteWith(problems: 1),
      });

      expect(parsed.success, isTrue);
      expect(parsed.persisted, isFalse);
      expect(parsed.hasSuite, isTrue);
    });

    testWidgets('a cancelled response is parsed as cancelled', (tester) async {
      final parsed = GenerateResult.fromJson({
        'success': false,
        'cancelled': true,
        'error': 'Generation cancelled at the client\'s request.',
      });

      expect(parsed.cancelled, isTrue);
      expect(parsed.success, isFalse);
      expect(parsed.hasSuite, isFalse);
    });
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

    test('selects the newest report, not the last in the array', () {
      // The API returns a session's reports newest-first, so the newest report
      // is FIRST here. A positional `last` would show the reviewer the oldest
      // score and flags.
      final record = ReviewRecord.fromJson({
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'status': 'submitted',
        'submittedCode': '',
        'timeline': [],
        'integritySummary': [
          {
            'integrityReportId': 'report-newest',
            'overallScore': 80,
            'generatedAt': '2026-01-01T03:00:00.000Z',
            'flags': [],
            'behavioralAnomalies': [],
          },
          {
            'integrityReportId': 'report-oldest',
            'overallScore': 10,
            'generatedAt': '2026-01-01T01:00:00.000Z',
            'flags': [],
            'behavioralAnomalies': [],
          },
        ],
      });

      expect(record.latestReport?.integrityReportId, 'report-newest');
      expect(record.latestReport?.overallScore, 80);
    });

    test('newest-report selection does not depend on array order', () {
      final record = ReviewRecord.fromJson({
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'status': 'submitted',
        'submittedCode': '',
        'timeline': [],
        // Deliberately oldest-first this time.
        'integritySummary': [
          {
            'integrityReportId': 'report-oldest',
            'overallScore': 10,
            'generatedAt': '2026-01-01T01:00:00.000Z',
            'flags': [],
            'behavioralAnomalies': [],
          },
          {
            'integrityReportId': 'report-newest',
            'overallScore': 80,
            'generatedAt': '2026-01-01T03:00:00.000Z',
            'flags': [],
            'behavioralAnomalies': [],
          },
        ],
      });

      expect(record.latestReport?.integrityReportId, 'report-newest');
    });

    test('reports without timestamps fall back to the newest-first order', () {
      final record = ReviewRecord.fromJson({
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'status': 'in_progress',
        'submittedCode': '',
        'timeline': [],
        'integritySummary': [
          {
            'integrityReportId': 'first',
            'overallScore': 80,
            'flags': [],
            'behavioralAnomalies': [],
          },
          {
            'integrityReportId': 'second',
            'overallScore': 10,
            'flags': [],
            'behavioralAnomalies': [],
          },
        ],
      });

      expect(record.latestReport?.integrityReportId, 'first');
    });

    test('a review with no reports has no latest report', () {
      final record = ReviewRecord.fromJson({
        'sessionId': 'session-1',
        'candidateId': 'candidate-1',
        'assessmentId': 'assessment-1',
        'status': 'in_progress',
        'submittedCode': '',
        'timeline': [],
        'integritySummary': [],
      });

      expect(record.latestReport, isNull);
    });
  });
}
