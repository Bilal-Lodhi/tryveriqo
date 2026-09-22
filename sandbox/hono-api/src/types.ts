/**
 * Core type definitions for the Gorilla Agent Evaluation Ecosystem.
 * MongoDB partner track - Google Cloud Rapid Agent Hackathon 2026.
 *
 * These types model the pure conceptual requirements of an assessment
 * workflow without referencing legacy Express schemas or controller shapes.
 */

// ─── Gemini Agent Contracts ───────────────────────────────────────

export interface OrchestratorPrompt {
  /** Raw natural-language description of the desired test suite */
  prompt: string;
  /** Target role context (e.g. "senior-backend", "frontend-react") */
  roleContext: string;
  /** Number of problems the generator should produce */
  problemCount: number;
  /** Difficulty distribution weights */
  difficultyMix: DifficultyMix;
}

export interface DifficultyMix {
  beginner: number;   // 0-1 weight
  intermediate: number;
  advanced: number;
}

export interface GeneratedTestSuite {
  metadata: SuiteMetadata;
  roles: RoleDescriptor[];
  competencies: CompetencyTree[];
  problems: GeneratedProblem[];
  testingMatrices: HiddenTestingMatrix[];
}

export interface SuiteMetadata {
  suiteId: string;
  generatedAt: string;          // ISO-8601
  modelVersion: string;         // e.g. "gemini-3-flash-preview"
  promptFingerprint: string;    // SHA-256 of the input prompt
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
  weight: number;               // 0-1 contribution to overall score
  subCompetencies: CompetencyTree[];
}

export interface GeneratedProblem {
  problemId: string;
  problemType: "mcq" | "coding" | "essay" | "interactive";
  title: string;
  body: string;
  language?: string;            // e.g. "typescript", "python"
  starterCode?: string;
  testCases?: HiddenTestCase[];
  options?: MCQOption[];
  expectedAnswer?: string;      // Model solution for auto-grading
  difficulty: "beginner" | "intermediate" | "advanced";
  competencyId: string;
  timeAllocationSeconds: number;
  maxScore: number;
}

export interface HiddenTestCase {
  caseId: string;
  input: string;
  expectedOutput: string;
  isPublic: boolean;            // false = hidden from candidate
  timeoutMs: number;
}

export interface MCQOption {
  optionId: string;
  text: string;
  isCorrect: boolean;
  explanation: string;          // Why this is correct/incorrect
}

export interface HiddenTestingMatrix {
  matrixId: string;
  problemId: string;
  competencyIds: string[];
  scoringFormula: ScoringFormula;
  antiCheatThresholds: AntiCheatThresholds;
}

export interface ScoringFormula {
  type: "weighted_sum" | "all_or_nothing" | "partial_credit";
  weights: Record<string, number>;  // competencyId -> weight
}

export interface AntiCheatThresholds {
  maxPasteEvents: number;
  maxTimeBetweenKeystrokesMs: number;
  plagiarismSimilarityThreshold: number; // 0-1 cosine distance
  structuralChangeSensitivity: number;   // 0-1
}

// ─── Security / Intent Guardian Types ──────────────────────────────

export interface MicroEvent {
  eventId: string;
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  problemId: string;
  eventType: MicroEventType;
  timestamp: string;            // ISO-8601 with millis
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
  /** For KEYSTROKE: the character typed */
  char?: string;
  /** Timestamp delta since previous event in ms */
  deltaMs?: number;
  /** For CODE_DELTA: unified diff of the change */
  diffPatch?: string;
  /** For PASTE_TRIGGER: the pasted content snapshot */
  pasteContent?: string;
  /** For COPY_ATTEMPT: selected text */
  selectedText?: string;
  /** Browser tab visibility state */
  visibilityState?: "visible" | "hidden";
  /** Whether dev tools are open */
  devToolsOpen?: boolean;
}

export interface ClientMetadata {
  userAgent: string;
  ipAddress: string;
  screenResolution: string;
  platform: string;
  language: string;
}

export interface SuspicionPayload {
  suspicionId: string;
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  overallScore: number;          // 0-100 suspicion percentage
  flags: SuspicionFlag[];
  plagiarismReport: PlagiarismReport | null;
  behavioralAnomalies: BehavioralAnomaly[];
  generatedAt: string;           // ISO-8601
}

export interface SuspicionFlag {
  flagType: string;
  severity: "low" | "medium" | "high" | "critical";
  sourceEventId: string;
  description: string;
  confidence: number;            // 0-1
  timestamp: string;
}

export interface PlagiarismReport {
  overallSimilarity: number;     // 0-1
  matchedSnippets: PlagiarismMatch[];
  aiCompletionLikelihood: number; // 0-1 likelihood it's AI-generated
}

export interface PlagiarismMatch {
  sourceSnippet: string;
  candidateSnippet: string;
  similarityScore: number;
  sourceLabel: string;           // e.g. "gemini-3-flash-preview-completion", "github-public-repo"
}

export interface BehavioralAnomaly {
  anomalyType: string;
  description: string;
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  metricValue: number;
  threshold: number;
}

// ─── API Request/Response Contracts ────────────────────────────────

export interface GenerateTestSuiteRequest {
  prompt: string;
  roleContext: string;
  problemCount: number;
  difficultyMix: DifficultyMix;
}

export interface GenerateTestSuiteResponse {
  success: boolean;
  suite: GeneratedTestSuite;
  /** MCP correlation ID for MongoDB audit trail */
  mcpCorrelationId: string;
}

export interface IngestMicroEventRequest {
  events: MicroEvent[];
}

export interface IngestMicroEventResponse {
  success: boolean;
  processedCount: number;
  suspicionPayload: SuspicionPayload | null;
  /** Whether the threshold was breached */
  alertTriggered: boolean;
}

export interface SessionReviewResponse {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  status: "in_progress" | "submitted" | "flagged" | "evaluated";
  submittedCode: string;
  timeline: TimelineEntry[];
  suspicionSummary: SuspicionPayload[];
  finalScore: number | null;
}

export interface TimelineEntry {
  timestamp: string;
  eventType: string;
  label: string;
  severity: "info" | "warning" | "critical";
  detail: string;
}

// ─── Lightweight Identity Types (No Auth — Hackathon Demo) ─────────

export interface IdentityPayload {
  displayName: string;
  candidateId: string;
  role?: string;
}

export interface IdentityResponse {
  success: boolean;
  identity: IdentityPayload;
  sessionToken: string; // ephemeral demo token (UUID, no crypto)
}

// ─── MCP Server Types (MongoDB Track) ──────────────────────────────

export interface MCPToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  correlationId: string;
}

export interface MCPToolResult {
  correlationId: string;
  toolName: string;
  success: boolean;
  data: unknown;
  error?: string;
  mongoDocumentId?: string;
}
