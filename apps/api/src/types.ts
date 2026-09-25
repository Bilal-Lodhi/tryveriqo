/**
 * Core domain types for the tryveriqo integrity platform.
 *
 * Vocabulary is deliberately Assessment-native: candidates sit assessments
 * made of problems; reviewer-facing signals are integrity signals backed by
 * structured plagiarism reports. Nothing here models employee, audit, vector or
 * successor-product concepts — see docs/provenance.md for that history.
 */

// ─── Assessment generation contracts ───────────────────────────────

export interface DifficultyMix {
  beginner: number;
  intermediate: number;
  advanced: number;
}

export interface OrchestratorPrompt {
  /** Natural-language description of the assessment to generate. */
  prompt: string;
  /** Target role context, e.g. "senior-backend", "frontend-react". */
  roleContext: string;
  /** Number of problems to generate. */
  problemCount: number;
  difficultyMix: DifficultyMix;
}

/** The generated assessment test suite — the central artefact of this product. */
export interface GeneratedTestSuite {
  metadata: SuiteMetadata;
  roles: RoleDescriptor[];
  competencies: CompetencyTree[];
  problems: GeneratedProblem[];
  testingMatrices: HiddenTestingMatrix[];
}

export interface SuiteMetadata {
  suiteId: string;
  generatedAt: string;
  /** Provider model identifier that produced the suite. */
  modelVersion: string;
  /** SHA-256 of the originating prompt. */
  promptFingerprint: string;
  tokenUsage: TokenUsageStats;
}

export interface TokenUsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RoleDescriptor {
  roleId: string;
  title: string;
  seniorityLevel: "junior" | "mid" | "senior" | "lead" | "principal";
  requiredCompetencyIds: string[];
}

export interface CompetencyTree {
  competencyId: string;
  name: string;
  description: string;
  weight: number;
  subCompetencies: CompetencyTree[];
}

export interface GeneratedProblem {
  problemId: string;
  problemType: "mcq" | "coding" | "essay" | "interactive";
  title: string;
  body: string;
  language?: string;
  starterCode?: string;
  testCases?: HiddenTestCase[];
  options?: MCQOption[];
  expectedAnswer?: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  competencyId: string;
  timeAllocationSeconds: number;
  maxScore: number;
}

export interface HiddenTestCase {
  caseId: string;
  input: string;
  expectedOutput: string;
  /** false = hidden from the candidate. */
  isPublic: boolean;
  timeoutMs: number;
}

export interface MCQOption {
  optionId: string;
  text: string;
  isCorrect: boolean;
  explanation: string;
}

export interface HiddenTestingMatrix {
  matrixId: string;
  problemId: string;
  competencyIds: string[];
  scoringFormula: ScoringFormula;
  integrityThresholds: IntegrityThresholds;
}

export interface ScoringFormula {
  type: "weighted_sum" | "all_or_nothing" | "partial_credit";
  weights: Record<string, number>;
}

/**
 * Per-problem thresholds used when turning raw telemetry into integrity
 * signals. These are reviewer-assistance heuristics, not proof of misconduct.
 */
export interface IntegrityThresholds {
  maxPasteEvents: number;
  maxTimeBetweenKeystrokesMs: number;
  plagiarismSimilarityThreshold: number;
  structuralChangeSensitivity: number;
}

// ─── Candidate telemetry ───────────────────────────────────────────

export interface MicroEvent {
  eventId: string;
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  problemId: string;
  eventType: MicroEventType;
  /** ISO-8601 UTC with milliseconds. */
  timestamp: string;
  payload: MicroEventPayload;
  clientMetadata: ClientMetadata;
}

export type MicroEventType =
  | "KEYSTROKE"
  | "PASTE_TRIGGER"
  | "CODE_DELTA"
  | "TAB_SWITCH"
  | "WINDOW_BLUR"
  | "COPY_ATTEMPT"
  | "DEVELOPER_TOOLS_OPEN"
  | "FULLSCREEN_EXIT"
  | "SUBMIT";

export interface MicroEventPayload {
  char?: string;
  deltaMs?: number;
  diffPatch?: string;
  pasteContent?: string;
  selectedText?: string;
  visibilityState?: "visible" | "hidden";
  devToolsOpen?: boolean;
}

export interface ClientMetadata {
  userAgent: string;
  /** Coarse, server-observed or client-reported address; not used for grading. */
  ipAddress: string;
  screenResolution: string;
  platform: string;
  language: string;
}

// ─── Integrity signals ─────────────────────────────────────────────

