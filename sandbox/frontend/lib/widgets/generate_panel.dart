import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/generate_model.dart';
import '../providers/generate_provider.dart';

/// ─── Cerberus AI — Generate Panel ───────────────────────────────────────────
/// Structured assessment generator with mandatory fields, validation,
/// and manual retry UI for transient API errors.
///
/// Auto-retry logic is handled by [GenerateProvider]; this widget only
/// surfaces the final state after auto-retries are exhausted (or success).

class GeneratePanel extends StatefulWidget {
  const GeneratePanel({super.key});

  @override
  State<GeneratePanel> createState() => _GeneratePanelState();
}

class _GeneratePanelState extends State<GeneratePanel> {
  final _promptController = TextEditingController();
  final _scrollController = ScrollController();

  // ── Structured mandatory fields ────────────────────────────────────────
  String _selectedDomain = '';
  int _problemCount = 1;
  double _beginnerWeight = 0.3;
  double _intermediateWeight = 0.5;
  double _advancedWeight = 0.2;

  /// Each difficulty tier must account for at least this fraction (10%).
  static const double _difficultyFloor = 0.1;

  /// Broad domain categories covering the full professional spectrum.
  /// Users select a domain; their free-text prompt is then scoped through
  /// that domain's lens when sent to Gemini.
  static const _domainOptions = <Map<String, String>>[
    {'value': '', 'label': '— Select a domain —'},
    {'value': 'software-engineering', 'label': 'Software Engineering'},
    {'value': 'healthcare-medicine', 'label': 'Healthcare & Medicine'},
    {'value': 'finance-accounting', 'label': 'Finance & Accounting'},
    {'value': 'legal-law', 'label': 'Legal & Law'},
    {'value': 'education-teaching', 'label': 'Education & Teaching'},
    {'value': 'marketing-sales', 'label': 'Marketing & Sales'},
    {'value': 'hr-recruitment', 'label': 'HR & Recruitment'},
    {'value': 'operations-logistics', 'label': 'Operations & Logistics'},
    {
      'value': 'construction-engineering',
      'label': 'Construction & Engineering',
    },
    {'value': 'retail-ecommerce', 'label': 'Retail & E-Commerce'},
    {'value': 'media-journalism', 'label': 'Media & Journalism'},
    {'value': 'hospitality-tourism', 'label': 'Hospitality & Tourism'},
    {'value': 'agriculture-farming', 'label': 'Agriculture & Farming'},
    {
      'value': 'government-public-service',
      'label': 'Government & Public Service',
    },
    {'value': 'manufacturing', 'label': 'Manufacturing'},
    {'value': 'arts-design', 'label': 'Arts & Design'},
    {'value': 'data-science-analytics', 'label': 'Data Science & Analytics'},
    {'value': 'cybersecurity', 'label': 'Cybersecurity'},
    {'value': 'real-estate', 'label': 'Real Estate'},
    {'value': 'energy-utilities', 'label': 'Energy & Utilities'},
    {'value': 'other', 'label': 'Other / General'},
  ];

  /// Maps each domain value to a Material [IconData] (no emoji → no font crash).
  static const _domainIcons = <String, IconData>{
    'software-engineering': Icons.computer,
    'healthcare-medicine': Icons.medical_services_outlined,
    'finance-accounting': Icons.account_balance_outlined,
    'legal-law': Icons.gavel_outlined,
    'education-teaching': Icons.school_outlined,
    'marketing-sales': Icons.campaign_outlined,
    'hr-recruitment': Icons.people_outline,
    'operations-logistics': Icons.local_shipping_outlined,
    'construction-engineering': Icons.construction_outlined,
    'retail-ecommerce': Icons.store_outlined,
    'media-journalism': Icons.newspaper_outlined,
    'hospitality-tourism': Icons.hotel_outlined,
    'agriculture-farming': Icons.agriculture_outlined,
    'government-public-service': Icons.account_balance_outlined,
    'manufacturing': Icons.factory_outlined,
    'arts-design': Icons.palette_outlined,
    'data-science-analytics': Icons.analytics_outlined,
    'cybersecurity': Icons.security_outlined,
    'real-estate': Icons.real_estate_agent_outlined,
    'energy-utilities': Icons.bolt_outlined,
    'other': Icons.public_outlined,
  };

