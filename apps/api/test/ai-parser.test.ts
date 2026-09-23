/**
 * AI provider parser fixture tests.
 *
 * The provider boundary is the only place a paid model is ever contacted. These
 * tests inject a fixture double for the provider SDK, so the real request
 * construction, retry policy, JSON recovery and response normalisation paths
 * execute without any network call.
 *
 * The double is injected through the client's `loadSdk` argument rather than
 * through Node's `mock.module`. Module mocking with `exports` is experimental
 * and does not substitute the module on Node 22, which made this suite pass on
 * Node 24 and fail on Node 22 with "GoogleGenAI is not a constructor".
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { testConfig } from "./helpers.js";
import type { GeneratedTestSuite, IntegrityReport } from "../src/types.js";
import type { GenAiLoader, GenAiModule } from "../src/agents/gemini-client.js";

// ─── SDK double ────────────────────────────────────────────────────

interface GenerateContentRequest {
  model: string;
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  config: Record<string, unknown>;
}

const sdkState = {
  /** Responses handed out in order; the last one repeats. */
  responses: [] as string[],
  requests: [] as GenerateContentRequest[],
  throwOnCall: null as Error | null,
  /** Set when a test needs the double to reject at construction time. */
  constructorThrows: null as Error | null,
};

class FakeGoogleGenAI {
  constructor(readonly options: Record<string, unknown>) {
    if (sdkState.constructorThrows) throw sdkState.constructorThrows;
  }

  readonly models = {
    generateContent: async (request: GenerateContentRequest) => {
      sdkState.requests.push(request);
      if (sdkState.throwOnCall) throw sdkState.throwOnCall;
      const text = sdkState.responses.length > 1
        ? (sdkState.responses.shift() as string)
        : (sdkState.responses[0] ?? "");
      return { candidates: [{ content: { parts: [{ text }] } }] };
    },
  };
}

/** The fixture module the client receives in place of `@google/genai`. */
const fakeSdk = {
  GoogleGenAI: FakeGoogleGenAI,
  HarmCategory: {
    HARM_CATEGORY_DANGEROUS_CONTENT: "dangerous",
    HARM_CATEGORY_HARASSMENT: "harassment",
    HARM_CATEGORY_HATE_SPEECH: "hate",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "sexual",
  },
  HarmBlockThreshold: { BLOCK_ONLY_HIGH: "block_only_high" },
} as unknown as GenAiModule;

const loadFakeSdk: GenAiLoader = async () => fakeSdk;

const { GeminiAssessmentClient, ProviderRequestError } = await import(
  "../src/agents/gemini-client.js"
);

function resetSdk(responses: string[], throwOnCall: Error | null = null): void {
  sdkState.responses = responses;
  sdkState.requests = [];
  sdkState.throwOnCall = throwOnCall;
  sdkState.constructorThrows = null;
}

function makeClient(): InstanceType<typeof GeminiAssessmentClient> {
  return new GeminiAssessmentClient(testConfig(), () => undefined, loadFakeSdk);
}

// ─── Fixtures ──────────────────────────────────────────────────────

const SUITE_FIXTURE: GeneratedTestSuite = {
  metadata: {
    suiteId: "suite-fixture",
    generatedAt: "2026-02-01T10:00:00.000Z",
    modelVersion: "gemini-2.5-flash",
    promptFingerprint: "",
    tokenUsage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
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
      name: "Concurrency",
      description: "Reasoning about concurrent execution",
      weight: 1,
      subCompetencies: [],
    },
  ],
  problems: [
    {
      problemId: "problem-1",
      problemType: "coding",
      title: "Bounded queue",
      body: "Implement a bounded blocking queue.",
      language: "typescript",
      starterCode: "export class BoundedQueue {}",
      testCases: [
        { caseId: "case-public", input: "1", expectedOutput: "1", isPublic: true, timeoutMs: 2000 },
        { caseId: "case-hidden", input: "2", expectedOutput: "2", isPublic: false, timeoutMs: 3000 },
      ],
      difficulty: "advanced",
      competencyId: "comp-1",
      timeAllocationSeconds: 1800,
      maxScore: 100,
    },
  ],
  testingMatrices: [
    {
      matrixId: "matrix-1",
      problemId: "problem-1",
      competencyIds: ["comp-1"],
      scoringFormula: { type: "all_or_nothing", weights: { "comp-1": 1 } },
      integrityThresholds: {
        maxPasteEvents: 3,
        maxTimeBetweenKeystrokesMs: 90,
        plagiarismSimilarityThreshold: 0.8,
        structuralChangeSensitivity: 0.4,
      },
    },
  ],
};

