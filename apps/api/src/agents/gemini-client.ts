/**
 * Gemini client — the single AI provider boundary for the tryveriqo API.
 *
 * Provider choice is Gemini, which is what this product was built against. Two
 * transports are supported, selected explicitly by `AI_PROVIDER_MODE`:
 *
 *   gemini-api (default) — Gemini Developer API, authenticated with
 *                          `GEMINI_API_KEY`. Self-hosting friendly.
 *   vertex               — Vertex AI, authenticated with Google Cloud
 *                          Application Default Credentials. Enterprise path.
 *
 * Everything above this file depends on the `AssessmentAiClient` interface, so
 * the route layer never sees provider-specific request or response shapes.
 * Automated tests substitute a stub at exactly this boundary and never call a
 * paid model.
 */

import type { AppConfig } from "../config.js";
import type {
  GeneratedTestSuite,
  IntegrityReport,
  OrchestratorPrompt,
  KeystrokeMetrics,
} from "../types.js";

// ─── Provider-facing contracts ─────────────────────────────────────

export interface IntentVerdict {
  isInputMeaningful: boolean;
  isAssessmentRelated: boolean;
  isAppropriate: boolean;
  contentFlags: string[];
  reason: string;
  confidence: number;
  detectedDomain: string;
  detectedAssessmentType: string;
}

export interface AssessmentAiClient {
  /** Decides whether a prompt is a usable assessment-generation request. */
  classifyAssessmentIntent(
    prompt: string,
    roleContext: string,
    signal?: AbortSignal,
  ): Promise<IntentVerdict>;

  /** Generates a full assessment test suite. */
  generateTestSuite(
    prompt: string,
    roleContext: string,
    problemCount: number,
    signal?: AbortSignal,
  ): Promise<GeneratedTestSuite>;

  /** Derives reviewer-assistance integrity signals from a code submission. */
  analyzeIntegrity(
    code: string,
    pasteContents: string[],
    keystrokeMetrics: KeystrokeMetrics,
    referenceCompletions: string[],
    signal?: AbortSignal,
  ): Promise<IntegrityReport>;
}

/** Raised when the provider is not configured for the requested operation. */
export class ProviderNotConfiguredError extends Error {}

/** Raised when the provider rejects or fails a request. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    /** Whether the caller may reasonably retry. */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

// ─── @google/genai SDK, lazy-loaded for fast cold starts ───────────

export type GenAiModule = typeof import("@google/genai");

/**
 * How the SDK is obtained. The production value imports the real package;
 * tests inject a double here.
 *
 * This is an explicit seam rather than module mocking on purpose. Node's
 * `mock.module` with `exports` is experimental and does not substitute the
 * module on Node 22, so a mocked suite passed on Node 24 and failed on Node 22
 * with "GoogleGenAI is not a constructor". Injecting the loader makes the
 * substitution a normal function argument that behaves identically on every
 * supported Node version.
 */
export type GenAiLoader = () => Promise<GenAiModule>;

let sdkPromise: Promise<GenAiModule> | null = null;

/** The default loader: imports the real SDK once and caches the module. */
export const defaultGenAiLoader: GenAiLoader = () => {
  sdkPromise ??= import("@google/genai");
  return sdkPromise;
};

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;