  /// Domain-specific example prompt chips (shown as quick-tap suggestions).
  /// Falls back to generic examples for domains without specific entries.
  static const _domainExampleChips = <String, List<String>>{
    'software-engineering': [
      'React hooks testing',
      'async/await patterns',
      'SQL query optimization',
      'system design interview',
      'API rate limiting',
      'Python data structures',
      'container orchestration',
    ],
    'healthcare-medicine': [
      'patient triage protocols',
      'medication dosage calculation',
      'medical ethics scenarios',
      'anatomy and physiology',
      'diagnostic reasoning',
      'HIPAA compliance',
    ],
    'finance-accounting': [
      'financial statement analysis',
      'IFRS vs GAAP differences',
      'tax planning scenarios',
      'auditing procedures',
      'investment portfolio risk',
      'fraud detection methods',
    ],
    'legal-law': [
      'contract clause interpretation',
      'intellectual property case analysis',
      'criminal law scenarios',
      'legal ethics and professional conduct',
      'constitutional law principles',
      'negotiation and mediation',
    ],
    'education-teaching': [
      'lesson plan design',
      'classroom management strategies',
      'student assessment methods',
      'educational psychology',
      'curriculum alignment',
      'differentiated instruction',
    ],
    'marketing-sales': [
      'brand positioning analysis',
      'SEO and content strategy',
      'sales pipeline management',
      'market segmentation',
      'A/B testing campaigns',
      'CRM best practices',
    ],
    'hr-recruitment': [
      'structured interview design',
      'compensation and benefits',
      'employment law compliance',
      'performance review framework',
      'diversity and inclusion',
      'talent retention strategies',
    ],
    'operations-logistics': [
      'supply chain optimization',
      'inventory management',
      'lean process improvement',
      'logistics network design',
      'warehouse safety protocols',
      'procurement strategy',
    ],
    'construction-engineering': [
      'structural load calculation',
      'building code compliance',
      'site safety planning',
      'material specification',
      'cost estimation methods',
      'project scheduling',
    ],
    'retail-ecommerce': [
      'merchandising strategy',
      'customer experience design',
      'inventory turnover analysis',
      'omnichannel retail',
      'pricing optimization',
      'POS system operations',
    ],
    'media-journalism': [
      'source verification methods',
      'interviewing techniques',
      'editorial ethics',
      'AP style and copy editing',
      'investigative reporting',
      'digital content strategy',
    ],
    'hospitality-tourism': [
      'guest service standards',
      'revenue management',
      'event planning and coordination',
      'food safety and hygiene',
      'hotel operations',
      'travel itinerary design',
    ],
    'agriculture-farming': [
      'crop rotation planning',
      'soil testing and amendment',
      'livestock health management',
      'sustainable farming practices',
      'harvest planning',
      'pest integrated management',
    ],
    'government-public-service': [
      'policy impact analysis',
      'public budget planning',
      'regulatory compliance',
      'constituent service design',
      'emergency preparedness',
      'grant writing',
    ],
    'manufacturing': [
      'production line efficiency',
      'quality control standards',
      'safety compliance audit',
      'lean manufacturing',
      'equipment maintenance',
      'ISO certification prep',
    ],
    'arts-design': [
      'color theory and composition',
      'typography fundamentals',
      'UX/UI design principles',
      'brand identity design',
      'creative brief analysis',
      'portfolio critique',
    ],
    'data-science-analytics': [
      'hypothesis testing',
      'regression analysis',
      'data cleaning and ETL',
      'ML model evaluation',
      'statistical inference',
      'dashboard design',
    ],
    'cybersecurity': [
      'threat modeling',
      'incident response plan',
      'penetration testing',
      'risk assessment framework',
      'encryption standards',
      'SOC compliance',
    ],
    'real-estate': [
      'property valuation methods',
      'market trend analysis',
      'contract and escrow',
      'zoning regulations',
      'REIT fundamentals',
      'property management',
    ],
    'energy-utilities': [
      'grid reliability analysis',
      'renewable energy integration',
      'energy trading basics',
      'carbon credit accounting',
      'power system protection',
      'sustainability metrics',
    ],
    'other': [
      'problem-solving under pressure',
      'scenario-based decision making',
      'role-specific competency evaluation',
      'technical skill assessment',
      'soft skills and communication',
      'knowledge gap analysis',
    ],
  };

