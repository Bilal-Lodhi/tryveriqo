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

class _GeneratePanelState extends State<GeneratePanel> {
  final _promptController = TextEditingController();
  final _roleController = TextEditingController(text: 'backend-engineer');
  int _problemCount = 3;
  bool _isGenerating = false;
  String? _error;
  String? _summary;

  @override
  void dispose() {
    _promptController.dispose();
    _roleController.dispose();
    super.dispose();
  }

  Future<void> _generate() async {
    final prompt = _promptController.text.trim();
    if (prompt.isEmpty) {
      setState(() => _error = 'Describe the assessment you want to generate.');
      return;
    }

    setState(() {
      _isGenerating = true;
      _error = null;
      _summary = null;
    });

    try {
      final result = await widget.api.generateSuite(
        prompt,
        problemCount: _problemCount,
        roleContext: _roleController.text.trim(),
      );
      final suite = result.suite;
      final problems = (suite?['problems'] as List<dynamic>?)?.length ?? 0;
      final suiteId =
          (suite?['metadata'] as Map<String, dynamic>?)?['suiteId']
              as String? ??
          'unknown';
      setState(() {
        _summary =
            'Generated $problems problem(s). Suite id: $suiteId. '
            'The suite was persisted for issue to candidates.';
      });
    } on ApiException catch (e) {
      setState(() {
        _error = e.isUnauthorised
            ? 'Generation requires the operator credential. '
                  'Rebuild the console with --dart-define=API_TOKEN=...'
            : e.message;
      });
    } catch (e) {
      setState(() => _error = 'Generation failed: $e');
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
          if (_summary != null) ...[
            const SizedBox(height: 16),
            Card(
              color: theme.colorScheme.primaryContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(_summary!, style: theme.textTheme.bodySmall),
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 16),
            Card(
              color: theme.colorScheme.errorContainer,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Text(
                  _error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onErrorContainer,
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
