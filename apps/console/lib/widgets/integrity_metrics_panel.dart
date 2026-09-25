import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/integrity.dart';
import '../providers/review_provider.dart';
import '../theme/app_theme.dart';

/// Right panel: the integrity timeline for the selected session.
///
/// Shows the reviewer the advisory integrity score, the structured flags with
/// their individual descriptions and timestamps, any plagiarism report, and the
/// ordered telemetry timeline. Nothing here is presented as proof of misconduct:
/// every entry is an indicator for a human to verify.

class IntegrityMetricsPanel extends StatelessWidget {
  const IntegrityMetricsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<ReviewProvider>();
    final review = provider.selected;
    if (review == null) return _emptyState(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (review.latestReport != null)
          _ScoreHeader(report: review.latestReport!),
        const Divider(height: 1),
        if (review.timelineTruncated)
          _truncationNotice(context, provider, review),
        Expanded(
          child: review.timeline.isEmpty
              ? _noEvents(context)
              : ListView(
                  padding: const EdgeInsets.all(12),
                  children: [
                    if (review.latestReport != null) ...[
                      _flagsSection(context, review.latestReport!),
                      _plagiarismSection(context, review.latestReport!),
                      _anomaliesSection(context, review.latestReport!),
                      const Divider(height: 24),
                      Text(
                        'Telemetry timeline',
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      const SizedBox(height: 8),
                    ],
                    ...review.timeline.map(
                      (entry) => _TimelineTile(entry: entry),
                    ),
                  ],
                ),
        ),
      ],
    );
  }

  /// States plainly that the timeline is a page, and offers the next one.
  ///
  /// A reviewer deciding whether evidence supports a conclusion has to know when
  /// they are looking at part of the record. The count comes from the API's true
  /// total, not from what happens to be loaded.
  Widget _truncationNotice(
    BuildContext context,
    ReviewProvider provider,
    ReviewRecord review,
  ) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final held = review.timeline.length;

    return Container(
      width: double.infinity,
      color: scheme.tertiaryContainer,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.warning_amber_outlined,
                size: 18,
                color: scheme.onTertiaryContainer,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Partial timeline: showing $held of ${review.timelineTotal} '
                  'recorded events, newest first. Older events are not loaded.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: scheme.onTertiaryContainer,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: provider.isLoadingOlder
                  ? null
                  : () => provider.loadOlderEvents(),
              icon: provider.isLoadingOlder
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.history, size: 16),
              label: Text(
                provider.isLoadingOlder ? 'Loading…' : 'Load older events',
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _emptyState(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.shield_outlined,
            size: 64,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(height: 16),
          Text(
            'Integrity signals appear here',
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Select a session to review its timeline',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _noEvents(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.check_circle_outline,
            size: 40,
            color: theme.colorScheme.outline,
          ),
          const SizedBox(height: 8),
          Text(
            'No telemetry recorded for this session',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }

  Widget _flagsSection(BuildContext context, IntegrityReport report) {
    final theme = Theme.of(context);
    if (report.flags.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Text(
          'No integrity flags were raised.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.outline,
          ),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Flags (${report.flags.length})',
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        ...report.flags.map((flag) => _FlagCard(flag: flag)),
      ],
    );
  }

  Widget _plagiarismSection(BuildContext context, IntegrityReport report) {
    final theme = Theme.of(context);
    final plagiarism = report.plagiarismReport;
    if (plagiarism == null) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 12),
      child: Card(
        color: theme.colorScheme.surfaceContainerLow,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Similarity report', style: theme.textTheme.titleSmall),
              const SizedBox(height: 8),
              _labelledMeter(
                context,
                'Similarity to reference material',
                plagiarism.overallSimilarity,
              ),
              const SizedBox(height: 8),
              _labelledMeter(
                context,
                'Machine-generated likelihood',
                plagiarism.aiCompletionLikelihood,
              ),
              if (plagiarism.matchedSnippets.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  'Matched snippets (${plagiarism.matchedSnippets.length})',
                  style: theme.textTheme.labelMedium,
                ),
                const SizedBox(height: 6),
                ...plagiarism.matchedSnippets
                    .take(5)
                    .map(
                      (match) => Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              '${(match.similarityScore * 100).toStringAsFixed(0)}% · ${match.sourceLabel}',
                              style: theme.textTheme.labelSmall?.copyWith(
                                color: theme.colorScheme.primary,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(8),
                              decoration: BoxDecoration(
                                color:
                                    theme.colorScheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                match.candidateSnippet,
                                maxLines: 4,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontFamily: 'monospace',
                                  fontSize: 11,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _anomaliesSection(BuildContext context, IntegrityReport report) {
    final theme = Theme.of(context);
    if (report.behavioralAnomalies.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Behavioural anomalies (${report.behavioralAnomalies.length})',
          style: theme.textTheme.titleSmall,
        ),
        const SizedBox(height: 8),
        ...report.behavioralAnomalies.map(
          (anomaly) => Card(
            color: theme.colorScheme.surfaceContainerLow,
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              dense: true,
              leading: const Icon(Icons.insights_outlined, size: 18),
              title: Text(
                anomaly.anomalyType,
                style: theme.textTheme.labelLarge,
              ),
              subtitle: Text(
                '${anomaly.description}\nObserved ${anomaly.metricValue} against a threshold of ${anomaly.threshold}',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _labelledMeter(BuildContext context, String label, double value) {
    final theme = Theme.of(context);
    final colour = value >= 0.8
        ? AppTheme.brandRed
        : value >= 0.6
        ? AppTheme.brandAmber
        : AppTheme.brandGreen;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Expanded(child: Text(label, style: theme.textTheme.bodySmall)),
            Text(
              '${(value * 100).toStringAsFixed(0)}%',
              style: theme.textTheme.labelMedium?.copyWith(
                color: colour,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: LinearProgressIndicator(
            value: value.clamp(0.0, 1.0),
            minHeight: 8,
            backgroundColor: theme.colorScheme.surfaceContainerHighest,
            valueColor: AlwaysStoppedAnimation(colour),
          ),
        ),
      ],
    );
  }
}

class _ScoreHeader extends StatelessWidget {
  const _ScoreHeader({required this.report});

  final IntegrityReport report;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colour = AppTheme.severityColor(report.severity);

    return Container(
      padding: const EdgeInsets.all(16),
      color: colour.withValues(alpha: 0.08),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Integrity signal score', style: theme.textTheme.titleSmall),
              _Badge(text: report.severity.toUpperCase(), colour: colour),
            ],
          ),
          const SizedBox(height: 4),
          Align(
            alignment: Alignment.centerLeft,
            child: Text(
              'Advisory only — indicators for a reviewer, not a finding of misconduct.',
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.outline,
              ),
            ),
          ),
          const SizedBox(height: 12),
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: report.overallScore / 100),
            duration: const Duration(milliseconds: 800),
            curve: Curves.easeOutCubic,
            builder: (context, value, _) => Column(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(4),
                  child: LinearProgressIndicator(
                    value: value,
                    minHeight: 10,
                    backgroundColor: theme.colorScheme.surfaceContainerHighest,
                    valueColor: AlwaysStoppedAnimation(colour),
                  ),
                ),
                const SizedBox(height: 4),
                Align(
                  alignment: Alignment.centerRight,
                  child: Text(
                    '${report.overallScore.toStringAsFixed(1)} / 100',
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: colour,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _chip(theme, Icons.flag_outlined, '${report.flags.length} flags'),
              const SizedBox(width: 12),
              _chip(theme, Icons.timer_outlined, _clock(report.generatedAt)),
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(ThemeData theme, IconData icon, String label) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 13, color: theme.colorScheme.outline),
        const SizedBox(width: 4),
        Text(
          label,
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.outline,
          ),
        ),
      ],
    );
  }

  /// Renders a UTC or offset timestamp in the reviewer's local time zone.
  String _clock(String timestamp) {
    if (timestamp.isEmpty) return '—';
    final parsed = DateTime.tryParse(timestamp);
    if (parsed == null) return timestamp;
    final local = parsed.toLocal();
    final hh = local.hour.toString().padLeft(2, '0');
    final mm = local.minute.toString().padLeft(2, '0');
    return '$hh:$mm';
  }
}

class _FlagCard extends StatelessWidget {
  const _FlagCard({required this.flag});

  final IntegrityFlag flag;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colour = AppTheme.severityColor(flag.severity);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      color: theme.colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    flag.label,
                    style: theme.textTheme.labelLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                _Badge(text: flag.severity.toUpperCase(), colour: colour),
              ],
            ),
            const SizedBox(height: 6),
            Text(flag.description, style: theme.textTheme.bodySmall),
            const SizedBox(height: 6),
            Row(
              children: [
                Text(
                  'Confidence ${(flag.confidence * 100).toStringAsFixed(0)}%',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    flag.timestamp,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                      fontSize: 10,
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.colour});

  final String text;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: colour.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
          color: colour,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

class _TimelineTile extends StatelessWidget {
  const _TimelineTile({required this.entry});

  final TimelineEntry entry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colour = AppTheme.severityColor(entry.severity);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: colour.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(_icon(entry.eventType), size: 18, color: colour),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          entry.label.isEmpty ? entry.eventType : entry.label,
                          style: theme.textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      _Badge(
                        text: entry.severity.toUpperCase(),
                        colour: colour,
                      ),
                    ],
                  ),
                  if (entry.detail.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      entry.detail,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontFamily: 'monospace',
                        fontSize: 11,
                      ),
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  const SizedBox(height: 4),
                  Text(
                    entry.timestamp,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.outline,
                      fontSize: 10,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  IconData _icon(String eventType) {
    switch (eventType) {
      case 'KEYSTROKE':
        return Icons.keyboard;
      case 'PASTE_TRIGGER':
        return Icons.content_paste;
      case 'CODE_DELTA':
        return Icons.account_tree;
      case 'TAB_SWITCH':
        return Icons.tab_unselected;
      case 'WINDOW_BLUR':
        return Icons.visibility_off;
      case 'COPY_ATTEMPT':
        return Icons.copy;
      case 'DEVELOPER_TOOLS_OPEN':
        return Icons.terminal;
      case 'FULLSCREEN_EXIT':
        return Icons.fullscreen_exit;
      case 'SUBMIT':
        return Icons.send;
      default:
        return Icons.help_outline;
    }
  }
}
