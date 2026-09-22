import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/review_provider.dart';
import '../models/guardian_model.dart';

/// ─── Cerberus AI — Right Panel: Security Metrics Timeline ───────────────────
/// Scrollable ListView rendering timestamped suspicion scores, micro-event
/// evidence, and timeline entries from the Hono API review endpoint.

class SecurityMetricsPanel extends StatelessWidget {
  const SecurityMetricsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final review = context.watch<ReviewProvider>().selected;

    if (review == null) {
      return _buildEmptyState(context);
    }

    return _buildMetricsView(context, review);
  }

  Widget _buildEmptyState(BuildContext context) {
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
            'Security metrics appear here',
            style: theme.textTheme.titleMedium?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            'Select a review record to view the timeline',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMetricsView(BuildContext context, ReviewRecord record) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Suspicion score header bar (if available)
        if (record.latestSuspicion != null)
          _buildScoreHeader(theme, record.latestSuspicion!),
        const Divider(height: 1),

        // Timeline entries
        Expanded(
          child: record.timeline.isEmpty
              ? _buildNoEventsPlaceholder(theme)
              : ListView.builder(
                  padding: const EdgeInsets.all(12),
                  itemCount: record.timeline.length,
                  itemBuilder: (context, index) {
                    return _buildTimelineTile(theme, record.timeline[index]);
                  },
                ),
        ),
      ],
    );
  }

  Widget _buildScoreHeader(ThemeData theme, SuspicionPayload suspicion) {
    final color = _severityColor(suspicion.severity, theme);

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.08)),
      child: Column(
        children: [
          // Score gauge
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text('Suspicion Score', style: theme.textTheme.titleSmall),
              _severityBadge(theme, suspicion.severity),
            ],
          ),
          const SizedBox(height: 12),
          TweenAnimationBuilder<double>(
            tween: Tween(begin: 0, end: suspicion.suspicionScore / 100),
            duration: const Duration(milliseconds: 800),
            curve: Curves.easeOutCubic,
            builder: (context, value, _) {
              return Column(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(4),
                    child: LinearProgressIndicator(
                      value: value,
                      minHeight: 10,
                      backgroundColor:
                          theme.colorScheme.surfaceContainerHighest,
                      valueColor: AlwaysStoppedAnimation(color),
                    ),
                  ),
                  const SizedBox(height: 4),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Text(
                      '${suspicion.suspicionScore.toStringAsFixed(1)} / 100',
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: color,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              _metricChip(
                theme,
                Icons.event,
                '${suspicion.flaggedEvents.length} events',
              ),
              const SizedBox(width: 12),
              _metricChip(
                theme,
                Icons.timer_outlined,
                _formatTimestamp(suspicion.generatedAt),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildNoEventsPlaceholder(ThemeData theme) {
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
            'No suspicious events detected',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.outline,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTimelineTile(ThemeData theme, Map<String, dynamic> entry) {
    final eventType = entry['eventType'] as String? ?? 'unknown';
    final label = entry['label'] as String? ?? eventType;
    final detail = entry['detail'] as String? ?? '';
    final severity = entry['severity'] as String? ?? 'info';
    final timestamp = _parseTimelineTimestamp(entry['timestamp']);
    final eventColor = _timelineSeverityColor(severity, theme);

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: theme.colorScheme.surfaceContainerLow,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Event type icon
            Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: eventColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(
                _timelineIcon(eventType),
                size: 18,
                color: eventColor,
              ),
            ),
            const SizedBox(width: 12),
            // Details
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Text(
                          label,
                          style: theme.textTheme.labelMedium?.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      _severityBadge(theme, severity),
                    ],
                  ),
                  if (detail.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      detail,
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
                    _formatTimestamp(timestamp),
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  Widget _severityBadge(ThemeData theme, String severity) {
    final color = _severityColor(severity, theme);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        severity.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  Widget _metricChip(ThemeData theme, IconData icon, String label) {
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

  Color _severityColor(String severity, ThemeData theme) {
    switch (severity) {
      case 'critical':
        return Colors.red;
      case 'elevated':
        return Colors.orange;
      default:
        return theme.colorScheme.primary;
    }
  }

  Color _timelineSeverityColor(String severity, ThemeData theme) {
    switch (severity) {
      case 'critical':
        return Colors.red;
      case 'warning':
        return Colors.orange;
      default:
        return theme.colorScheme.primary;
    }
  }

  IconData _timelineIcon(String eventType) {
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

  /// Handles timestamps that may arrive as numeric epoch (ms) or ISO-8601 strings.
  String _parseTimelineTimestamp(dynamic value) {
    if (value == null) return '';
    if (value is String) return value;
    if (value is num) {
      return DateTime.fromMillisecondsSinceEpoch(
        value.toInt(),
      ).toUtc().toIso8601String();
    }
    return value.toString();
  }

  String _formatTimestamp(String timestamp) {
    if (timestamp.isEmpty) return '—';
    try {
      final dt = DateTime.parse(timestamp).toLocal();
      final hour = dt.hour.toString().padLeft(2, '0');
      final minute = dt.minute.toString().padLeft(2, '0');
      final second = dt.second.toString().padLeft(2, '0');
      return '$hour:$minute:$second';
    } catch (_) {
      return timestamp;
    }
  }
}