  /// Domain-specific keyword hints shown below the structured fields.
  /// Falls back to generic hints when no domain-specific suggestions exist.
  static const _domainKeywords = <String, String>{
    'software-engineering':
        'coding · algorithms · system design · APIs · databases · testing · '
        'CI/CD · microservices · cloud architecture · debugging',
    'healthcare-medicine':
        'patient care · diagnostics · pharmacology · medical ethics · '
        'anatomy · treatment protocols · public health · HIPAA · triage',
    'finance-accounting':
        'financial statements · auditing · risk management · tax planning · '
        'IFRS/GAAP · budgeting · valuation · compliance · investment analysis',
    'legal-law':
        'contract law · litigation · intellectual property · regulatory compliance · '
        'legal research · due diligence · case analysis · negotiation · ethics',
    'education-teaching':
        'curriculum design · pedagogy · assessment methods · classroom management · '
        'lesson planning · educational psychology · student engagement · grading',
    'marketing-sales':
        'brand strategy · SEO/SEM · lead generation · market research · '
        'CRM · content marketing · pipeline management · A/B testing · ROI',
    'hr-recruitment':
        'talent acquisition · onboarding · performance reviews · employment law · '
        'compensation · workforce planning · employee engagement · HRIS · DEI',
    'operations-logistics':
        'supply chain · inventory management · process optimization · lean/Six Sigma · '
        'warehousing · procurement · fleet management · KPI tracking · ERP',
    'construction-engineering':
        'structural analysis · blueprints · material science · site safety · '
        'project estimation · CAD/BIM · building codes · surveying · HVAC',
    'retail-ecommerce':
        'merchandising · inventory turnover · customer experience · omnichannel · '
        'pricing strategy · fulfillment · category management · POS systems',
    'media-journalism':
        'storytelling · fact-checking · editorial ethics · content strategy · '
        'interview technique · AP style · multimedia production · source verification',
    'hospitality-tourism':
        'guest relations · revenue management · event planning · F&B operations · '
        'hotel operations · customer service · travel coordination · safety standards',
    'agriculture-farming':
        'crop science · soil management · livestock care · irrigation · '
        'sustainable farming · pest control · harvest planning · agribusiness',
    'government-public-service':
        'policy analysis · public administration · regulatory affairs · budgeting · '
        'constituent services · grant writing · emergency management · procurement',
    'manufacturing':
        'production planning · quality control · lean manufacturing · safety compliance · '
        'equipment maintenance · supply chain · Kaizen · ISO standards · throughput',
    'arts-design':
        'composition · color theory · typography · UX/UI · branding · '
        'portfolio development · creative direction · prototyping · visual storytelling',
    'data-science-analytics':
        'statistical modeling · machine learning · data visualization · SQL · '
        'ETL pipelines · hypothesis testing · predictive analytics · Python · R',
    'cybersecurity':
        'threat modeling · incident response · penetration testing · SIEM · '
        'risk assessment · encryption · network security · compliance · IAM',
    'real-estate':
        'property valuation · market analysis · contract negotiation · zoning · '
        'REITs · leasing · due diligence · escrow · property management',
    'energy-utilities':
        'grid management · renewable energy · regulatory compliance · energy trading · '
        'sustainability · power systems · carbon credits · smart grids · asset management',
  };

