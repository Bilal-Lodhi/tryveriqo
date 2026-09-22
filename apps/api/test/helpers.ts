/**
 * Test helpers: a configuration factory and collaborator stubs.
 *
 * Two rules hold everywhere in this suite:
 *   - the paid AI provider is only ever reached through `AssessmentAiClient`,
 *     and every test substitutes a stub at that boundary;
 *   - the MCP tool surface is only reached through `McpClient`, substituted by
 *     an in-memory stub that also lets tests assert which tools were called.
 */

import type { AppConfig } from "../src/config.js";
import type {
  AssessmentAiClient,
  IntentVerdict,
} from "../src/agents/gemini-client.js";
import { ProviderRequestError } from "../src/agents/gemini-client.js";
import type { McpCallResult, McpClient } from "../src/mcp-client.js";
import type { GeneratedTestSuite, IntegrityReport, KeystrokeMetrics } from "../src/types.js";
import type { McpToolName } from "@assessment/mcp-mongodb";

export const TEST_API_TOKEN = "test-operator-token-0123456789abcdef";
export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdefghij";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    environment: "test",
    port: 0,
    ai: {
      mode: "gemini-api",
      apiKey: "test-api-key",
      projectId: "",
      location: "us-central1",
      model: "gemini-2.5-flash",
      maxOutputTokens: 1024,
      temperature: 0.2,
      requestTimeoutMs: 5_000,
    },
    database: { uri: "mongodb://127.0.0.1:27017", databaseName: "assessment_test" },
    mcp: { endpoint: "http://127.0.0.1:3001", authToken: "", timeoutMs: 1_000 },
    auth: {
      apiToken: TEST_API_TOKEN,
      sessionSecret: TEST_SESSION_SECRET,
      candidateTokenTtlSeconds: 3600,
    },
    cors: { allowedOrigins: ["http://localhost:8080"] },
    integrity: {
      sessionTtlSeconds: 3600,
      maxPasteEventsPerSession: 5,
      minHumanKeystrokeMs: 80,
      plagiarismThreshold: 0.75,
      alertScoreThreshold: 50,
    },
  };

  return {
    ...base,
    ...overrides,
    ai: { ...base.ai, ...(overrides.ai ?? {}) },
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
    integrity: { ...base.integrity, ...(overrides.integrity ?? {}) },
    mcp: { ...base.mcp, ...(overrides.mcp ?? {}) },
    cors: { ...base.cors, ...(overrides.cors ?? {}) },
    database: { ...base.database, ...(overrides.database ?? {}) },
  };
}

/** Records every call and returns canned data. */
export class StubMcpClient implements McpClient {
  readonly calls: Array<{ tool: McpToolName; args: Record<string, unknown> }> = [];
  private readonly responders = new Map<McpToolName, (args: Record<string, unknown>) => unknown>();
  /** When set, every call fails with this error. */
  failure: string | null = null;
  /** Tools that fail individually, leaving the others healthy. */
  readonly failingTools = new Set<McpToolName>();

  respond(tool: McpToolName, responder: (args: Record<string, unknown>) => unknown): this {
    this.responders.set(tool, responder);
    return this;
  }

  /** Marks one tool as unavailable without affecting the rest of the surface. */
  failTool(tool: McpToolName, error = "tool unavailable"): this {
    this.failingTools.add(tool);
    this.toolErrors.set(tool, error);
    return this;
  }

  private readonly toolErrors = new Map<McpToolName, string>();

  callsFor(tool: McpToolName): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.tool === tool).map((call) => call.args);
  }

  async call<T>(tool: McpToolName, args: Record<string, unknown>): Promise<McpCallResult<T>> {
    this.calls.push({ tool, args });
    if (this.failure) {
      return { ok: false, data: null, error: this.failure };
    }
    if (this.failingTools.has(tool)) {
      return { ok: false, data: null, error: this.toolErrors.get(tool) ?? "tool unavailable" };
    }
    const responder = this.responders.get(tool);
    const data = responder ? responder(args) : { success: true };
    return { ok: true, data: data as T };
  }
}

export const DEFAULT_VERDICT: IntentVerdict = {
  isInputMeaningful: true,
  isAssessmentRelated: true,
  isAppropriate: true,
  contentFlags: [],
  reason: "Clear request for a backend assessment.",
  confidence: 0.93,
  detectedDomain: "backend engineering",
  detectedAssessmentType: "coding assessment",
};

