import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../providers/identity_provider.dart';

/// Candidate registration.
///
/// Registers a display name, candidate id and — unless the API is running in
/// the development-only open mode — an operator-issued **registration
/// capability** bound to that candidate id. The API returns a short-lived
/// candidate-scoped session token. There is no password and no account: the
/// console is a development and self-hosted review tool, and the candidate
/// credential exists only to scope telemetry to one candidate.
///
/// The capability is a credential. It is held in memory for the length of the
/// request only, never written to disk, and never logged.

class SessionSetupScreen extends StatefulWidget {
  const SessionSetupScreen({super.key});

  @override
  State<SessionSetupScreen> createState() => _SessionSetupScreenState();
}

class _SessionSetupScreenState extends State<SessionSetupScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _candidateController = TextEditingController();
  final _assessmentController = TextEditingController();
  final _capabilityController = TextEditingController();

  @override
  void dispose() {
    _nameController.dispose();
    _candidateController.dispose();
    _assessmentController.dispose();
    _capabilityController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    await context.read<IdentityProvider>().setIdentity(
      displayName: _nameController.text.trim(),
      candidateId: _candidateController.text.trim(),
      assessmentId: _assessmentController.text.trim(),
      registrationCapability: _capabilityController.text.trim(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final identity = context.watch<IdentityProvider>();

    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 460),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Form(
                  key: _formKey,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Icon(
                        Icons.assignment_ind_outlined,
                        size: 44,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'Assessment review console',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.titleLarge,
                      ),
                      const SizedBox(height: 8),
                      Text(
                        'Register a candidate session to begin. Assessment '
                        'generation and cohort-wide review additionally require '
                        'the operator credential.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.outline,
                        ),
                      ),
                      const SizedBox(height: 24),
                      TextFormField(
                        controller: _nameController,
                        decoration: const InputDecoration(
                          labelText: 'Display name',
                          border: OutlineInputBorder(),
                        ),
                        validator: (value) =>
                            (value == null || value.trim().isEmpty)
                            ? 'A display name is required'
                            : null,
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _candidateController,
                        decoration: const InputDecoration(
                          labelText: 'Candidate id',
                          border: OutlineInputBorder(),
                        ),
                        validator: (value) =>
                            (value == null || value.trim().isEmpty)
                            ? 'A candidate id is required'
                            : null,
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _assessmentController,
                        decoration: const InputDecoration(
                          labelText: 'Assessment id (optional)',
                          helperText:
                              'Required when the registration capability is '
                              'bound to an assessment.',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _capabilityController,
                        obscureText: true,
                        autocorrect: false,
                        enableSuggestions: false,
                        decoration: const InputDecoration(
                          labelText: 'Registration capability',
                          helperText:
                              'Issued by the assessment operator. Required '
                              'unless the server runs in development open '
                              'registration mode.',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: 24),
                      FilledButton(
                        onPressed: identity.isLoading ? null : _submit,
                        child: identity.isLoading
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Text('Start session'),
                      ),
                      if (identity.error != null) ...[
                        const SizedBox(height: 16),
                        Text(
                          identity.error!,
                          textAlign: TextAlign.center,
                          style: theme.textTheme.bodySmall?.copyWith(
                            color: theme.colorScheme.error,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
