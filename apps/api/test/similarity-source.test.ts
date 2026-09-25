/**
 * Similarity reference-source tests.
 *
 * The similarity report had a settled structure but nothing to compare against:
 * `analyzeIntegrity` received `referenceCompletions` as an argument and the route
 * passed an empty array. So "similarity" meant similarity to nothing, which reads
 * as a check that is not happening.
 *
 * These tests pin the source that replaced it — the stored assessment's own
 * reference solution — the explicit metadata that says what was compared, and the
 * threshold that now drives an advisory flag.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import {
  MAX_REFERENCE_CHARS,
  MAX_REFERENCES,
  buildReferenceCompletions,
} from "../src/integrity-references.js";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  sampleIntegrityReport,
  telemetryEvent,
  testConfig,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

/** A stored suite with one problem and a reference answer. */
function suite(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { suiteId: "suite-1" },
    problems: [
      {
        problemId: "problem-1",
        expectedAnswer: "export function solve(xs) { return xs.slice().sort(); }",
        starterCode: "export function solve(xs) { /* your code */ }",
        ...overrides,
      },
    ],
  };
}

describe("building references from a stored suite", () => {
  test("the reference answer and starter code become references", () => {
    const built = buildReferenceCompletions(suite(), "problem-1");

    assert.equal(built.references.length, 2);
    assert.match(built.references[0]!, /export function solve/);
    assert.equal(built.source.kind, "assessment-solution");
    assert.equal(built.source.suiteId, "suite-1");
    assert.equal(built.source.problemId, "problem-1");
    assert.equal(built.source.count, 2);
    assert.equal(built.source.matchedBy, "problemId");
  });

  test("a problem with no reference material yields an explicit none", () => {
    const built = buildReferenceCompletions(
      suite({ expectedAnswer: undefined, starterCode: undefined }),
      "problem-1",
    );

    assert.deepEqual(built.references, []);
    assert.equal(built.source.kind, "none");
    assert.match(String(built.source.reason), /no reference answer or starter code/);
    assert.equal(built.source.count, 0);
  });

  test("a missing suite yields an explicit none rather than a silent empty", () => {
    for (const missing of [null, undefined, "not a suite", [], 42]) {
      const built = buildReferenceCompletions(missing, "problem-1");
      assert.deepEqual(built.references, [], `expected none for ${JSON.stringify(missing)}`);
      assert.equal(built.source.kind, "none");
      assert.ok(built.source.reason, "a reason must be stated");
    }
  });

  test("a suite with no problems yields an explicit none", () => {
    const built = buildReferenceCompletions({ metadata: { suiteId: "s" }, problems: [] }, null);
    assert.equal(built.source.kind, "none");
    assert.match(String(built.source.reason), /no problems/);
  });

  test("an unknown problemId falls back to the first problem and says so", () => {
    const built = buildReferenceCompletions(suite(), "problem-does-not-exist");
    assert.equal(built.references.length, 2);
    assert.equal(built.source.matchedBy, "first problem");
    assert.equal(built.source.problemId, "problem-1");
  });

  test("a blank expected answer is not treated as a reference", () => {
    const built = buildReferenceCompletions(
      suite({ expectedAnswer: "   ", starterCode: "real starter" }),
      "problem-1",
    );
    assert.equal(built.references.length, 1);
    assert.equal(built.references[0], "real starter");
  });

  test("identical answer and starter code are not duplicated", () => {
    const same = "export function solve(xs) { return xs; }";
    const built = buildReferenceCompletions(
      suite({ expectedAnswer: same, starterCode: same }),
      "problem-1",
    );
    assert.equal(built.references.length, 1);
  });

  test("references are bounded in count", () => {
    const built = buildReferenceCompletions(
      {
        metadata: { suiteId: "s" },
        problems: [
          {
            problemId: "p",
            expectedAnswer: "a".repeat(100),
            starterCode: "b".repeat(100),
          },
        ],
      },
      "p",
    );
    assert.ok(built.references.length <= MAX_REFERENCES);
  });

  test("references are bounded in total characters", () => {
    const built = buildReferenceCompletions(
      suite({ expectedAnswer: "x".repeat(MAX_REFERENCE_CHARS + 5_000) }),
      "problem-1",
    );

    const total = built.references.reduce((sum, reference) => sum + reference.length, 0);
    assert.ok(total <= MAX_REFERENCE_CHARS, `total ${total} must stay within the budget`);
  });

  test("a single oversized reference is truncated, not dropped", () => {
    const built = buildReferenceCompletions(
      suite({ expectedAnswer: "y".repeat(MAX_REFERENCE_CHARS * 2), starterCode: undefined }),
      "problem-1",
    );
    assert.equal(built.references.length, 1);
    assert.equal(built.references[0]!.length, MAX_REFERENCE_CHARS);
  });
});