const INTEGRITY_FIXTURE = {
  overallScore: 78,
  flags: [
    {
      flagType: "BULK_PASTE",
      severity: "critical",
      sourceEventId: "event-77",
      description: "An entire solution appeared as a single 1,200-character paste.",
      confidence: 0.92,
      timestamp: "2026-02-01T10:05:00.000Z",
    },
  ],
  plagiarismReport: {
    overallSimilarity: 0.91,
    aiCompletionLikelihood: 0.84,
    matchedSnippets: [
      {
        sourceSnippet: "function solve() {}",
        candidateSnippet: "function solve() {}",
        similarityScore: 1,
        sourceLabel: "gemini-2.5-flash-completion",
      },
    ],
  },
  behavioralAnomalies: [
    {
      anomalyType: "PASTE_BURST",
      description: "Three large pastes within four seconds.",
      evidenceWindowStart: "2026-02-01T10:04:00.000Z",
      evidenceWindowEnd: "2026-02-01T10:04:04.000Z",
      metricValue: 3,
      threshold: 2,
    },
  ],
};

const CLASSIFIER_FIXTURE = {
  isInputMeaningful: true,
  isAssessmentRelated: true,
  isAppropriate: true,
  contentFlags: [],
  confidence: 0.91,
  detectedDomain: "distributed systems",
  detectedAssessmentType: "coding assessment",
  reason: "The request clearly asks for a backend coding assessment.",
};

const KEYSTROKES = { avgDeltaMs: 110, maxDeltaMs: 400, minDeltaMs: 30, sampleCount: 40 };

// ─── Tests ─────────────────────────────────────────────────────────

describe("request construction", () => {
  test("uses the configured model and JSON response mode", async () => {
    resetSdk([JSON.stringify(SUITE_FIXTURE)]);
    await makeClient().generateTestSuite("prompt", "backend", 3);

    const request = sdkState.requests[0]!;
    assert.equal(request.model, "gemini-2.5-flash");
    assert.equal(request.config["responseMimeType"], "application/json");
    assert.ok(request.config["systemInstruction"]);
    assert.match(request.contents[0]!.parts[0]!.text, /prompt/);
  });

  test("a vertex-configured client is a valid explicit alternative", async () => {
    const config = testConfig({
      ai: {
        mode: "vertex",
        apiKey: "",
        projectId: "example-project",
        location: "europe-west1",
        model: "gemini-2.5-flash",
        maxOutputTokens: 1024,
        temperature: 0.2,
        requestTimeoutMs: 5000,
      },
    });
    const client = new GeminiAssessmentClient(config, () => undefined, loadFakeSdk);
    assert.equal(client.isConfigured(), true);

    resetSdk([JSON.stringify(SUITE_FIXTURE)]);
    await client.generateTestSuite("prompt", "backend", 1);
    assert.equal(sdkState.requests.length, 1);
  });

  test("a client with no credential reports itself unconfigured", () => {
    const config = testConfig({
      ai: {
        mode: "gemini-api",
        apiKey: "",
        projectId: "",
        location: "us-central1",
        model: "gemini-2.5-flash",
        maxOutputTokens: 1024,
        temperature: 0.2,
        requestTimeoutMs: 5000,
      },
    });
    assert.equal(
      new GeminiAssessmentClient(config, () => undefined, loadFakeSdk).isConfigured(),
      false,
    );
  });
});

