import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../models/integrity.dart';
import '../providers/review_provider.dart';

/// Left panel: the candidate's submitted code for the selected session.
///
/// The submission is read-only here. Copying is recorded as a reviewer action in
/// the console, which keeps the panel's copy affordance honest: it is a
/// convenience for the reviewer, not a candidate capability.

class CodeWorkspacePanel extends StatefulWidget {
  const CodeWorkspacePanel({super.key});

  @override
  State<CodeWorkspacePanel> createState() => _CodeWorkspacePanelState();
}

class _CodeWorkspacePanelState extends State<CodeWorkspacePanel> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    final review = context.watch<ReviewProvider>().selected;
    if (review == null) return _emptyState(context);
    return _viewer(context, review);
  }

  Widget _emptyState(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.code_off, size: 64, color: theme.colorScheme.outline),
          const SizedBox(height: 16),
          Text(
            'Select a session',
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'The candidate submission appears here',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _viewer(BuildContext context, ReviewRecord record) {
    final theme = Theme.of(context);
    final isEmpty = record.codeSubmission.trim().isEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            border: Border(bottom: BorderSide(color: theme.dividerColor)),
          ),
          child: Row(
            children: [
              Icon(Icons.person, size: 18, color: theme.colorScheme.primary),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  record.candidateId,
                  style: theme.textTheme.titleSmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (record.isLocked) ...[
                Tooltip(
                  message:
                      'This session is ${record.status}: the submission can no longer change.',
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    margin: const EdgeInsets.only(right: 8),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.errorContainer,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.lock_outline,
                          size: 12,
                          color: theme.colorScheme.onErrorContainer,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          record.status.toUpperCase(),
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: theme.colorScheme.onErrorContainer,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              IconButton(
                icon: Icon(
                  _copied ? Icons.check : Icons.copy,
                  size: 18,
                  color: _copied ? Colors.green : null,
                ),
                tooltip: _copied ? 'Copied' : 'Copy submission',
                onPressed: isEmpty ? null : () => _copy(record),
              ),
            ],
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: SelectableText(
              isEmpty ? '// No code submitted yet' : record.codeSubmission,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.6,
                color: isEmpty
                    ? theme.colorScheme.outline
                    : theme.colorScheme.onSurface,
              ),
            ),
          ),
        ),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerLow,
            border: Border(top: BorderSide(color: theme.dividerColor)),
          ),
          child: Row(
            children: [
              Icon(
                Icons.assignment,
                size: 16,
                color: theme.colorScheme.secondary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Session ${record.sessionId} · assessment ${record.assessmentId} · '
                  '${record.finalScore == null ? "no provisional score" : "provisional score ${record.finalScore!.toStringAsFixed(0)}"}',
                  style: theme.textTheme.bodySmall,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Future<void> _copy(ReviewRecord record) async {
    // Capture the messenger before awaiting so no BuildContext is used across
    // an asynchronous gap.
    final messenger = ScaffoldMessenger.of(context);

    await Clipboard.setData(ClipboardData(text: record.codeSubmission));
    if (!mounted) return;

    setState(() => _copied = true);
    messenger.showSnackBar(
      const SnackBar(
        content: Text('Submission copied'),
        duration: Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
        width: 200,
      ),
    );
    Future.delayed(const Duration(seconds: 3), () {
      if (mounted) setState(() => _copied = false);
    });
  }
}
