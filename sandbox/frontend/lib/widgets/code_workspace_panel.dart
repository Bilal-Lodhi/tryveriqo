import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../providers/review_provider.dart';
import '../models/guardian_model.dart';

/// ─── Cerberus AI — Left Panel: Code Submission Workspace ────────────────────
/// Renders the candidate's final code submission in a syntax-highlighted
/// monospace viewer. Supports language label badges and copy-to-clipboard.

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

    if (review == null) {
      return _buildEmptyState(context);
    }

    return _buildCodeViewer(context, review);
  }

  Widget _buildEmptyState(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(Icons.code_off, size: 64, color: theme.colorScheme.outline),
          const SizedBox(height: 16),
          Text(
            'Select a review record',
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Code submissions appear here',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCodeViewer(BuildContext context, ReviewRecord record) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Header bar
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
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primaryContainer,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  'CODE',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onPrimaryContainer,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              IconButton(
                icon: Icon(
                  _copied ? Icons.check : Icons.copy,
                  size: 18,
                  color: _copied ? Colors.green : null,
                ),
                tooltip: _copied ? 'Code copied successfully' : 'Copy code',
                onPressed: () {
                  Clipboard.setData(ClipboardData(text: record.codeSubmission));
                  setState(() => _copied = true);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: const Text('Code copied successfully'),
                      duration: const Duration(seconds: 2),
                      behavior: SnackBarBehavior.floating,
                      width: 220,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  );
                  Future.delayed(const Duration(seconds: 3), () {
                    if (mounted) {
                      setState(() => _copied = false);
                    }
                  });
                },
              ),
            ],
          ),
        ),

        // Code body
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: SelectableText(
              record.codeSubmission.isEmpty
                  ? '// No code submitted yet'
                  : record.codeSubmission,
              style: TextStyle(
                fontFamily: 'monospace',
                fontSize: 13,
                height: 1.6,
                color: record.codeSubmission.isEmpty
                    ? theme.colorScheme.outline
                    : theme.colorScheme.onSurface,
              ),
            ),
          ),
        ),

        // Session info footer
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
                  'Session: ${record.sessionId} | Status: ${record.status}',
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
}
