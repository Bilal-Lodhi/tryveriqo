// ─── Cerberus AI — Test Suite Generator Model ─────────────────────────────
// Models the structured JSON output contract from the Hono API Orchestrator
// backed by Gemini 3 Flash Preview.
//
// Field names match the TypeScript types in sandbox/hono-api/src/types.ts
// exactly (camelCase). The API response envelope is:
//   { success: bool, suite: GeneratedSuite, mcpCorrelationId: string }

class GeneratedSuite {
  final SuiteMetadata metadata;
  final List<RoleDescriptor> roles;
  final List<CompetencyTree> competencies;
  final List<GeneratedProblem> problems;
  final List<HiddenTestingMatrix> testingMatrices;

  const GeneratedSuite({
    required this.metadata,
    required this.roles,
    required this.competencies,
    required this.problems,
    required this.testingMatrices,
  });

  factory GeneratedSuite.fromJson(Map<String, dynamic> json) {
    return GeneratedSuite(
      metadata: SuiteMetadata.fromJson(
        (json['metadata'] as Map<String, dynamic>?) ?? const {},
      ),
      roles: (json['roles'] as List<dynamic>? ?? [])
          .map((r) => RoleDescriptor.fromJson(r as Map<String, dynamic>))
          .toList(),
      competencies: (json['competencies'] as List<dynamic>? ?? [])
          .map((c) => CompetencyTree.fromJson(c as Map<String, dynamic>))
          .toList(),
      problems: (json['problems'] as List<dynamic>? ?? [])
          .map((p) => GeneratedProblem.fromJson(p as Map<String, dynamic>))
          .toList(),
      testingMatrices: (json['testingMatrices'] as List<dynamic>? ?? [])
          .map((m) => HiddenTestingMatrix.fromJson(m as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ── Metadata ─────────────────────────────────────────────────────────────

class SuiteMetadata {
  final String suiteId;
  final String generatedAt;
  final String modelVersion;
  final String promptFingerprint;
  final TokenUsageStats tokenUsage;

  const SuiteMetadata({
    required this.suiteId,
    required this.generatedAt,
    required this.modelVersion,
    required this.promptFingerprint,
    required this.tokenUsage,
  });

  factory SuiteMetadata.fromJson(Map<String, dynamic> json) {
    return SuiteMetadata(
      suiteId: json['suiteId'] as String? ?? '',
      generatedAt: json['generatedAt'] as String? ?? '',
      modelVersion: json['modelVersion'] as String? ?? '',
      promptFingerprint: json['promptFingerprint'] as String? ?? '',
      tokenUsage: TokenUsageStats.fromJson(
        (json['tokenUsage'] as Map<String, dynamic>?) ?? const {},
      ),
    );
  }
}

class TokenUsageStats {
  final int promptTokens;
  final int completionTokens;
  final int totalTokens;

  const TokenUsageStats({
    required this.promptTokens,
    required this.completionTokens,
    required this.totalTokens,
  });

  factory TokenUsageStats.fromJson(Map<String, dynamic> json) {
    return TokenUsageStats(
      promptTokens: json['promptTokens'] as int? ?? 0,
      completionTokens: json['completionTokens'] as int? ?? 0,
      totalTokens: json['totalTokens'] as int? ?? 0,
    );
  }
}

// ── Roles ─────────────────────────────────────────────────────────────────

class RoleDescriptor {
  final String roleId;
  final String title;
  final String seniorityLevel;
  final List<String> requiredCompetencyIds;

  const RoleDescriptor({
    required this.roleId,
    required this.title,
    required this.seniorityLevel,
    required this.requiredCompetencyIds,
  });

  factory RoleDescriptor.fromJson(Map<String, dynamic> json) {
    return RoleDescriptor(
      roleId: json['roleId'] as String? ?? '',
      title: json['title'] as String? ?? '',
      seniorityLevel: json['seniorityLevel'] as String? ?? '',
      requiredCompetencyIds: List<String>.from(
        (json['requiredCompetencyIds'] as List<dynamic>?) ?? [],
      ),
    );
  }
}

// ── Competencies ──────────────────────────────────────────────────────────

class CompetencyTree {
  final String competencyId;
  final String name;
  final String description;
  final double weight;
  final List<CompetencyTree> subCompetencies;

  const CompetencyTree({
    required this.competencyId,
    required this.name,
    required this.description,
    required this.weight,
    required this.subCompetencies,
  });

  factory CompetencyTree.fromJson(Map<String, dynamic> json) {
    return CompetencyTree(
      competencyId: json['competencyId'] as String? ?? '',
      name: json['name'] as String? ?? '',
      description: json['description'] as String? ?? '',
      weight: (json['weight'] as num?)?.toDouble() ?? 0.0,
      subCompetencies: (json['subCompetencies'] as List<dynamic>? ?? [])
          .map((s) => CompetencyTree.fromJson(s as Map<String, dynamic>))
          .toList(),
    );
  }
}

// ── Problems ──────────────────────────────────────────────────────────────

class GeneratedProblem {
  final String problemId;
  final String problemType;
  final String title;
  final String body;
  final String? language;
  final String? starterCode;
  final List<HiddenTestCase> testCases;
  final List<MCQOption> options;
  final String? expectedAnswer;
  final String difficulty;
  final String competencyId;
  final int timeAllocationSeconds;
  final int maxScore;

  const GeneratedProblem({
    required this.problemId,
    required this.problemType,
    required this.title,
    required this.body,
    required this.language,
    required this.starterCode,
    required this.testCases,
    required this.options,
    required this.expectedAnswer,
    required this.difficulty,
    required this.competencyId,
    required this.timeAllocationSeconds,
    required this.maxScore,
  });

  factory GeneratedProblem.fromJson(Map<String, dynamic> json) {
    return GeneratedProblem(
      problemId: json['problemId'] as String? ?? '',
      problemType: json['problemType'] as String? ?? '',
      title: json['title'] as String? ?? '',
      body: json['body'] as String? ?? '',
      language: json['language'] as String?,
      starterCode: json['starterCode'] as String?,
      testCases: (json['testCases'] as List<dynamic>? ?? [])
          .map((t) => HiddenTestCase.fromJson(t as Map<String, dynamic>))
          .toList(),
      options: (json['options'] as List<dynamic>? ?? [])
          .map((o) => MCQOption.fromJson(o as Map<String, dynamic>))
          .toList(),
      expectedAnswer: json['expectedAnswer'] as String?,
      difficulty: json['difficulty'] as String? ?? '',
      competencyId: json['competencyId'] as String? ?? '',
      timeAllocationSeconds: json['timeAllocationSeconds'] as int? ?? 0,
      maxScore: json['maxScore'] as int? ?? 0,
    );
  }
}

class HiddenTestCase {
  final String caseId;
  final String input;
  final String expectedOutput;
  final bool isPublic;
  final int timeoutMs;

  const HiddenTestCase({
    required this.caseId,
    required this.input,
    required this.expectedOutput,
    required this.isPublic,
    required this.timeoutMs,
  });

  factory HiddenTestCase.fromJson(Map<String, dynamic> json) {
    return HiddenTestCase(
      caseId: json['caseId'] as String? ?? '',
      input: json['input'] as String? ?? '',
      expectedOutput: json['expectedOutput'] as String? ?? '',
      isPublic: json['isPublic'] as bool? ?? false,
      timeoutMs: json['timeoutMs'] as int? ?? 0,
    );
  }
}

class MCQOption {
  final String optionId;
  final String text;
  final bool isCorrect;
  final String explanation;

  const MCQOption({
    required this.optionId,
    required this.text,
    required this.isCorrect,
    required this.explanation,
  });

  factory MCQOption.fromJson(Map<String, dynamic> json) {
    return MCQOption(
      optionId: json['optionId'] as String? ?? '',
      text: json['text'] as String? ?? '',
      isCorrect: json['isCorrect'] as bool? ?? false,
      explanation: json['explanation'] as String? ?? '',
    );
  }
}

// ── Testing Matrices ──────────────────────────────────────────────────────

class HiddenTestingMatrix {
  final String matrixId;
  final String problemId;
  final List<String> competencyIds;
  final ScoringFormula scoringFormula;
  final AntiCheatThresholds antiCheatThresholds;

  const HiddenTestingMatrix({
    required this.matrixId,
    required this.problemId,
    required this.competencyIds,
    required this.scoringFormula,
    required this.antiCheatThresholds,
  });

  factory HiddenTestingMatrix.fromJson(Map<String, dynamic> json) {
    return HiddenTestingMatrix(
      matrixId: json['matrixId'] as String? ?? '',
      problemId: json['problemId'] as String? ?? '',
      competencyIds: List<String>.from(
        (json['competencyIds'] as List<dynamic>?) ?? [],
      ),
      scoringFormula: ScoringFormula.fromJson(
        (json['scoringFormula'] as Map<String, dynamic>?) ?? const {},
      ),
      antiCheatThresholds: AntiCheatThresholds.fromJson(
        (json['antiCheatThresholds'] as Map<String, dynamic>?) ?? const {},
      ),
    );
  }
}

class ScoringFormula {
  final String type;
  final Map<String, double> weights;

  const ScoringFormula({required this.type, required this.weights});

  factory ScoringFormula.fromJson(Map<String, dynamic> json) {
    final rawWeights = (json['weights'] as Map<String, dynamic>?) ?? const {};
    return ScoringFormula(
      type: json['type'] as String? ?? '',
      weights: rawWeights.map((k, v) => MapEntry(k, (v as num).toDouble())),
    );
  }
}

class AntiCheatThresholds {
  final int maxPasteEvents;
  final int maxTimeBetweenKeystrokesMs;
  final double plagiarismSimilarityThreshold;
  final double structuralChangeSensitivity;

  const AntiCheatThresholds({
    required this.maxPasteEvents,
    required this.maxTimeBetweenKeystrokesMs,
    required this.plagiarismSimilarityThreshold,
    required this.structuralChangeSensitivity,
  });

  factory AntiCheatThresholds.fromJson(Map<String, dynamic> json) {
    return AntiCheatThresholds(
      maxPasteEvents: json['maxPasteEvents'] as int? ?? 0,
      maxTimeBetweenKeystrokesMs:
          json['maxTimeBetweenKeystrokesMs'] as int? ?? 0,
      plagiarismSimilarityThreshold:
          (json['plagiarismSimilarityThreshold'] as num?)?.toDouble() ?? 0.0,
      structuralChangeSensitivity:
          (json['structuralChangeSensitivity'] as num?)?.toDouble() ?? 0.0,
    );
  }
}
