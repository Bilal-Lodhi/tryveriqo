import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/integrity.dart';
import '../providers/health_provider.dart';
import '../providers/identity_provider.dart';
import '../providers/integrity_provider.dart';
import '../providers/review_provider.dart';
import '../providers/theme_provider.dart';
import '../services/api_client.dart';
import '../theme/app_theme.dart';
import '../widgets/code_workspace_panel.dart';
import '../widgets/generate_panel.dart';
import '../widgets/integrity_metrics_panel.dart';

/// The reviewer console: a session list on the left, the selected candidate's
/// submission and integrity signals side by side, and assessment generation on
/// its own tab.

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({required this.api, super.key});

  final ApiService api;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final _scaffoldKey = GlobalKey<ScaffoldState>();
  int _tabIndex = 0;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  Future<void> _bootstrap() async {
    if (_started) return;
    _started = true;

    // Resolve the providers before the first await so no BuildContext is used
    // across an asynchronous gap.
    final health = context.read<HealthProvider>();
    final reviews = context.read<ReviewProvider>();
    await health.checkHealth();
    await reviews.loadSessions();
  }

  Future<void> _selectSession(String sessionId) async {
    final navigator = Navigator.of(context);
    final reviews = context.read<ReviewProvider>();
    final integrity = context.read<IntegrityProvider>();

    if (_scaffoldKey.currentState?.isDrawerOpen ?? false) {
      navigator.pop();
    }
    await reviews.loadReview(sessionId);
    if (!mounted) return;
    final record = reviews.selected;
    if (record != null) {
      integrity.loadFromReview(record);
    }
  }

  Future<void> _refresh() async {
    final reviews = context.read<ReviewProvider>();
    await reviews.refresh();
    if (!mounted) return;
    final record = reviews.selected;
    if (record != null) {
      context.read<IntegrityProvider>().loadFromReview(record);
    }
  }

  Future<void> _terminate(SessionSummary session) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Terminate session'),
        content: Text(
          'This permanently deletes the session for ${session.candidateId} '
          'together with its telemetry and integrity reports. This cannot be undone.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Terminate'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    final succeeded = await context.read<ReviewProvider>().terminateSession(
      session.sessionId,
    );
    if (!mounted) return;
    context.read<IntegrityProvider>().clear();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          succeeded
              ? 'Session ${session.sessionId} terminated.'
              : 'Could not terminate the session.',
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final reviews = context.watch<ReviewProvider>();
    final health = context.watch<HealthProvider>();
    final identity = context.watch<IdentityProvider>();

    return Scaffold(
      key: _scaffoldKey,
      appBar: AppBar(
        title: Text(
          _tabIndex == 0 ? 'Review console' : 'Assessment generation',
        ),
        actions: [
          IconButton(
            tooltip: 'Refresh session list',
            icon: const Icon(Icons.refresh),
            onPressed: reviews.isLoading ? null : _refresh,
          ),
          IconButton(
            tooltip: health.status?.isHealthy == true
                ? 'API healthy · ${health.status!.aiModel}'
                : 'API status unknown',
            icon: Icon(
              health.status?.isHealthy == true
                  ? Icons.cloud_done_outlined
                  : Icons.cloud_off_outlined,
              color: health.status?.isHealthy == true
                  ? AppTheme.brandGreen
                  : AppTheme.brandAmber,
            ),
            onPressed: () => context.read<HealthProvider>().checkHealth(),
          ),
          IconButton(
            tooltip: 'Toggle light and dark',
            icon: const Icon(Icons.brightness_6_outlined),
            onPressed: () => context.read<ThemeProvider>().toggleDarkMode(),
          ),
          IconButton(
            tooltip: 'Switch candidate',
            icon: const Icon(Icons.logout),
            onPressed: () {
              context.read<IdentityProvider>().clearIdentity();
              context.read<ReviewProvider>().clearSelection();
              context.read<IntegrityProvider>().clear();
            },
          ),
        ],
      ),
      drawer: _SessionDrawer(
        sessions: reviews.sessions,
        selectedId: reviews.selected?.sessionId,
        isLoading: reviews.isLoading,
        error: reviews.error,
        onSelect: _selectSession,
        onTerminate: _terminate,
        onRefresh: _refresh,
        identity: identity,
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (index) => setState(() => _tabIndex = index),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.dashboard_outlined),
            selectedIcon: Icon(Icons.dashboard),
            label: 'Review',
          ),
          NavigationDestination(
            icon: Icon(Icons.auto_awesome_outlined),
            selectedIcon: Icon(Icons.auto_awesome),
            label: 'Generate',
          ),
        ],
      ),
      body: _tabIndex == 0
          ? _reviewBody(context, reviews)
          : GeneratePanel(api: widget.api),
    );
  }

  Widget _reviewBody(BuildContext context, ReviewProvider reviews) {
    if (reviews.error != null && reviews.sessions.isEmpty) {
      return _ErrorState(message: reviews.error!, onRetry: _refresh);
    }

    return Row(
      children: [
        // A wide layout shows both panels; a narrow one shows the submission
        // first so the reviewer can still work on a small window.
        Expanded(
          flex: 3,
          child: LayoutBuilder(
            builder: (context, constraints) {
              if (constraints.maxWidth >= 900) {
                return const Row(
                  children: [
                    Expanded(child: CodeWorkspacePanel()),
                    VerticalDivider(width: 1),
                    Expanded(child: IntegrityMetricsPanel()),
                  ],
                );
              }
              return const CodeWorkspacePanel();
            },
          ),
        ),
      ],
    );
  }
}