/** Deterministic assessment suite used across tests. */
export function sampleSuite(): GeneratedTestSuite {
  return {
    metadata: {
      suiteId: "suite-1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      modelVersion: "gemini-2.5-flash",
      promptFingerprint: "",
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    },
    roles: [
      {
        roleId: "role-1",
        title: "Backend Engineer",
        seniorityLevel: "mid",
        requiredCompetencyIds: ["comp-1"],
      },
    ],
    competencies: [
      {
        competencyId: "comp-1",
        name: "API design",
        description: "Designing HTTP APIs",
        weight: 1,
        subCompetencies: [],
      },
    ],
    problems: [
      {
        problemId: "problem-1",
        problemType: "coding",
        title: "Rate limiter",
        body: "Implement a fixed-window rate limiter.",
        language: "typescript",
        testCases: [
          {
            caseId: "case-1",
            input: "1",
            expectedOutput: "1",
            isPublic: false,
            timeoutMs: 2000,
          },
        ],
        difficulty: "intermediate",
        competencyId: "comp-1",
        timeAllocationSeconds: 1200,
        maxScore: 100,
      },
    ],
    testingMatrices: [
      {
        matrixId: "matrix-1",
        problemId: "problem-1",
        competencyIds: ["comp-1"],
        scoringFormula: { type: "weighted_sum", weights: { "comp-1": 1 } },
        integrityThresholds: {
          maxPasteEvents: 5,
          maxTimeBetweenKeystrokesMs: 80,
          plagiarismSimilarityThreshold: 0.75,
          structuralChangeSensitivity: 0.5,
        },
      },
    ],
  };
}

export function sampleIntegrityReport(overrides: Partial<IntegrityReport> = {}): IntegrityReport {
  return {
    integrityReportId: "report-1",
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
    overallScore: 62,
    flags: [
      {
        flagType: "LARGE_PASTE",
        severity: "high",
        sourceEventId: "event-1",
        description: "A 400-character block was pasted in one action.",
        confidence: 0.8,
        timestamp: "2026-01-01T00:05:00.000Z",
      },
    ],
    plagiarismReport: {
      overallSimilarity: 0.81,
      aiCompletionLikelihood: 0.7,
      matchedSnippets: [
        {
          sourceSnippet: "const x = 1;",
          candidateSnippet: "const x = 1;",
          similarityScore: 0.9,
          sourceLabel: "reference completion",
        },
      ],
    },
    behavioralAnomalies: [],
    generatedAt: "2026-01-01T00:06:00.000Z",
    ...overrides,
  };
}

export const SAMPLE_KEYSTROKES: KeystrokeMetrics = {
  avgDeltaMs: 120,
  maxDeltaMs: 400,
  minDeltaMs: 40,
  sampleCount: 25,
};

/** Stub AI provider with per-call overrides and call recording. */
export class StubAiClient implements AssessmentAiClient {
  readonly calls: string[] = [];
  verdict: IntentVerdict = { ...DEFAULT_VERDICT };
  suite: GeneratedTestSuite = sampleSuite();
  integrity: IntegrityReport = sampleIntegrityReport();
  classifyError: Error | null = null;
  generateError: Error | null = null;
  analyzeError: Error | null = null;
  /** Set once the generator has actually been entered; useful for sequencing. */
  entered = false;
  /** When set, the generator waits on this promise before returning. */
  gate: Promise<void> | null = null;
  /** When true, the generator rejects if the signal aborts, like the real client. */
  honourAbort = false;

  async classifyAssessmentIntent(): Promise<IntentVerdict> {
    this.calls.push("classifyAssessmentIntent");
    if (this.classifyError) throw this.classifyError;
    return this.verdict;
  }

  async generateTestSuite(
    _prompt?: string,
    _roleContext?: string,
    _problemCount?: number,
    signal?: AbortSignal,
  ): Promise<GeneratedTestSuite> {
    this.calls.push("generateTestSuite");
    this.entered = true;
    if (this.gate) await this.gate;
    if (this.honourAbort && signal?.aborted) {
      throw new ProviderRequestError("Assessment generation cancelled by client", false);
    }
    if (this.generateError) throw this.generateError;
    return this.suite;
  }

  async analyzeIntegrity(): Promise<IntegrityReport> {
    this.calls.push("analyzeIntegrity");
    if (this.analyzeError) throw this.analyzeError;
    return this.integrity;
  }
}