/**
 * An integrity report bundles the reviewer-assistance signals derived from a
 * candidate's telemetry. It is advisory: it surfaces suspicious behaviour
 * indicators for a human reviewer, and never asserts misconduct.
 */
export interface IntegrityReport {
  integrityReportId: string;
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  /** 0-100 heuristic score; higher means more suspicious signals. */
  overallScore: number;
  flags: IntegrityFlag[];
  plagiarismReport: PlagiarismReport | null;
  behavioralAnomalies: BehavioralAnomaly[];
  keystrokeMetrics?: KeystrokeMetrics;
  generatedAt: string;
}

export interface IntegrityFlag {
  flagType: string;
  severity: "low" | "medium" | "high" | "critical";
  sourceEventId: string;
  description: string;
  confidence: number;
  timestamp: string;
}

export interface KeystrokeMetrics {
  avgDeltaMs: number;
  maxDeltaMs: number;
  minDeltaMs: number;
  sampleCount: number;
}

/** Structured similarity report comparing submitted code against references. */
export interface PlagiarismReport {
  /** 0-1 similarity against the highest-matching reference. */
  overallSimilarity: number;
  matchedSnippets: PlagiarismMatch[];
  /** 0-1 heuristic likelihood that the submission is machine-generated. */
  aiCompletionLikelihood: number;
}

export interface PlagiarismMatch {
  sourceSnippet: string;
  candidateSnippet: string;
  similarityScore: number;
  /** Human-readable origin, e.g. "gemini-2.5-flash-completion", "public-repo". */
  sourceLabel: string;
}

export interface BehavioralAnomaly {
  anomalyType: string;
  description: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  metricValue: number;
  threshold: number;
}

// ─── Session lifecycle ─────────────────────────────────────────────

export type SessionStatus =
  | "in_progress"
  | "submitted"
  | "flagged"
  | "evaluated"
  | "terminated";

export interface AssessmentSession {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  problemId?: string;
  status: SessionStatus;
  submittedCode?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ─── API request/response contracts ────────────────────────────────

export interface GenerateTestSuiteRequest {
  prompt: string;
  roleContext: string;
  problemCount: number;
  difficultyMix: DifficultyMix;
}

export interface GenerateTestSuiteResponse {
  success: boolean;
  suite: GeneratedTestSuite;
  /** MCP correlation id for the persistence call. */
  mcpCorrelationId: string;
}

export interface IngestMicroEventRequest {
  events: MicroEvent[];
}

export interface IngestMicroEventResponse {
  success: boolean;
  processedCount: number;
  integrityReport: IntegrityReport | null;
  /** Whether the configured alert threshold was breached. */
  alertTriggered: boolean;
}

export interface SessionReviewResponse {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  status: SessionStatus;
  submittedCode: string;
  timeline: TimelineEntry[];
  integritySummary: IntegrityReport[];
  finalScore: number | null;
  /**
   * Telemetry paging disclosure.
   *
   * `timeline` carries at most one page of events, newest-first from the store
   * and re-ordered ascending here. `timelineTotal` is the true stored count, so a
   * caller can always tell whether what it received is the whole record.
   */
  timelineTotal: number;
  timelineReturned: number;
  timelineTruncated: boolean;
  /** Pass as `?eventOffset=` to fetch the next older page, or null when complete. */
  nextEventOffset: number | null;
}

export interface TimelineEntry {
  timestamp: string;
  eventType: string;
  label: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

export interface SessionSummary {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  status: SessionStatus;
  /** True stored event total, not the size of the page it was derived from. */
  eventCount: number;
  pasteCount: number;
  tabSwitchCount: number;
  integrityScore: number;
  lastEventTimestamp: string | null;
  /**
   * True when `pasteCount` and `tabSwitchCount` were derived from a page rather
   * than the whole record, so the cohort list does not present sampled counts as
   * complete ones.
   */
  countsSampled: boolean;
}

// ─── Identity ──────────────────────────────────────────────────────

export interface IdentityPayload {
  displayName: string;
  candidateId: string;
  role?: string;
}

export interface IdentityResponse {
  success: boolean;
  identity: IdentityPayload;
  /** Short-lived HMAC-signed token scoped to this candidate. */
  sessionToken: string;
  expiresAt: string;
}

// ─── MCP transport contracts ───────────────────────────────────────

export interface McpToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  correlationId: string;
}

export interface McpToolResult {
  correlationId: string;
  toolName: string;
  success: boolean;
  data: unknown;
  error?: string;
  mongoDocumentId?: string;
}