class _SessionDrawer extends StatelessWidget {
  const _SessionDrawer({
    required this.sessions,
    required this.selectedId,
    required this.isLoading,
    required this.error,
    required this.onSelect,
    required this.onTerminate,
    required this.onRefresh,
    required this.identity,
  });

  final List<SessionSummary> sessions;
  final String? selectedId;
  final bool isLoading;
  final String? error;
  final Future<void> Function(String sessionId) onSelect;
  final Future<void> Function(SessionSummary session) onTerminate;
  final Future<void> Function() onRefresh;
  final IdentityProvider identity;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Drawer(
      child: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Sessions', style: theme.textTheme.titleLarge),
                  const SizedBox(height: 4),
                  Text(
                    identity.candidateId == null
                        ? 'No candidate registered'
                        : 'Registered as ${identity.displayName} (${identity.candidateId})',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.outline,
                    ),
                  ),
                ],
              ),
            ),
            if (isLoading) const LinearProgressIndicator(),
            if (error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  error!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.error,
                  ),
                ),
              ),
            Expanded(
              child: sessions.isEmpty
                  ? Center(
                      child: Text(
                        'No sessions recorded yet',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.outline,
                        ),
                      ),
                    )
                  : ListView.builder(
                      itemCount: sessions.length,
                      itemBuilder: (context, index) {
                        final session = sessions[index];
                        return _SessionTile(
                          session: session,
                          selected: session.sessionId == selectedId,
                          onSelect: () => onSelect(session.sessionId),
                          onTerminate: () => onTerminate(session),
                        );
                      },
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(12),
              child: OutlinedButton.icon(
                onPressed: isLoading ? null : onRefresh,
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Refresh'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SessionTile extends StatelessWidget {
  const _SessionTile({
    required this.session,
    required this.selected,
    required this.onSelect,
    required this.onTerminate,
  });

  final SessionSummary session;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onTerminate;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colour = AppTheme.severityColor(_band(session.integrityScore));

    return ListTile(
      selected: selected,
      leading: CircleAvatar(
        backgroundColor: colour.withValues(alpha: 0.18),
        child: Text(
          session.integrityScore.toStringAsFixed(0),
          style: theme.textTheme.labelSmall?.copyWith(
            color: colour,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      title: Text(
        session.candidateId,
        overflow: TextOverflow.ellipsis,
        style: theme.textTheme.bodyMedium,
      ),
      subtitle: Text(
        // The event total is the true stored count. When the per-type counts came
        // from a page, say so rather than presenting sampled numbers as totals.
        '${session.status} · ${session.eventCount} events · '
        '${session.pasteCount} pastes'
        '${session.countsSampled ? ' (from a sample)' : ''}',
        style: theme.textTheme.labelSmall,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: IconButton(
        tooltip: 'Terminate session',
        icon: const Icon(Icons.delete_outline, size: 18),
        onPressed: onTerminate,
      ),
      onTap: onSelect,
    );
  }

  String _band(double score) {
    if (score >= 70) return 'critical';
    if (score >= 40) return 'elevated';
    return 'nominal';
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.lock_outline, size: 48, color: theme.colorScheme.error),
            const SizedBox(height: 16),
            Text(
              message,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