describe("suite parsing", () => {
  test("parses a clean JSON suite", async () => {
    resetSdk([JSON.stringify(SUITE_FIXTURE)]);
    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);

    assert.equal(suite.metadata.suiteId, "suite-fixture");
    assert.equal(suite.problems.length, 1);
    assert.equal(suite.problems[0]!.problemId, "problem-1");
    assert.equal(suite.problems[0]!.testCases!.length, 2);
    assert.equal(suite.problems[0]!.testCases![1]!.isPublic, false, "hidden cases must survive");
    assert.equal(suite.testingMatrices[0]!.integrityThresholds.maxPasteEvents, 3);
  });

  test("recovers a suite wrapped in a markdown fence", async () => {
    resetSdk(["```json\n" + JSON.stringify(SUITE_FIXTURE) + "\n```"]);
    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);
    assert.equal(suite.metadata.suiteId, "suite-fixture");
  });

  test("recovers a suite with trailing commas and unescaped newlines", async () => {
    const malformed = `{
      "metadata": { "suiteId": "s1", "generatedAt": "2026-02-01T10:00:00.000Z",
                    "modelVersion": "gemini-2.5-flash", "promptFingerprint": "",
                    "tokenUsage": { "promptTokens": 1, "completionTokens": 2, "totalTokens": 3, }, },
      "roles": [],
      "competencies": [],
      "problems": [ { "problemId": "p1", "problemType": "essay",
                      "title": "Explain", "body": "Line one
Line two",
                      "difficulty": "beginner", "competencyId": "c1",
                      "timeAllocationSeconds": 600, "maxScore": 10, } ],
      "testingMatrices": [],
    }`;

    resetSdk([malformed]);
    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);
    assert.equal(suite.metadata.suiteId, "s1");
    assert.equal(suite.problems[0]!.problemId, "p1");
    assert.match(suite.problems[0]!.body, /Line one\nLine two/);
  });

  test("assigns stable identifiers when the model omits them", async () => {
    resetSdk([
      JSON.stringify({
        metadata: {},
        roles: [],
        competencies: [{ name: "Testing", description: "d", weight: 1 }],
        problems: [{ problemType: "coding", title: "t", body: "b", difficulty: "beginner" }],
        testingMatrices: [{}],
      }),
    ]);

    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);

    assert.match(suite.metadata.suiteId, /^[0-9a-f-]{36}$/);
    assert.match(suite.competencies[0]!.competencyId, /^[0-9a-f-]{36}$/);
    assert.match(suite.problems[0]!.problemId, /^[0-9a-f-]{36}$/);
    assert.match(suite.testingMatrices[0]!.matrixId, /^[0-9a-f-]{36}$/);
    assert.equal(
      suite.problems[0]!.competencyId,
      suite.competencies[0]!.competencyId,
      "an unlinked problem must fall back to the first declared competency",
    );
    assert.equal(suite.problems[0]!.testCases!.length, 0);
  });

  test("rejects a response with no JSON object", async () => {
    resetSdk(["I am unable to help with that."]);
    await assert.rejects(
      () => makeClient().generateTestSuite("prompt", "backend", 1),
      (error: unknown) => error instanceof ProviderRequestError,
    );
  });

  test("replaces the placeholder UUID a model repeats for every id", async () => {
    // Regression: observed live against gemini-2.5-flash. Asked for "a unique
    // UUID" for every identifier, the model returned the same memorised example
    // on every call. Trusting it made every suite share one suiteId, which
    // collided on the unique index and lost the suite on persistence.
    const PLACEHOLDER = "a1b2c3d4-e5f6-7890-1234-567890abcdef";
    resetSdk([
      JSON.stringify({
        metadata: { suiteId: PLACEHOLDER },
        roles: [],
        competencies: [{ competencyId: PLACEHOLDER, name: "Arrays", description: "d", weight: 1 }],
        problems: [
          {
            problemId: PLACEHOLDER,
            competencyId: PLACEHOLDER,
            problemType: "coding",
            title: "Merge",
            body: "b",
            difficulty: "beginner",
            testCases: [{ caseId: PLACEHOLDER, input: "1", expectedOutput: "1", isPublic: false }],
            options: [{ optionId: PLACEHOLDER, text: "t", isCorrect: true, explanation: "e" }],
          },
        ],
        testingMatrices: [{ matrixId: PLACEHOLDER, problemId: PLACEHOLDER }],
      }),
    ]);

    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);

    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    assert.notEqual(suite.metadata.suiteId, PLACEHOLDER, "the placeholder suiteId must be replaced");
    assert.match(suite.metadata.suiteId, uuid);
    assert.match(suite.competencies[0]!.competencyId, uuid);
    assert.match(suite.problems[0]!.problemId, uuid);
    assert.match(suite.problems[0]!.testCases![0]!.caseId!, uuid);
    assert.match(suite.problems[0]!.options![0]!.optionId!, uuid);
    assert.match(suite.testingMatrices[0]!.matrixId, uuid);

    // The problem must still name a competency that exists, so scoring and
    // review can join on it.
    assert.equal(
      suite.problems[0]!.competencyId,
      suite.competencies[0]!.competencyId,
      "the competency reference must survive the id replacement",
    );

    // A second generation must not reproduce the same suite id.
    resetSdk([
      JSON.stringify({
        metadata: { suiteId: PLACEHOLDER },
        roles: [],
        competencies: [],
        problems: [],
        testingMatrices: [],
      }),
    ]);
    const second = await makeClient().generateTestSuite("prompt", "backend", 1);
    assert.notEqual(
      second.metadata.suiteId,
      suite.metadata.suiteId,
      "two generations must not collide on suite id",
    );
  });

  test("a model-supplied non-placeholder id is still authoritative", async () => {
    resetSdk([
      JSON.stringify({
        metadata: { suiteId: "8f14e45f-ceea-467a-9575-1b1f4a2f0c3d" },
        roles: [],
        competencies: [],
        problems: [],
        testingMatrices: [],
      }),
    ]);
    const suite = await makeClient().generateTestSuite("prompt", "backend", 1);
    assert.equal(suite.metadata.suiteId, "8f14e45f-ceea-467a-9575-1b1f4a2f0c3d");
  });
});