/** Provider timeout wrapper so a hung request cannot pin a worker forever. */
async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ProviderRequestError(`AI request timed out after ${timeoutMs}ms`, true)),
      timeoutMs,
    );
  });

  const aborted = new Promise<never>((_resolve, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new ProviderRequestError("Assessment generation cancelled by client", false)),
      { once: true },
    );
  });

  try {
    return await Promise.race([operation, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class GeminiAssessmentClient implements AssessmentAiClient {
  private readonly ai: AiProviderConfigView;
  private readonly log: (message: string) => void;
  private readonly loadSdk: GenAiLoader;

  constructor(
    config: AppConfig,
    log: (message: string) => void = console.log,
    /**
     * Overrides how the provider SDK is obtained. Production always uses the
     * default; the test suite injects a fixture double through this argument.
     */
    loadSdk: GenAiLoader = defaultGenAiLoader,
  ) {
    this.ai = config.ai;
    this.log = log;
    this.loadSdk = loadSdk;
  }

  /** True when the configured transport has the credentials it needs. */
  isConfigured(): boolean {
    return this.ai.mode === "gemini-api" ? this.ai.apiKey.length > 0 : this.ai.projectId.length > 0;
  }

  private async createClient(): Promise<InstanceType<GenAiModule["GoogleGenAI"]>> {
    const { GoogleGenAI } = await this.loadSdk();

    if (this.ai.mode === "vertex") {
      if (this.ai.projectId.length === 0) {
        throw new ProviderNotConfiguredError(
          "AI_PROVIDER_MODE=vertex requires GEMINI_VERTEX_PROJECT (and Application Default Credentials).",
        );
      }
      return new GoogleGenAI({
        vertexai: true,
        project: this.ai.projectId,
        location: this.ai.location,
      });
    }

    if (this.ai.apiKey.length === 0) {
      throw new ProviderNotConfiguredError(
        "GEMINI_API_KEY is not set. Set it, or configure Vertex AI with AI_PROVIDER_MODE=vertex.",
      );
    }
    return new GoogleGenAI({ apiKey: this.ai.apiKey });
  }

  // ─── Public API ────────────────────────────────────────────────

  async classifyAssessmentIntent(
    prompt: string,
    roleContext: string,
    signal?: AbortSignal,
  ): Promise<IntentVerdict> {
    const raw = await this.sendMessage(
      this.buildClassifierSystemInstruction(),
      this.buildClassifierUserMessage(prompt, roleContext),
      signal,
    );
    return this.parseClassifierResponse(raw);
  }

  async generateTestSuite(
    prompt: string,
    roleContext: string,
    problemCount: number,
    signal?: AbortSignal,
  ): Promise<GeneratedTestSuite> {
    const orchestratorPrompt: OrchestratorPrompt = {
      prompt,
      roleContext,
      problemCount,
      difficultyMix: { beginner: 0.34, intermediate: 0.33, advanced: 0.33 },
    };
    const raw = await this.sendMessage(
      this.buildOrchestratorSystemInstruction(),
      this.buildOrchestratorUserMessage(orchestratorPrompt),
      signal,
    );
    return this.parseTestSuiteResponse(raw);
  }

  async analyzeIntegrity(
    code: string,
    pasteContents: string[],
    keystrokeMetrics: KeystrokeMetrics,
    referenceCompletions: string[],
    signal?: AbortSignal,
  ): Promise<IntegrityReport> {
    const raw = await this.sendMessage(
      this.buildIntegritySystemInstruction(),
      this.buildIntegrityUserMessage(code, pasteContents, keystrokeMetrics, referenceCompletions),
      signal,
    );
    return this.parseIntegrityResponse(raw);
  }

  // ─── Provider call with retry + backoff ────────────────────────

  private async sendMessage(
    systemInstruction: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      throw new ProviderRequestError("Assessment generation cancelled by client", false);
    }

    const ai = await this.createClient();
    const { HarmCategory, HarmBlockThreshold } = await this.loadSdk();

    const request = {
      model: this.ai.model,
      contents: [{ role: "user" as const, parts: [{ text: userMessage }] }],
      config: {
        systemInstruction: { role: "user" as const, parts: [{ text: systemInstruction }] },
        temperature: this.ai.temperature,
        maxOutputTokens: this.ai.maxOutputTokens,
        topP: 0.95,
        topK: 40,
        responseMimeType: "application/json",
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
        ],
      },
    };

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (signal?.aborted) {
        throw new ProviderRequestError("Assessment generation cancelled by client", false);
      }

      try {
        const startedAt = Date.now();
        const result = await withTimeout(
          ai.models.generateContent(request),
          this.ai.requestTimeoutMs,
          signal,
        );
        const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

        this.log(
          `[ai] ${this.ai.mode === "vertex" ? "vertex" : "gemini-api"} ` +
            `model=${this.ai.model} attempt=${attempt}/${MAX_ATTEMPTS} ` +
            `elapsedMs=${Date.now() - startedAt} textLength=${text.length}`,
        );

        if (text.trim().length === 0) {
          lastError = new ProviderRequestError("AI provider returned an empty response", true);
          continue;
        }
        return text;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const message = lastError.message;

        this.log(`[ai] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`);

        if (lastError instanceof ProviderNotConfiguredError) throw lastError;

        const terminal =
          message.includes("PERMISSION_DENIED") ||
          message.includes("INVALID_ARGUMENT") ||
          message.includes("API key not valid") ||
          message.includes("UNAUTHENTICATED");
        if (terminal) {
          throw new ProviderRequestError(message, false);
        }
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new ProviderRequestError(
      `AI request failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message ?? "unknown"}`,
      true,
    );
  }

  // ─── Response parsing ──────────────────────────────────────────

  private parseTestSuiteResponse(rawText: string): GeneratedTestSuite {
    const parsed = JSON.parse(this.extractJsonObject(rawText)) as GeneratedTestSuite;
    return this.normalizeSuite(parsed);
  }

  /**
   * Repairs the parts of a suite that a language model may omit or malform.
   * Generated ids must be stable and unique so persistence and later review
   * can join on them reliably.
   *
   * Ids the model supplies are treated as authoritative, because a suite's
   * internal cross-references (a problem naming its competency, a matrix naming
   * its problem) are only meaningful against the ids the model itself used.
   *
   * The exception is a *placeholder* id. Asked for "a unique UUID", Gemini 2.5
   * Flash repeatedly answers with the same memorised example — observed live as
   * `a1b2c3d4-e5f6-7890-1234-567890abcdef`. Every suite would then carry an
   * identical `suiteId` and collide on the unique index. A placeholder is
   * therefore replaced with a real UUID rather than trusted.
   */
  private normalizeSuite(suite: GeneratedTestSuite): GeneratedTestSuite {
    const now = new Date().toISOString();
    const suiteId = realId(suite.metadata?.suiteId);

    const competencies = (suite.competencies ?? []).map((competency) => ({
      ...competency,
      competencyId: realId(competency.competencyId),
      subCompetencies: competency.subCompetencies ?? [],
    }));

    const fallbackCompetencyId = competencies[0]?.competencyId ?? "unassigned";
    const declaredCompetencyIds = new Set(competencies.map((c) => c.competencyId));

    const problems = (suite.problems ?? []).map((problem) => ({
      ...problem,
      problemId: realId(problem.problemId),
      // A problem must name a competency that actually exists, or review and
      // scoring cannot join on it. The model's reference survives because the
      // same input id always maps to the same output id above.
      competencyId:
        problem.competencyId && declaredCompetencyIds.has(problem.competencyId)
          ? problem.competencyId
          : fallbackCompetencyId,
      testCases: (problem.testCases ?? []).map((testCase) => ({
        ...testCase,
        caseId: realId(testCase.caseId),
        timeoutMs: testCase.timeoutMs || 2000,
      })),
      options: (problem.options ?? []).map((option) => ({
        ...option,
        optionId: realId(option.optionId),
      })),
    }));

    const testingMatrices = (suite.testingMatrices ?? []).map((matrix) => ({
      ...matrix,
      matrixId: realId(matrix.matrixId),
    }));

    return {
      metadata: {
        suiteId,
        generatedAt: suite.metadata?.generatedAt || now,
        modelVersion: suite.metadata?.modelVersion || this.ai.model,
        promptFingerprint: suite.metadata?.promptFingerprint ?? "",
        tokenUsage: suite.metadata?.tokenUsage ?? {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        },
      },
      roles: suite.roles ?? [],
      competencies,
      problems,
      testingMatrices,
    };
  }

  private parseIntegrityResponse(rawText: string): IntegrityReport {
    const parsed = JSON.parse(this.extractJsonObject(rawText)) as Partial<IntegrityReport>;

    const rawFlags = Array.isArray(parsed.flags) ? parsed.flags : [];
    const flags = rawFlags.map((flag) => {
      // Tolerate the two shapes a model may return: a structured flag object,
      // or a bare string. Structured details must survive into review.
      if (typeof flag === "string") {
        return {
          flagType: flag,
          severity: "medium" as const,
          sourceEventId: "",
          description: flag,
          confidence: 0.5,
          timestamp: new Date().toISOString(),
        };
      }
      return {
        flagType: flag.flagType ?? "UNKNOWN",
        severity: flag.severity ?? "medium",
        sourceEventId: flag.sourceEventId ?? "",
        description: flag.description ?? String(flag.flagType ?? ""),
        confidence: typeof flag.confidence === "number" ? flag.confidence : 0.5,
        timestamp: flag.timestamp ?? new Date().toISOString(),
      };
    });

    return {
      integrityReportId: parsed.integrityReportId || crypto.randomUUID(),
      sessionId: parsed.sessionId ?? "",
      candidateId: parsed.candidateId ?? "",
      assessmentId: parsed.assessmentId ?? "",
      overallScore: clampScore(parsed.overallScore),
      flags,
      plagiarismReport: parsed.plagiarismReport ?? null,
      behavioralAnomalies: parsed.behavioralAnomalies ?? [],
      generatedAt: parsed.generatedAt || new Date().toISOString(),
    };
  }

  private parseClassifierResponse(rawText: string): IntentVerdict {
    const parsed = JSON.parse(this.extractJsonObject(rawText)) as Partial<IntentVerdict>;
    return {
      isInputMeaningful: parsed.isInputMeaningful !== false,
      isAssessmentRelated: parsed.isAssessmentRelated !== false,
      isAppropriate: parsed.isAppropriate !== false,
      contentFlags: Array.isArray(parsed.contentFlags) ? parsed.contentFlags : [],
      reason: parsed.reason ?? "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      detectedDomain: parsed.detectedDomain ?? "",
      detectedAssessmentType: parsed.detectedAssessmentType ?? "",
    };
  }

  // ─── Prompt construction ───────────────────────────────────────

  private buildClassifierSystemInstruction(): string {
    return [
      "You are the intake classifier for an online assessment generation platform.",
      "Decide whether a request is a usable, appropriate request to generate an assessment or test suite.",
      "Reply with JSON only, matching exactly this shape:",
      '{"isInputMeaningful": boolean, "isAssessmentRelated": boolean, "isAppropriate": boolean,',
      ' "contentFlags": string[], "confidence": number, "detectedDomain": string,',
      ' "detectedAssessmentType": string, "reason": string}',
      "isInputMeaningful: false for greetings, keyboard mashing, or content with no request.",
      "isAssessmentRelated: true only when the request asks for an assessment, test, exam or question set.",
      "isAppropriate: false when the request contains profanity, harassment, sexual content, or hate speech.",
      "contentFlags: short upper-snake-case labels for anything inappropriate, otherwise [].",
      "confidence: 0-1 confidence in the assessment-relevance judgement.",
      "detectedDomain: the subject domain, e.g. 'backend engineering', at least 3 characters.",
      "detectedAssessmentType: e.g. 'coding assessment', 'multiple choice exam'.",
      "reason: one short sentence a human can act on.",
    ].join("\n");
  }

  private buildClassifierUserMessage(prompt: string, roleContext: string): string {
    return `Role context: ${roleContext}\n\nAssessment request:\n${prompt}`;
  }

  private buildOrchestratorSystemInstruction(): string {
    return [
      "You are an expert assessment designer. Produce a complete, non-duplicated test suite.",
      "Reply with JSON only, matching exactly this shape:",
      "{",
      '  "metadata": {"suiteId": string, "generatedAt": string, "modelVersion": string,',
      '               "promptFingerprint": string,',
      '               "tokenUsage": {"promptTokens": number, "completionTokens": number, "totalTokens": number}},',
      '  "roles": [{"roleId": string, "title": string, "seniorityLevel": "junior"|"mid"|"senior"|"lead"|"principal",',
      '             "requiredCompetencyIds": string[]}],',
      '  "competencies": [{"competencyId": string, "name": string, "description": string,',
      '                    "weight": number, "subCompetencies": []}],',
      '  "problems": [{"problemId": string, "problemType": "mcq"|"coding"|"essay"|"interactive",',
      '                "title": string, "body": string, "language": string, "starterCode": string,',
      '                "testCases": [{"caseId": string, "input": string, "expectedOutput": string,',
      '                               "isPublic": boolean, "timeoutMs": number}],',
      '                "options": [{"optionId": string, "text": string, "isCorrect": boolean,',
      '                             "explanation": string}],',
      '                "expectedAnswer": string, "difficulty": "beginner"|"intermediate"|"advanced",',
      '                "competencyId": string, "timeAllocationSeconds": number, "maxScore": number}],',
      '  "testingMatrices": [{"matrixId": string, "problemId": string, "competencyIds": string[],',
      '                       "scoringFormula": {"type": "weighted_sum"|"all_or_nothing"|"partial_credit",',
      '                                          "weights": {}},',
      '                       "integrityThresholds": {"maxPasteEvents": number,',
      '                                               "maxTimeBetweenKeystrokesMs": number,',
      '                                               "plagiarismSimilarityThreshold": number,',
      '                                               "structuralChangeSensitivity": number}}]',
      "}",
      "Every problemId and competencyId must be a unique UUID. Every problem.competencyId must",
      "reference a competency you declared. At least one test case per coding problem must have",
      "isPublic false, so the candidate cannot read the full expectation set.",
    ].join("\n");
  }

  private buildOrchestratorUserMessage(prompt: OrchestratorPrompt): string {
    return [
      prompt.prompt,
      "",
      `Role context: ${prompt.roleContext}`,
      `Produce exactly ${prompt.problemCount} problems.`,
      `Difficulty distribution: ${JSON.stringify(prompt.difficultyMix)}.`,
    ].join("\n");
  }

  private buildIntegritySystemInstruction(): string {
    return [
      "You are an assessment integrity analyst assisting a human reviewer.",
      "You compare a candidate's submitted code against reference completions and against the",
      "candidate's own typing telemetry. You report suspicious behaviour indicators; you never",
      "assert that misconduct occurred.",
      "Reply with JSON only, matching exactly this shape:",
      "{",
      '  "overallScore": number,',
      '  "flags": [{"flagType": string, "severity": "low"|"medium"|"high"|"critical",',
      '             "sourceEventId": string, "description": string, "confidence": number,',
      '             "timestamp": string}],',
      '  "plagiarismReport": {"overallSimilarity": number, "aiCompletionLikelihood": number,',
      '                       "matchedSnippets": [{"sourceSnippet": string, "candidateSnippet": string,',
      '                                            "similarityScore": number, "sourceLabel": string}]},',
      '  "behavioralAnomalies": [{"anomalyType": string, "description": string,',
      '                           "evidenceWindowStart": string, "evidenceWindowEnd": string,',
      '                           "metricValue": number, "threshold": number}]',
      "}",
      "overallScore is 0-100, where 0 means no suspicious signal and 100 means strong signal.",
      "Similarity values are 0-1. Set plagiarismReport to null when there is no meaningful",
      "similarity to report. Flag descriptions must be specific enough for a reviewer to verify.",
    ].join("\n");
  }

  private buildIntegrityUserMessage(
    code: string,
    pasteContents: string[],
    keystrokeMetrics: KeystrokeMetrics,
    referenceCompletions: string[],
  ): string {
    const references =
      referenceCompletions.length > 0
        ? referenceCompletions.map((reference, index) => `--- reference ${index + 1} ---\n${reference}`).join("\n\n")
        : "(no reference completions available)";
    const pastes =
      pasteContents.length > 0
        ? pasteContents.map((paste, index) => `--- paste ${index + 1} ---\n${paste}`).join("\n\n")
        : "(no paste events)";

    return [
      "## Submitted code",
      code,
      "",
      "## Reference completions",
      references,
      "",
      "## Pasted content observed in the workspace",
      pastes,
      "",
      "## Typing telemetry",
      JSON.stringify(keystrokeMetrics),
    ].join("\n");
  }

  // ─── JSON recovery ─────────────────────────────────────────────

  /** Extracts the outermost JSON object from model output. */
  private extractJsonObject(text: string): string {
    const fenced = this.stripMarkdownFences(text);
    const start = fenced.indexOf("{");
    const end = fenced.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new ProviderRequestError("AI response did not contain a JSON object", false);
    }
    const candidate = fenced.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      const repaired = this.repairJson(candidate);
      JSON.parse(repaired);
      return repaired;
    }
  }

  private stripMarkdownFences(text: string): string {
    const trimmed = text.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(trimmed);
    return (fence?.[1] ?? trimmed).trim();
  }

  /**
   * Repairs the two JSON defects language models produce most often: trailing
   * commas and literal newlines inside string values.
   */
  private repairJson(text: string): string {
    let repaired = text.replace(/,(\s*[}\]])/g, "$1");
    repaired = this.escapeNewlinesInStrings(repaired);
    return repaired;
  }

  private escapeNewlinesInStrings(text: string): string {
    let result = "";
    let inString = false;
    let escaped = false;

    for (const char of text) {
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        result += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        result += char;
        continue;
      }
      if (inString && char === "\n") {
        result += "\\n";
        continue;
      }
      if (inString && char === "\r") {
        continue;
      }
      if (inString && char === "\t") {
        result += "\\t";
        continue;
      }
      result += char;
    }
    return result;
  }
}

/** Narrowed view of the AI config used by the client. */
type AiProviderConfigView = AppConfig["ai"];

/**
 * Identifiers a model returns when it is asked for a "unique UUID" and answers
 * with a memorised example instead of generating one. Observed live against
 * `gemini-2.5-flash`; the variants cover the same placeholder with different
 * version/variant nibbles.
 */
const PLACEHOLDER_IDS = new Set([
  "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "a1b2c3d4-e5f6-4789-8012-34567890abcd",
  "b1c2d3e4-f5a6-7890-1234-567890abcdef",
  "b1c2d3e4-f5a6-4789-8012-34567890abce",
  "c1d2e3f4-a5b6-7890-1234-567890abcdef",
  "c1d2e3f4-a5b6-4789-8012-34567890abcf",
]);

/**
 * Returns a trustworthy identifier: the model's own value when it is present
 * and not a known placeholder, otherwise a freshly generated UUID.
 */
function realId(value: string | undefined | null): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return crypto.randomUUID();
  if (PLACEHOLDER_IDS.has(trimmed.toLowerCase())) return crypto.randomUUID();
  return trimmed;
}

function clampScore(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}
