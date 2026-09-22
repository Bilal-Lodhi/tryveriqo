import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/identity_provider.dart';

/// ─── Cerberus AI — Identity Setup Screen ─────────────────────────────────────
/// Lightweight "who are you?" screen — no passwords, just name + ID.
/// Shows on first launch; once identity is registered, redirects to dashboard.
///
/// In production this would be a full Auth0 / Firebase Auth / Identity Platform flow.

class IdentitySetupScreen extends StatefulWidget {
  const IdentitySetupScreen({super.key});

  @override
  State<IdentitySetupScreen> createState() => _IdentitySetupScreenState();
}

class _IdentitySetupScreenState extends State<IdentitySetupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _displayNameController = TextEditingController();
  final _candidateIdController = TextEditingController();
  final _roleController = TextEditingController();

  @override
  void dispose() {
    _displayNameController.dispose();
    _candidateIdController.dispose();
    _roleController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;

    final identity = context.read<IdentityProvider>();
    await identity.setIdentity(
      displayName: _displayNameController.text.trim(),
      candidateId: _candidateIdController.text.trim(),
      role: _roleController.text.trim().isNotEmpty
          ? _roleController.text.trim()
          : null,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final identity = context.watch<IdentityProvider>();

    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 48),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // ── Logo & Title ─────────────────────────────────────────────
                Icon(
                  Icons.security,
                  size: 64,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(height: 16),
                Text(
                  'Cerberus AI',
                  style: theme.textTheme.headlineLarge?.copyWith(
                    fontWeight: FontWeight.bold,
                    color: theme.colorScheme.primary,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  'Agentic Assessment Platform',
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 40),

                // ── Form Card ────────────────────────────────────────────────
                Card(
                  elevation: 0,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16),
                    side: BorderSide(color: theme.dividerColor),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Form(
                      key: _formKey,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Text(
                            'Who are you?',
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            'No passwords — just a name to personalize your session.',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: theme.colorScheme.outline,
                            ),
                          ),
                          const SizedBox(height: 20),

                          // Display name
                          TextFormField(
                            controller: _displayNameController,
                            decoration: const InputDecoration(
                              labelText: 'Display Name',
                              hintText: 'e.g. Alice Chen',
                              prefixIcon: Icon(Icons.person_outline),
                              border: OutlineInputBorder(),
                            ),
                            textCapitalization: TextCapitalization.words,
                            textInputAction: TextInputAction.next,
                            enabled: !identity.isLoading,
                            validator: (v) {
                              if (v == null || v.trim().isEmpty) {
                                return 'Please enter your name';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Candidate / user ID
                          TextFormField(
                            controller: _candidateIdController,
                            decoration: const InputDecoration(
                              labelText: 'Candidate ID',
                              hintText: 'e.g. CAND-001',
                              prefixIcon: Icon(Icons.badge_outlined),
                              border: OutlineInputBorder(),
                            ),
                            textInputAction: TextInputAction.next,
                            enabled: !identity.isLoading,
                            validator: (v) {
                              if (v == null || v.trim().isEmpty) {
                                return 'Please enter a candidate ID';
                              }
                              return null;
                            },
                          ),
                          const SizedBox(height: 16),

                          // Role (optional)
                          TextFormField(
                            controller: _roleController,
                            decoration: const InputDecoration(
                              labelText: 'Role (optional)',
                              hintText: 'e.g. Senior Backend Engineer',
                              prefixIcon: Icon(Icons.work_outline),
                              border: OutlineInputBorder(),
                            ),
                            textInputAction: TextInputAction.done,
                            enabled: !identity.isLoading,
                            onFieldSubmitted: (_) => _submit(),
                          ),
                          const SizedBox(height: 24),

                          // Error
                          if (identity.error != null) ...[
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.errorContainer,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Row(
                                children: [
                                  Icon(
                                    Icons.error_outline,
                                    size: 18,
                                    color: theme.colorScheme.error,
                                  ),
                                  const SizedBox(width: 8),
                                  Expanded(
                                    child: Text(
                                      identity.error!,
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: theme
                                                .colorScheme
                                                .onErrorContainer,
                                          ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 16),
                          ],

                          // Submit
                          SizedBox(
                            height: 48,
                            child: FilledButton(
                              onPressed: identity.isLoading ? null : _submit,
                              child: identity.isLoading
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Text(
                                      'Enter Dashboard',
                                      style: TextStyle(fontSize: 16),
                                    ),
                            ),
                          ),
                          const SizedBox(height: 12),

                          // ── Guest mode ────────────────────────────────────
                          SizedBox(
                            height: 48,
                            child: OutlinedButton.icon(
                              onPressed: identity.isLoading
                                  ? null
                                  : () async {
                                      await identity.setIdentity(
                                        displayName: 'Guest Candidate',
                                        candidateId: 'guest-001',
                                        role: 'Guest',
                                      );
                                    },
                              icon: const Icon(
                                Icons.person_off_outlined,
                                size: 20,
                              ),
                              label: const Text(
                                'Continue as Guest',
                                style: TextStyle(fontSize: 16),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 24),

                // ── Footnote ──────────────────────────────────────────────────
                Text(
                  'Identity is ephemeral — resets on page refresh.\n'
                  'Production deployments integrate with Google Cloud Identity Platform.',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.outline,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