/** Builds a telemetry event body for ingestion tests. */
export function telemetryEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: `event-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
    problemId: "problem-1",
    eventType: "KEYSTROKE",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: { char: "a", deltaMs: 120 },
    clientMetadata: {
      userAgent: "test-agent",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
    ...overrides,
  };
}

/**
 * Minimal in-memory stand-in for a MongoDB `Db`.
 *
 * Implements only the driver surface `MongoStore` actually uses. It is not a
 * MongoDB emulator: operators outside that surface are unsupported and throw,
 * so a new query in the store fails loudly here rather than silently passing.
 */
export function createFakeDb(): {
  collection(name: string): unknown;
  docs(name: string): Array<Record<string, unknown>>;
} {
  const collections = new Map<string, Array<Record<string, unknown>>>();
  let objectId = 0;

  function docs(name: string): Array<Record<string, unknown>> {
    let existing = collections.get(name);
    if (!existing) {
      existing = [];
      collections.set(name, existing);
    }
    return existing;
  }

  function matches(doc: Record<string, unknown>, query: Record<string, unknown>): boolean {
    return Object.entries(query).every(([key, expected]) => {
      // Support dotted field paths, which MongoDB resolves natively.
      const actual = key
        .split(".")
        .reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], doc);
      return actual === expected;
    });
  }

  function project(doc: Record<string, unknown>, projection?: Record<string, number>): Record<string, unknown> {
    if (!projection) return { ...doc };
    const result: Record<string, unknown> = {};
    for (const [key, include] of Object.entries(projection)) {
      if (include === 1 && key in doc) result[key] = doc[key];
    }
    return result;
  }

  const collection = (name: string) => ({
    async createIndex(): Promise<string> {
      return `${name}_index`;
    },
    async estimatedDocumentCount(): Promise<number> {
      return docs(name).length;
    },
    async insertOne(doc: Record<string, unknown>) {
      const _id = `id-${(objectId += 1)}`;
      docs(name).push({ ...doc, _id });
      return { insertedId: _id, acknowledged: true };
    },
    async insertMany(inserted: Array<Record<string, unknown>>) {
      for (const doc of inserted) {
        docs(name).push({ ...doc, _id: `id-${(objectId += 1)}` });
      }
      return { insertedCount: inserted.length, acknowledged: true };
    },
    async findOne(query: Record<string, unknown>) {
      return docs(name).find((doc) => matches(doc, query)) ?? null;
    },
    async updateOne(query: Record<string, unknown>, update: Record<string, unknown>) {
      const doc = docs(name).find((candidate) => matches(candidate, query));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, (update["$set"] as Record<string, unknown>) ?? {});
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteOne(query: Record<string, unknown>) {
      const list = docs(name);
      const index = list.findIndex((doc) => matches(doc, query));
      if (index === -1) return { deletedCount: 0 };
      list.splice(index, 1);
      return { deletedCount: 1 };
    },
    async deleteMany(query: Record<string, unknown>) {
      const list = docs(name);
      const keep = list.filter((doc) => !matches(doc, query));
      const removed = list.length - keep.length;
      collections.set(name, keep);
      return { deletedCount: removed };
    },
    async countDocuments(query: Record<string, unknown>) {
      return docs(name).filter((doc) => matches(doc, query)).length;
    },
    find(query: Record<string, unknown> = {}, options: { projection?: Record<string, number> } = {}) {
      let results = docs(name).filter((doc) => matches(doc, query));
      const chain = {
        sort(spec: Record<string, number>) {
          const [[key, direction]] = Object.entries(spec);
          if (key) {
            results = [...results].sort((a, b) => {
              const left = a[key];
              const right = b[key];
              if (left === right) return 0;
              return (left! < right! ? -1 : 1) * (direction === -1 ? -1 : 1);
            });
          }
          return chain;
        },
        limit(count: number) {
          results = results.slice(0, count);
          return chain;
        },
        async toArray() {
          return results.map((doc) => project(doc, options.projection));
        },
      };
      return chain;
    },
    aggregate(pipeline: Array<Record<string, unknown>>) {
      let results = [...docs(name)];
      for (const stage of pipeline) {
        if (stage["$match"]) {
          const query = stage["$match"] as Record<string, unknown>;
          results = results.filter((doc) => matches(doc, query));
        } else if (stage["$sort"]) {
          const [[key, direction]] = Object.entries(stage["$sort"] as Record<string, number>);
          if (key) {
            results = [...results].sort((a, b) => {
              const left = a[key];
              const right = b[key];
              if (left === right) return 0;
              return (left! < right! ? -1 : 1) * (direction === -1 ? -1 : 1);
            });
          }
        } else if (stage["$group"]) {
          const group = stage["$group"] as Record<string, unknown>;
          const key = String(group["_id"]).replace("$", "");
          const grouped = new Map<unknown, Record<string, unknown>>();
          for (const doc of results) {
            const groupKey = doc[key];
            if (!grouped.has(groupKey)) {
              grouped.set(groupKey, { ...doc });
            }
          }
          results = [...grouped.values()];
        } else if (stage["$replaceRoot"]) {
          // The fake already keeps the document at the root.
          continue;
        } else {
          throw new Error(`createFakeDb: unsupported aggregation stage ${Object.keys(stage)[0]}`);
        }
      }
      return { async toArray() { return results; } };
    },
  });

  return {
    collection: (name: string) => collection(name),
    docs,
  };
}