describe("integrity parsing", () => {
  test("preserves the structured plagiarism report", async () => {
    resetSdk([JSON.stringify(INTEGRITY_FIXTURE)]);
    const report: IntegrityReport = await makeClient().analyzeIntegrity("code", [], KEYSTROKES, []);

    assert.equal(report.overallScore, 78);
    assert.equal(report.flags.length, 1);
    assert.equal(report.flags[0]!.flagType, "BULK_PASTE");
    assert.equal(report.flags[0]!.severity, "critical");
    assert.equal(report.flags[0]!.sourceEventId, "event-77");
    assert.equal(report.plagiarismReport?.overallSimilarity, 0.91);
    assert.equal(report.plagiarismReport?.matchedSnippets[0]!.sourceLabel, "gemini-2.5-flash-completion");
    assert.equal(report.behavioralAnomalies.length, 1);
    assert.equal(report.behavioralAnomalies[0]!.anomalyType, "PASTE_BURST");
  });

  test("widens bare-string flags without losing severity defaults", async () => {
    resetSdk([
      JSON.stringify({
        overallScore: 30,
        flags: ["UNUSUAL_TYPING_CADENCE"],
        plagiarismReport: null,
        behavioralAnomalies: [],
      }),
    ]);

    const report = await makeClient().analyzeIntegrity("code", [], KEYSTROKES, []);
    assert.equal(report.flags[0]!.flagType, "UNUSUAL_TYPING_CADENCE");
    assert.equal(report.flags[0]!.severity, "medium");
    assert.equal(report.plagiarismReport, null);
  });

  test("clamps an out-of-range score", async () => {
    resetSdk([JSON.stringify({ overallScore: 480, flags: [] })]);
    const report = await makeClient().analyzeIntegrity("code", [], KEYSTROKES, []);
    assert.equal(report.overallScore, 100);

    resetSdk([JSON.stringify({ overallScore: -30, flags: [] })]);
    const negative = await makeClient().analyzeIntegrity("code", [], KEYSTROKES, []);
    assert.equal(negative.overallScore, 0);
  });

  test("tolerates a missing score", async () => {
    resetSdk([JSON.stringify({ flags: [] })]);
    const report = await makeClient().analyzeIntegrity("code", [], KEYSTROKES, []);
    assert.equal(report.overallScore, 0);
    assert.deepEqual(report.flags, []);
  });
});

