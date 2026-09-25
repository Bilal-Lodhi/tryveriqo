import 'package:flutter/material.dart';

import '../services/api_client.dart';

/// Assessment generation panel.
///
/// Turns one description into a structured assessment suite. Requires the
/// operator credential: generation calls a paid AI provider, so it is never
/// anonymous.

class GeneratePanel extends StatefulWidget {
  const GeneratePanel({required this.api, super.key});

  final ApiService api;

  @override
  State<GeneratePanel> createState() => _GeneratePanelState();
}

/// How a generation attempt ended. The panel renders a distinct state for each,
/// because collapsing them is how a cancelled or unpersisted generation gets
/// reported as a success.
enum _Outcome { none, generated, generatedNotPersisted, cancelled, failed }

class _GeneratePanelState extends State<GeneratePanel> {
  final _promptController = TextEditingController();
  final _roleController = TextEditingController(text: 'backend-engineer');
  int _problemCount = 3;
  bool _isGenerating = false;
  _Outcome _outcome = _Outcome.none;
  String? _message;

  @override
  void dispose() {
    _promptController.dispose();
    _roleController.dispose();
    super.dispose();
  }

  /// Describes what the API actually reported, without overstating it.
  ///
  /// The API can answer `200` with `success: false` for a cancelled request, and
  /// a suite can be generated but not persisted. Claiming persistence in either
  /// case would tell a reviewer to issue an assessment that does not exist.
  ({_Outcome outcome, String message}) _describe(GenerateResult result) {
    if (result.cancelled) {
      return (
        outcome: _Outcome.cancelled,
        message:
            'Generation was cancelled. Nothing was generated, and nothing was '
            'saved.',
      );
    }

    if (result.error != null && result.error!.isNotEmpty) {
      return (outcome: _Outcome.failed, message: result.error!);
    }

    if (!result.success || !result.hasSuite) {
      return (
        outcome: _Outcome.failed,
        message:
            'The server did not return a suite. Nothing was saved. Check the '
            'API logs for the correlation id.',
      );
    }

    final suite = result.suite!;
    final problems = (suite['problems'] as List<dynamic>?)?.length ?? 0;
    final suiteId =
        (suite['metadata'] as Map<String, dynamic>?)?['suiteId'] as String? ??
        'unknown';

    if (!result.persisted) {
      return (
        outcome: _Outcome.generatedNotPersisted,
        message:
            'Generated $problems problem(s). Suite id: $suiteId. It was NOT '
            'saved: the assessment store rejected the write, so this suite '
            'exists only in this response and cannot be issued to candidates.',
      );
    }

    return (
      outcome: _Outcome.generated,
      message:
          'Generated $problems problem(s). Suite id: $suiteId. The suite was '
          'saved and can be issued to candidates.',
    );
  }

  Future<void> _generate() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty) {
      setState(() {
        _outcome = _Outcome.failed;
        _message = 'Describe the assessment you want to generate.';
      });
      return;
    }

    setState(() {
      _isGenerating = true;
      _outcome = _Outcome.none;
      _message = null;
    });

    try {
      final result = await widget.api.generateSuite(
        prompt,
        problemCount: _problemCount,
        roleContext: _roleController.text.trim(),
      );
      final described = _describe(result);
      setState(() {
        _outcome = described.outcome;
        _message = described.message;
      });
    } on ApiException catch (e) {
      setState(() {
        _outcome = _Outcome.failed;
        _message = e.isUnauthorised
            ? 'Generation requires the operator credential. '
                  'Rebuild the console with --dart-define=API_TOKEN=...'
            : e.message;
      });
    } catch (e) {
      setState(() {
        _outcome = _Outcome.failed;
        _message = 'Generation failed: $e';
      });
    } finally {
      if (mounted) setState(() => _isGenerating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Generate an assessment', style: theme.textTheme.titleLarge),
          const SizedBox(height: 4),
          Text(
            'Describe the role and the skills to assess. The model returns a '
            'structured suite with competencies, problems and hidden test cases.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 20),
          TextField(
            controller: _promptController,
            maxLines: 6,
            decoration: const InputDecoration(
              labelText: 'Assessment description',
              hintText:
                  'e.g. A mid-level backend assessment covering async patterns, '
                  'database indexing and error handling',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _roleController,
                  decoration: const InputDecoration(
                    labelText: 'Role context',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 16),
              SizedBox(
                width: 150,
                child: DropdownButtonFormField<int>(
                  initialValue: _problemCount,
                  decoration: const InputDecoration(
                    labelText: 'Problems',
                    border: OutlineInputBorder(),
                  ),
                  items: const [1, 2, 3, 5, 8, 10]
                      .map(
                        (count) => DropdownMenuItem(
                          value: count,
                          child: Text('$count'),
                        ),
                      )
                      .toList(),
                  onChanged: (value) {
                    if (value != null) setState(() => _problemCount = value);
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: _isGenerating ? null : _generate,
            icon: _isGenerating
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.auto_awesome),
            label: Text(_isGenerating ? 'Generating…' : 'Generate assessment'),
          ),
          if (_message != null && _outcome != _Outcome.none) ...[
            const SizedBox(height: 16),
            _OutcomeCard(outcome: _outcome, message: _message!),
          ],
        ],
      ),
    );
  }
}

/// Renders a generation outcome with a severity that matches what happened.
///
/// A generated-but-unsaved suite is deliberately *not* styled as a success: it
/// is the case where an operator is most likely to assume something was saved.
class _OutcomeCard extends StatelessWidget {
  const _OutcomeCard({required this.outcome, required this.message});

  final _Outcome outcome;
  final String message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    final (
      Color background,
      Color foreground,
      IconData icon,
    ) = switch (outcome) {
      _Outcome.generated => (
        scheme.primaryContainer,
        scheme.onPrimaryContainer,
        Icons.check_circle_outline,
      ),
      _Outcome.generatedNotPersisted => (
        scheme.tertiaryContainer,
        scheme.onTertiaryContainer,
        Icons.warning_amber_outlined,
      ),
      _Outcome.cancelled => (
        scheme.surfaceContainerHighest,
        scheme.onSurfaceVariant,
        Icons.cancel_outlined,
      ),
      _Outcome.failed => (
        scheme.errorContainer,
        scheme.onErrorContainer,
        Icons.error_outline,
      ),
      _Outcome.none => (scheme.surface, scheme.onSurface, Icons.info_outline),
    };

    return Card(
      color: background,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18, color: foreground),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                message,
                style: theme.textTheme.bodySmall?.copyWith(color: foreground),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