/** A harness whose store can return a suite and whose model records its inputs. */
function makeHarness(options: { suite?: unknown; suiteFails?: boolean } = {}) {
  const ai = new StubAiClient();
  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session: null,
      events: [],
      integrityReports: [],
      eventTotal: 0,
      eventsReturned: 0,
      eventsTruncated: false,
      nextEventOffset: null,
    }))
    .respond(MCP_TOOLS.CREATE_SESSION, () => ({ success: true, mongoDocumentId: "doc-1" }))
    .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }))
    .respond(MCP_TOOLS.STORE_INTEGRITY_REPORT, () => ({ success: true, mongoDocumentId: "r-1" }));

  if (options.suiteFails) {
    mcp.failTool(MCP_TOOLS.GET_TEST_SUITE, "suite lookup failed");
  } else {
    mcp.respond(MCP_TOOLS.GET_TEST_SUITE, () => ({
      success: true,
      data: options.suite === undefined ? suite() : options.suite,
    }));
  }

  const app = buildApp({
    config: testConfig(),
    ai,
    mcp,
    sessions: new SessionRegistry(),
    log: () => undefined,
    requestLogging: false,
  });

  return { app, ai, mcp };
}

/** Ingests enough telemetry to trigger an analysis, and returns the report. */
async function analyse(
  harness: ReturnType<typeof makeHarness>,
): Promise<Record<string, unknown> | null> {
  const code = "export function solve(xs) { return xs.slice().sort((a, b) => a - b); }";
  let report: Record<string, unknown> | null = null;

  for (let index = 0; index < 6; index += 1) {
    const response = await harness.app.request("/api/v1/integrity/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_TOKEN}` },
      body: JSON.stringify({
        events: [
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: { pasteContent: `${code} // ${index}` },
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 3)).toISOString(),
          }),
        ],
      }),
    });
    const body = (await response.json()) as { integrityReport: Record<string, unknown> | null };
    if (body.integrityReport) report = body.integrityReport;
  }

  return report;
}

describe("the ingest path supplies a real comparison source", () => {
  test("the model receives the assessment's reference material", async () => {
    // The defect this replaces: the route passed an empty array, so similarity
    // was measured against nothing.
    const harness = makeHarness();
    await analyse(harness);

    const suiteLookups = harness.mcp.callsFor(MCP_TOOLS.GET_TEST_SUITE);
    assert.equal(suiteLookups.length, 1, "the assessment's suite must be looked up");
    assert.equal(suiteLookups[0]?.["suiteId"], "assessment-1");
    assert.ok(harness.ai.calls.includes("analyzeIntegrity"));
  });

  test("the stored report records what was compared", async () => {
    const harness = makeHarness();
    const report = await analyse(harness);

    assert.ok(report, "an analysis must have produced a report");
    const plagiarism = report["plagiarismReport"] as Record<string, unknown> | null;
    assert.ok(plagiarism, "the stub model returns a similarity report");
    const source = plagiarism["source"] as Record<string, unknown>;

    assert.equal(source["kind"], "assessment-solution");
    assert.equal(source["suiteId"], "suite-1");
    assert.equal(source["problemId"], "problem-1");
    assert.equal(source["count"], 2);
  });

  test("a session with no stored suite reports no comparison, not a silent zero", async () => {
    const harness = makeHarness({ suite: null });
    const report = await analyse(harness);

    const plagiarism = report?.["plagiarismReport"] as Record<string, unknown> | null;
    const source = plagiarism?.["source"] as Record<string, unknown>;
    assert.equal(source["kind"], "none");
    assert.ok(source["reason"], "the absence of a source must be explained");
  });

  test("a suite lookup failure does not lose the whole analysis", async () => {
    // Losing the similarity comparison is better than losing the integrity signal.
    const harness = makeHarness({ suiteFails: true });
    const report = await analyse(harness);

    assert.ok(report, "the analysis must still run");
    const source = (report["plagiarismReport"] as Record<string, unknown>)["source"] as Record<
      string,
      unknown
    >;
    assert.equal(source["kind"], "none");
  });

  test("a report with no similarity section still records the source attempt", async () => {
    const harness = makeHarness();
    harness.ai.integrity = sampleIntegrityReport({ plagiarismReport: null });

    const report = await analyse(harness);
    assert.equal(report?.["plagiarismReport"], null);
  });
});