  @override
  void dispose() {
    _promptController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  /// Client-side pre-flight check before calling the API.
  /// Returns null if valid, or an error message string if invalid.
  String? _validatePrompt(String prompt) {
    final trimmed = prompt.trim();

    if (trimmed.isEmpty) {
      return 'Please enter a prompt describing the assessment you want to '
          'generate.';
    }

    // ── Only block clearly non-assessment chat ─────────────────────────
    // Pure greetings
    if (RegExp(
      r'^(hi|hey|hello|yo|sup|hola|howdy|greetings|good\s+(morning|afternoon|evening|night))\s*[!.,]*$',
      caseSensitive: false,
    ).hasMatch(trimmed)) {
      return 'This AI generates assessments. Describe what you want to test — e.g. '
          '"grid reliability analysis for power systems engineers".';
    }
    // Pure small talk / thanks / goodbyes
    if (RegExp(
      r'^(ok|okay|k|kk|alright|fine|cool|nice|great|awesome|thanks|thx|ty|thank\s+you|bye|goodbye|see\s+you|cya|ttyl|later|no|yes|nope|yep|idk|idc|wtf|lol|rofl|lmao|omg|bruh|whatever|meh)\s*[!.,]*$',
      caseSensitive: false,
    ).hasMatch(trimmed)) {
      return 'This AI generates assessments. Describe what you want to test — e.g. '
          '"grid reliability analysis for power systems engineers".';
    }
    // Pure questions about the AI itself
    if (RegExp(
      r'^(what\s+(is|are|do|can)\s+(you|this)|how\s+(do|are|can)\s+(you|i)|who\s+(are|is)\s+you|tell\s+me\s+(about|a))\b',
      caseSensitive: false,
    ).hasMatch(trimmed)) {
      return 'This AI generates assessments only. Describe the role, skills, or '
          'competencies you want to test — e.g. "React hooks testing scenarios '
          'for senior frontend engineers".';
    }

    // Everything else is treated as an assessment prompt
    return null;
  }

  /// Shows a persistent alert dialog for validation or API errors.
  /// The dialog stays until the user taps "OK" — it does NOT auto-dismiss.
  void _showErrorDialog(String message, {String title = 'Validation Error'}) {
    showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        title: Row(
          children: [
            Icon(Icons.error_outline, color: Theme.of(ctx).colorScheme.error),
            const SizedBox(width: 8),
            Text(title),
          ],
        ),
        content: Text(message),
        actions: [
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
  }

  void _onGenerate() {
    final prompt = _promptController.text;
    if (prompt.trim().isEmpty) return;

    // ── Validate domain is selected ───────────────────────────────────
    if (_selectedDomain.isEmpty) {
      _showErrorDialog(
        'Please select a domain (e.g. "Software Engineering") before generating.',
        title: 'Missing Domain',
      );
      return;
    }

    // ── Client-side semantic check ───────────────────────────────────
    final validationError = _validatePrompt(prompt);
    if (validationError != null) {
      _showErrorDialog(validationError);
      return;
    }

    // ── Build structured prompt with mandatory fields ─────────────────
    final structuredPrompt = _buildStructuredPrompt(prompt);

    FocusScope.of(context).unfocus();
    _promptController.clear();
    context.read<GenerateProvider>().generate(
      structuredPrompt,
      problemCount: _problemCount,
      roleContext: _selectedDomain,
    );
  }

  /// Composes a structured, keyword-rich prompt from the user's free-text
  /// description and the mandatory structured fields (role, count, difficulty).
  String _buildStructuredPrompt(String userPrompt) {
    final domainLabel = _domainOptions.firstWhere(
      (d) => d['value'] == _selectedDomain,
      orElse: () => _domainOptions.first,
    )['label']!;

    final difficultyDesc = _buildDifficultyDescription();

    return '''Domain: $domainLabel
Difficulty distribution: $difficultyDesc
Number of problems: $_problemCount
Requirements: $userPrompt
--- 
IMPORTANT: Scope ALL assessment questions, competencies, and role descriptions 
exclusively within the "$domainLabel" domain. Do NOT generate generic software 
engineering problems unless the domain is Software Engineering.''';
  }

  String _buildDifficultyDescription() {
    final total = _beginnerWeight + _intermediateWeight + _advancedWeight;
    if (total <= 0) return 'balanced';
    return '${(_beginnerWeight / total * 100).round()}% beginner, '
        '${(_intermediateWeight / total * 100).round()}% intermediate, '
        '${(_advancedWeight / total * 100).round()}% advanced';
  }

  void _onRetry() {
    context.read<GenerateProvider>().retry();
  }

  /// Shows a confirmation dialog before cancelling generation.
  void _confirmCancel(ThemeData theme) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        icon: Icon(
          Icons.warning_amber_rounded,
          color: theme.colorScheme.error,
          size: 32,
        ),
        title: const Text('Cancel Generation?'),
        content: const Text(
          'Are you sure you want to stop the current generation? '
          'Your prompt and settings will be saved so you can resume later.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Continue Generating'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.of(ctx).pop();
              context.read<GenerateProvider>().cancel();
            },
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
            ),
            child: const Text('Yes, Cancel'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final gen = context.watch<GenerateProvider>();
    final theme = Theme.of(context);
    final hasResult = gen.suite != null;

    return Column(
      children: [
        // ── Header ──────────────────────────────────────────────────────
        _buildHeader(theme),
        const Divider(height: 1),
        // ── Collapse params when result is showing; full fields otherwise
        if (hasResult)
          _buildCompactParamsBar(theme, gen)
        else ...[
          _buildStructuredFields(theme, gen.isLoading),
          _buildPromptInput(theme, gen.isLoading),
          const SizedBox(height: 12),
        ],
        // ── Body — loading / error / result ──────────────────────────────
        Expanded(child: _buildBody(theme, gen)),
      ],
    );
  }

  // ── Header ────────────────────────────────────────────────────────────────
  Widget _buildHeader(ThemeData theme) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Icon(Icons.auto_awesome, size: 20, color: theme.colorScheme.primary),
          const SizedBox(width: 8),
          Text(
            'Test Suite Generator',
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const Spacer(),
          // Reset button (visible when suite exists)
          Consumer<GenerateProvider>(
            builder: (_, gen, __) {
              if (gen.suite == null && gen.error == null) {
                return const SizedBox.shrink();
              }
              return IconButton(
                icon: Icon(
                  Icons.refresh,
                  size: 20,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                tooltip: 'Reset',
                onPressed: gen.isLoading
                    ? null
                    : () {
                        _promptController.clear();
                        context.read<GenerateProvider>().reset();
                      },
              );
            },
          ),
        ],
      ),
    );
  }

  // ── Structured mandatory fields ───────────────────────────────────────────
  Widget _buildStructuredFields(ThemeData theme, bool isLoading) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 8),
          // Section label
          Row(
            children: [
              Icon(Icons.tune, size: 16, color: theme.colorScheme.primary),
              const SizedBox(width: 6),
              Text(
                'Mandatory Parameters',
                style: theme.textTheme.labelMedium?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          // ── Role selector ──────────────────────────────────────────
          _buildRoleDropdown(theme, isLoading),
          const SizedBox(height: 10),
          // ── Problem count ──────────────────────────────────────────
          _buildProblemCountRow(theme, isLoading),
          const SizedBox(height: 10),
          // ── Difficulty distribution ─────────────────────────────────
          _buildDifficultySliders(theme, isLoading),
          const SizedBox(height: 12),
          // Keyword hints
          _buildKeywordHints(theme),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  /// Compact summary bar shown above results instead of the full-form fields.
  /// Saves vertical space once a suite has been generated, but still displays
  /// the key parameters that were used.
  Widget _buildCompactParamsBar(ThemeData theme, GenerateProvider gen) {
    final domainLabel = _domainOptions.firstWhere(
      (d) => d['value'] == _selectedDomain,
      orElse: () => _domainOptions.first,
    )['label']!;
    final domainIcon = _domainIcons[_selectedDomain] ?? Icons.category_outlined;
    final difficultyDesc =
        '${(_beginnerWeight * 100).round()}E / ${(_intermediateWeight * 100).round()}M / ${(_advancedWeight * 100).round()}H';

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        border: Border(
          bottom: BorderSide(
            color: theme.colorScheme.outlineVariant.withValues(alpha: 0.3),
          ),
        ),
      ),
      child: Row(
        children: [
          Icon(domainIcon, size: 16, color: theme.colorScheme.primary),
          const SizedBox(width: 6),
          Text(
            domainLabel,
            style: theme.textTheme.labelMedium?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(width: 12),
          Icon(Icons.quiz_outlined, size: 14, color: theme.colorScheme.outline),
          const SizedBox(width: 4),
          Text('$_problemCount', style: theme.textTheme.labelSmall),
          const SizedBox(width: 12),
          Icon(Icons.tune, size: 14, color: theme.colorScheme.outline),
          const SizedBox(width: 4),
          Expanded(
            child: Text(
              difficultyDesc,
              style: theme.textTheme.labelSmall,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton.icon(
            icon: const Icon(Icons.edit, size: 14),
            label: const Text('New'),
            style: TextButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 8),
            ),
            onPressed: gen.isLoading
                ? null
                : () {
                    _promptController.clear();
                    context.read<GenerateProvider>().reset();
                  },
          ),
        ],
      ),
    );
  }

  Widget _buildRoleDropdown(ThemeData theme, bool isLoading) {
    return Row(
      children: [
        SizedBox(
          width: 72,
          child: Text(
            'Domain',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        Expanded(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: theme.colorScheme.outlineVariant.withValues(alpha: 0.5),
              ),
            ),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<String>(
                value: _selectedDomain,
                isExpanded: true,
                isDense: true,
                icon: Icon(
                  Icons.arrow_drop_down,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurface,
                ),
                items: _domainOptions.map((domain) {
                  final value = domain['value']!;
                  final icon = _domainIcons[value] ?? Icons.category_outlined;
                  return DropdownMenuItem<String>(
                    value: value,
                    child: Row(
                      children: [
                        Icon(icon, size: 18, color: theme.colorScheme.primary),
                        const SizedBox(width: 8),
                        Text(
                          domain['label']!,
                          style: theme.textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  );
                }).toList(),
                onChanged: isLoading
                    ? null
                    : (value) {
                        if (value != null) {
                          setState(() => _selectedDomain = value);
                        }
                      },
                dropdownColor: theme.colorScheme.surfaceContainerHigh,
                borderRadius: BorderRadius.circular(8),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildProblemCountRow(ThemeData theme, bool isLoading) {
    return Row(
      children: [
        SizedBox(
          width: 72,
          child: Text(
            'Problems',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
        Expanded(
          child: Row(
            children: [
              IconButton(
                icon: Icon(
                  Icons.remove_circle_outline,
                  size: 20,
                  color: theme.colorScheme.primary,
                ),
                onPressed: (isLoading || _problemCount <= 1)
                    ? null
                    : () => setState(() => _problemCount--),
                visualDensity: VisualDensity.compact,
              ),
              SizedBox(
                width: 40,
                child: Text(
                  '$_problemCount',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    color: theme.colorScheme.primary,
                  ),
                ),
              ),
              IconButton(
                icon: Icon(
                  Icons.add_circle_outline,
                  size: 20,
                  color: theme.colorScheme.primary,
                ),
                onPressed: (isLoading || _problemCount >= 20)
                    ? null
                    : () => setState(() => _problemCount++),
                visualDensity: VisualDensity.compact,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: SliderTheme(
                  data: SliderTheme.of(
                    context,
                  ).copyWith(activeTrackColor: theme.colorScheme.primary),
                  child: Slider(
                    value: _problemCount.toDouble(),
                    min: 1,
                    max: 20,
                    divisions: 19,
                    onChanged: isLoading
                        ? null
                        : (v) => setState(() => _problemCount = v.round()),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildDifficultySliders(ThemeData theme, bool isLoading) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const SizedBox(width: 72),
            // Show distribution summary
            Expanded(
              child: Text(
                'Difficulty: ${(_beginnerWeight * 100).round()}% easy · '
                '${(_intermediateWeight * 100).round()}% med · '
                '${(_advancedWeight * 100).round()}% hard',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 4),
        _buildDifficultySlider(
          theme,
          'Easy',
          _beginnerWeight,
          Colors.green,
          isLoading,
          (v) => setState(() => _beginnerWeight = v),
        ),
        _buildDifficultySlider(
          theme,
          'Medium',
          _intermediateWeight,
          Colors.orange,
          isLoading,
          (v) => setState(() => _intermediateWeight = v),
        ),
        _buildDifficultySlider(
          theme,
          'Hard',
          _advancedWeight,
          Colors.red,
          isLoading,
          (v) => setState(() => _advancedWeight = v),
        ),
      ],
    );
  }

  Widget _buildDifficultySlider(
    ThemeData theme,
    String label,
    double value,
    Color color,
    bool isLoading,
    ValueChanged<double> onChanged,
  ) {
    return Row(
      children: [
        SizedBox(
          width: 72,
          child: Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: SliderTheme(
            data: SliderTheme.of(context).copyWith(
              activeTrackColor: color,
              thumbColor: color,
              inactiveTrackColor: color.withValues(alpha: 0.15),
            ),
            child: Slider(
              value: value,
              min: 0,
              max: 1,
              divisions: 10,
              onChanged: isLoading
                  ? null
                  : (v) {
                      // Enforce minimum 10% per tier
                      final clamped = v.clamp(
                        _difficultyFloor,
                        1.0 - _difficultyFloor * 2,
                      ); // leave room for the other two
                      onChanged(clamped);
                    },
            ),
          ),
        ),
        SizedBox(
          width: 36,
          child: Text(
            '${(value * 100).round()}%',
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontFamily: 'monospace',
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildKeywordHints(ThemeData theme) {
    // Look up domain-specific keywords, fall back to generic guidance.
    final keywords = _domainKeywords[_selectedDomain] ?? _fallbackKeywords();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.lightbulb_outline,
            size: 14,
            color: theme.colorScheme.tertiary,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text.rich(
              TextSpan(
                style: theme.textTheme.labelSmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                children: [
                  TextSpan(
                    text: 'Include keywords like: ',
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                  TextSpan(text: keywords),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _fallbackKeywords() =>
      'assessment type (MCQ · coding · essay · interactive) · '
      'target skills · role-specific competencies · scenario-based problems · '
      'knowledge areas · difficulty distribution';

  // ── Prompt input ───────────────────────────────────────────────────────────
  Widget _buildPromptInput(ThemeData theme, bool isLoading) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: TextField(
        controller: _promptController,
        enabled: !isLoading,
        minLines: 2,
        maxLines: 4,
        textInputAction: TextInputAction.send,
        onSubmitted: isLoading ? null : (_) => _onGenerate(),
        decoration: InputDecoration(
          hintText:
              'e.g. "Create an assessment covering core competencies, '
              'scenario-based problems, and practical skill evaluation"',
          hintMaxLines: 2,
          filled: true,
          fillColor: theme.colorScheme.surfaceContainerHighest,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(12),
            borderSide: BorderSide.none,
          ),
          suffixIcon: isLoading
              ? null
              : Padding(
                  padding: const EdgeInsets.only(right: 4),
                  child: IconButton(
                    icon: Icon(
                      Icons.send_rounded,
                      color: theme.colorScheme.primary,
                    ),
                    tooltip: 'Generate',
                    onPressed: _onGenerate,
                  ),
                ),
        ),
      ),
    );
  }

  // ── Body ───────────────────────────────────────────────────────────────────
  Widget _buildBody(ThemeData theme, GenerateProvider gen) {
    // ── Loading state ────────────────────────────────────────────────────
    if (gen.isLoading) {
      return _buildLoadingState(theme);
    }

    // ── Cancelled state with resume ─────────────────────────────────────
    if (gen.isCancelled) {
      return _buildCancelledState(theme, gen);
    }

    // ── Error state with manual retry ────────────────────────────────────
    if (gen.error != null) {
      return _buildErrorState(theme, gen);
    }

    // ── Result state ─────────────────────────────────────────────────────
    if (gen.suite != null) {
      return _buildResultState(theme, gen.suite!);
    }

    // ── Empty / initial state ────────────────────────────────────────────
    return _buildEmptyState(theme);
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  Widget _buildLoadingState(ThemeData theme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 48,
            height: 48,
            child: CircularProgressIndicator(strokeWidth: 3),
          ),
          const SizedBox(height: 20),
          Text(
            _selectedDomain.isEmpty
                ? 'Generating $_problemCount problems…'
                : 'Generating $_problemCount problems for ${_domainOptions.firstWhere((d) => d['value'] == _selectedDomain, orElse: () => const {'label': ''})['label']}…',
            style: theme.textTheme.bodyLarge?.copyWith(
              color: theme.colorScheme.onSurface,
            ),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          Text(
            'This may take 10–30 seconds. Gemini is crafting a structured assessment.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(
            onPressed: () => _confirmCancel(theme),
            icon: const Icon(Icons.stop_circle_outlined, size: 18),
            label: const Text('Cancel Generation'),
            style: OutlinedButton.styleFrom(
              foregroundColor: theme.colorScheme.error,
              side: BorderSide(
                color: theme.colorScheme.error.withValues(alpha: 0.5),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(10),
              ),
            ),
          ),
        ],
      ),
    );
  }

  // ── Cancelled (resume prompt) ──────────────────────────────────────────────
  Widget _buildCancelledState(ThemeData theme, GenerateProvider gen) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.pause_circle_outline,
              size: 48,
              color: theme.colorScheme.tertiary,
            ),
            const SizedBox(height: 16),
            Text(
              'Generation Cancelled',
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.tertiary,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'Your prompt and settings have been saved. You can resume generation at any time.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: () => gen.resume(),
              icon: const Icon(Icons.play_arrow_rounded, size: 18),
              label: const Text('Resume Generation'),
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.colorScheme.tertiary,
                foregroundColor: theme.colorScheme.onTertiary,
                padding: const EdgeInsets.symmetric(
                  horizontal: 28,
                  vertical: 12,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
            const SizedBox(height: 12),
            TextButton(
              onPressed: () => gen.reset(),
              child: Text(
                'Start Fresh',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── Error + Retry ──────────────────────────────────────────────────────────
  Widget _buildErrorState(ThemeData theme, GenerateProvider gen) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.cloud_off_rounded,
              size: 48,
              color: theme.colorScheme.error,
            ),
            const SizedBox(height: 16),
            Text(
              'Generation Failed',
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.error,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Text(
                gen.error!,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: gen.canManualRetry ? _onRetry : null,
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Retry'),
              style: ElevatedButton.styleFrom(
                backgroundColor: theme.colorScheme.primary,
                foregroundColor: theme.colorScheme.onPrimary,
                padding: const EdgeInsets.symmetric(
                  horizontal: 28,
                  vertical: 12,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  Widget _buildResultState(ThemeData theme, GeneratedSuite suite) {
    return ListView(
      controller: _scrollController,
      padding: const EdgeInsets.all(16),
      children: [
        // Suite card
        _SuiteOverviewCard(suite: suite),
        const SizedBox(height: 16),
        // Roles section
        if (suite.roles.isNotEmpty) ...[
          _SectionHeader(
            title: 'Roles (${suite.roles.length})',
            icon: Icons.badge,
          ),
          const SizedBox(height: 8),
          ...suite.roles.map((r) => _RoleCard(role: r)),
          const SizedBox(height: 16),
        ],
        // Competencies section
        if (suite.competencies.isNotEmpty) ...[
          _SectionHeader(
            title: 'Competencies (${suite.competencies.length})',
            icon: Icons.checklist,
          ),
          const SizedBox(height: 8),
          ...suite.competencies.map((c) => _CompetencyCard(competency: c)),
          const SizedBox(height: 16),
        ],
        // Problems section
        if (suite.problems.isNotEmpty) ...[
          _SectionHeader(
            title: 'Problems (${suite.problems.length})',
            icon: Icons.quiz,
          ),
          const SizedBox(height: 8),
          ...suite.problems.map((p) => _ProblemCard(problem: p)),
          const SizedBox(height: 16),
        ],
        // Metadata footer
        _MetadataFooter(metadata: suite.metadata),
      ],
    );
  }

  // ── Empty ──────────────────────────────────────────────────────────────────
  Widget _buildEmptyState(ThemeData theme) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(40),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.auto_awesome,
                size: 48,
                color: theme.colorScheme.outline,
              ),
              const SizedBox(height: 16),
              Text(
                'Autonomous Test Suite Generator',
                style: theme.textTheme.titleMedium?.copyWith(
                  color: theme.colorScheme.outline,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Select a domain, set problem count and difficulty, then describe '
                'the skills and competencies you want to assess.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.outline.withValues(alpha: 0.7),
                ),
              ),
              const SizedBox(height: 20),
              // ── Quick example hints ─────────────────────────────────
              _buildExampleChips(theme),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildExampleChips(ThemeData theme) {
    // No chips when no domain is selected
    if (_selectedDomain.isEmpty) return const SizedBox.shrink();

    // Domain-specific examples; fallback to empty list when missing
    final examples = _domainExampleChips[_selectedDomain] ?? <String>[];

    if (examples.isEmpty) return const SizedBox.shrink();

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const SizedBox(height: 12),
        Text(
          'Example prompts for ${_domainOptions.firstWhere((d) => d['value'] == _selectedDomain)['label']}:',
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.outline.withValues(alpha: 0.7),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          alignment: WrapAlignment.center,
          children: examples.map((label) {
            return ActionChip(
              avatar: Icon(
                Icons.push_pin,
                size: 12,
                color: theme.colorScheme.primary,
              ),
              label: Text(label, style: theme.textTheme.labelSmall),
              visualDensity: VisualDensity.compact,
              onPressed: () {
                _promptController.text = label;
              },
            );
          }).toList(),
        ),
      ],
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Sub-widgets: Result cards
// ═══════════════════════════════════════════════════════════════════════

class _SectionHeader extends StatelessWidget {
  final String title;
  final IconData icon;
  const _SectionHeader({required this.title, required this.icon});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: theme.colorScheme.primary),
        const SizedBox(width: 8),
        Text(
          title,
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.primary,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}

class _SuiteOverviewCard extends StatelessWidget {
  final GeneratedSuite suite;
  const _SuiteOverviewCard({required this.suite});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final meta = suite.metadata;
    // Derive a human-readable title from the first problem or competency
    final derivedTitle = suite.problems.isNotEmpty
        ? suite.problems.first.title
        : (suite.competencies.isNotEmpty ? suite.competencies.first.name : '');
    return Card(
      elevation: 0,
      color: theme.colorScheme.primaryContainer,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              derivedTitle.isNotEmpty ? derivedTitle : 'Untitled Suite',
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onPrimaryContainer,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              'Suite ID: ${meta.suiteId}',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onPrimaryContainer.withValues(
                  alpha: 0.7,
                ),
                fontFamily: 'monospace',
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _RoleCard extends StatelessWidget {
  final RoleDescriptor role;
  const _RoleCard({required this.role});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 6),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: ListTile(
        leading: CircleAvatar(
          backgroundColor: theme.colorScheme.secondaryContainer,
          child: Text(
            role.seniorityLevel.substring(0, 1).toUpperCase(),
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: theme.colorScheme.onSecondaryContainer,
            ),
          ),
        ),
        title: Text(role.title, style: theme.textTheme.bodyMedium),
        subtitle: Text(
          role.seniorityLevel,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodySmall,
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      ),
    );
  }
}

class _CompetencyCard extends StatelessWidget {
  final CompetencyTree competency;
  const _CompetencyCard({required this.competency});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 6),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: ListTile(
        leading: Icon(Icons.star, size: 20, color: theme.colorScheme.secondary),
        title: Text(competency.name, style: theme.textTheme.bodyMedium),
        subtitle: competency.description.isNotEmpty
            ? Text(
                competency.description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall,
              )
            : null,
        trailing: Text(
          '${(competency.weight * 100).round()}%',
          style: theme.textTheme.labelSmall?.copyWith(fontFamily: 'monospace'),
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      ),
    );
  }
}

class _ProblemCard extends StatelessWidget {
  final GeneratedProblem problem;
  const _ProblemCard({required this.problem});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final typeColor = switch (problem.problemType) {
      'coding' => Colors.teal,
      'mcq' => Colors.orange,
      'design' => Colors.purple,
      'essay' => Colors.indigo,
      'interactive' => Colors.blue,
      _ => theme.colorScheme.secondary,
    };
    return Card(
      elevation: 0,
      margin: const EdgeInsets.only(bottom: 6),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      child: ListTile(
        leading: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: typeColor.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(
            problem.problemType.toUpperCase(),
            style: TextStyle(
              fontSize: 10,
              color: typeColor,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        title: Text(
          problem.title,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: theme.textTheme.bodyMedium,
        ),
        subtitle: Row(
          children: [
            Icon(Icons.timer, size: 14, color: theme.colorScheme.outline),
            const SizedBox(width: 4),
            Text(
              '${problem.timeAllocationSeconds ~/ 60} min',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(width: 12),
            Icon(Icons.science, size: 14, color: theme.colorScheme.outline),
            const SizedBox(width: 4),
            Text(
              '${problem.testCases.length} tests',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
      ),
    );
  }
}

class _MetadataFooter extends StatefulWidget {
  final SuiteMetadata metadata;
  const _MetadataFooter({required this.metadata});

  @override
  State<_MetadataFooter> createState() => _MetadataFooterState();
}

class _MetadataFooterState extends State<_MetadataFooter> {
  /// Holds the real generation completion timestamp (set once on first build).
  DateTime? _realGeneratedAt;

  @override
  void initState() {
    super.initState();
    _realGeneratedAt = DateTime.now();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final now = _realGeneratedAt!;

    // Format: "2026-05-30 13:08 PM UTC+5:00"
    final hour = now.hour > 12
        ? now.hour - 12
        : (now.hour == 0 ? 12 : now.hour);
    final period = now.hour >= 12 ? 'PM' : 'AM';
    final offset = now.timeZoneOffset;
    final sign = offset.isNegative ? '-' : '+';
    final offsetAbs = offset.abs();
    final tzLabel =
        'UTC$sign${offsetAbs.inHours.toString().padLeft(2, '0')}:'
        '${offsetAbs.inMinutes.remainder(60).toString().padLeft(2, '0')}';
    final formatted =
        '${now.year}-${now.month.toString().padLeft(2, '0')}-'
        '${now.day.toString().padLeft(2, '0')} '
        '${hour.toString().padLeft(2, '0')}:'
        '${now.minute.toString().padLeft(2, '0')} $period '
        '$tzLabel';

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Wrap(
        spacing: 16,
        runSpacing: 4,
        children: [
          _MetaChip(Icons.model_training, widget.metadata.modelVersion),
          _MetaChip(
            Icons.memory,
            '${widget.metadata.tokenUsage.totalTokens} tokens',
          ),
          _MetaChip(Icons.calendar_today, formatted),
          _MetaChip(Icons.info, 'v1.0'),
        ],
      ),
    );
  }
}

class _MetaChip extends StatelessWidget {
  final IconData icon;
  final String label;
  const _MetaChip(this.icon, this.label);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 12, color: theme.colorScheme.outline),
        const SizedBox(width: 4),
        Text(label, style: theme.textTheme.labelSmall),
      ],
    );
  }
}