describe("intent classification", () => {
  test("parses a classifier verdict", async () => {
    resetSdk([JSON.stringify(CLASSIFIER_FIXTURE)]);
    const verdict = await makeClient().classifyAssessmentIntent("prompt", "backend");

    assert.equal(verdict.isAssessmentRelated, true);
    assert.equal(verdict.isAppropriate, true);
    assert.equal(verdict.confidence, 0.91);
    assert.equal(verdict.detectedDomain, "distributed systems");
  });

  test("surfaces an inappropriate-content verdict with its flags", async () => {
    resetSdk([
      JSON.stringify({
        isInputMeaningful: true,
        isAssessmentRelated: false,
        isAppropriate: false,
        contentFlags: ["PROFANITY", "HARASSMENT"],
        confidence: 0.8,
        detectedDomain: "",
        detectedAssessmentType: "",
        reason: "The request is abusive.",
      }),
    ]);

    const verdict = await makeClient().classifyAssessmentIntent("prompt", "backend");
    assert.equal(verdict.isAppropriate, false);
    assert.deepEqual(verdict.contentFlags, ["PROFANITY", "HARASSMENT"]);
  });

  test("defaults missing booleans to permissive so a partial verdict is not a rejection", async () => {
    resetSdk([JSON.stringify({ confidence: 0.9, reason: "fine" })]);
    const verdict = await makeClient().classifyAssessmentIntent("prompt", "backend");
    assert.equal(verdict.isInputMeaningful, true);
    assert.equal(verdict.isAssessmentRelated, true);
    assert.equal(verdict.isAppropriate, true);
    assert.deepEqual(verdict.contentFlags, []);
  });
});

describe("retry and failure behaviour", () => {
  test("retries a transient failure and succeeds", async () => {
    resetSdk([JSON.stringify(SUITE_FIXTURE)]);

    // Fail the first attempt, then clear the fault so the retry can succeed.
    sdkState.throwOnCall = new Error("503 Service Unavailable");
    const client = makeClient();
    const pending = client.generateTestSuite("prompt", "backend", 1);
    setTimeout(() => {
      sdkState.throwOnCall = null;
    }, 10);

    const suite = await pending;
    assert.equal(suite.metadata.suiteId, "suite-fixture");
    assert.equal(sdkState.requests.length, 2, "the transient failure must be retried once");
    sdkState.throwOnCall = null;
  });

  test("does not retry an authentication failure", async () => {
    resetSdk([JSON.stringify(SUITE_FIXTURE)], new Error("API key not valid. Please pass a valid API key."));
    const client = makeClient();
    await assert.rejects(
      () => client.generateTestSuite("prompt", "backend", 1),
      (error: unknown) => error instanceof ProviderRequestError && error.retryable === false,
    );
    assert.equal(sdkState.requests.length, 1, "a terminal error must not be retried");
  });

  test("an empty response is treated as a retryable failure", async () => {
    resetSdk(["", "", ""]);
    const client = makeClient();
    await assert.rejects(
      () => client.generateTestSuite("prompt", "backend", 1),
      (error: unknown) => error instanceof ProviderRequestError && error.retryable === true,
    );
    assert.equal(sdkState.requests.length, 3, "an empty response is retried up to the attempt cap");
  });

  test("reports an unconfigured provider rather than calling out", async () => {
    const config = testConfig({
      ai: {
        mode: "gemini-api",
        apiKey: "",
        projectId: "",
        location: "us-central1",
        model: "gemini-2.5-flash",
        maxOutputTokens: 1024,
        temperature: 0.2,
        requestTimeoutMs: 5000,
      },
    });
    resetSdk([JSON.stringify(SUITE_FIXTURE)]);
    const client = new GeminiAssessmentClient(config, () => undefined);

    await assert.rejects(
      () => client.generateTestSuite("prompt", "backend", 1),
      (error: unknown) => error instanceof Error && /GEMINI_API_KEY/.test(error.message),
    );
    assert.equal(sdkState.requests.length, 0);
  });

  test("honours a pre-aborted signal", async () => {
    resetSdk([JSON.stringify(SUITE_FIXTURE)]);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => makeClient().generateTestSuite("prompt", "backend", 1, controller.signal),
      (error: unknown) => error instanceof Error && /cancelled/.test(error.message),
    );
    assert.equal(sdkState.requests.length, 0);
  });
});