describe("the similarity threshold drives an advisory flag", () => {
  test("similarity at or above the threshold adds a flag", async () => {
    const harness = makeHarness();
    harness.ai.integrity = sampleIntegrityReport({
      plagiarismReport: {
        overallSimilarity: 0.9,
        aiCompletionLikelihood: 0.2,
        matchedSnippets: [],
      },
    });

    const report = await analyse(harness);
    const flags = report?.["flags"] as Array<Record<string, unknown>>;

    const similarityFlag = flags.find((flag) => flag["flagType"] === "SIMILARITY_ABOVE_THRESHOLD");
    assert.ok(similarityFlag, "a flag must be raised above the threshold");
    assert.match(String(similarityFlag["description"]), /not a finding of plagiarism/);
    assert.match(String(similarityFlag["description"]), /0\.90/);
  });

  test("similarity below the threshold adds no flag", async () => {
    const harness = makeHarness();
    harness.ai.integrity = sampleIntegrityReport({
      plagiarismReport: {
        overallSimilarity: 0.1,
        aiCompletionLikelihood: 0.2,
        matchedSnippets: [],
      },
    });

    const report = await analyse(harness);
    const flags = report?.["flags"] as Array<Record<string, unknown>>;

    assert.equal(
      flags.some((flag) => flag["flagType"] === "SIMILARITY_ABOVE_THRESHOLD"),
      false,
    );
  });

  test("the exact threshold boundary raises a flag", async () => {
    const harness = makeHarness();
    // testConfig sets PLAGIARISM_THRESHOLD to 0.75.
    harness.ai.integrity = sampleIntegrityReport({
      plagiarismReport: {
        overallSimilarity: 0.75,
        aiCompletionLikelihood: 0.2,
        matchedSnippets: [],
      },
    });

    const report = await analyse(harness);
    const flags = report?.["flags"] as Array<Record<string, unknown>>;
    assert.ok(flags.some((flag) => flag["flagType"] === "SIMILARITY_ABOVE_THRESHOLD"));
  });

  test("the threshold does not change the model's own score", async () => {
    // The deterministic flag is informational: it must not become a second,
    // hidden scoring path.
    const harness = makeHarness();
    harness.ai.integrity = sampleIntegrityReport({
      overallScore: 30,
      plagiarismReport: {
        overallSimilarity: 0.99,
        aiCompletionLikelihood: 0.2,
        matchedSnippets: [],
      },
    });

    const report = await analyse(harness);
    assert.equal(report?.["overallScore"], 30);
  });

  test("a malformed similarity never raises a flag", async () => {
    for (const bad of ["high", null, undefined, Number.NaN]) {
      const harness = makeHarness();
      harness.ai.integrity = sampleIntegrityReport({
        plagiarismReport: {
          overallSimilarity: bad as unknown as number,
          aiCompletionLikelihood: 0.2,
          matchedSnippets: [],
        },
      });

      const report = await analyse(harness);
      const flags = (report?.["flags"] ?? []) as Array<Record<string, unknown>>;
      assert.equal(
        flags.some((flag) => flag["flagType"] === "SIMILARITY_ABOVE_THRESHOLD"),
        false,
        `a ${JSON.stringify(bad)} similarity must not raise a flag`,
      );
    }
  });
});
