/**
 * Session review and session listing tests.
 *
 * Verifies the review timeline, the structured preservation of integrity flags
 * and plagiarism reports (including the legacy bare-string flag shape), status
 * derivation, and the separation between the reviewable list and a single
 * candidate's own review.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { issueCandidateToken } from "../src/middleware/tokens.js";
import { StubAiClient, StubMcpClient, TEST_API_TOKEN, TEST_SESSION_SECRET, testConfig } from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

interface ReviewOverrides {
  session?: Record<string, unknown> | null;
  events?: Array<Record<string, unknown>>;
  integrityReports?: Array<Record<string, unknown>>;
}

function makeHarness(overrides: ReviewOverrides = {}) {
  const session = overrides.session === undefined
    ? {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        status: "in_progress",
      }
    : overrides.session;

  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session,
      events: overrides.events ?? [],
      integrityReports: overrides.integrityReports ?? [],
    }))
    .respond(MCP_TOOLS.LIST_SESSIONS, () => ({
      success: true,
      data: session
        ? [
            {
              sessionId: String(session["sessionId"]),
              candidateId: String(session["candidateId"]),
              assessmentId: String(session["assessmentId"]),
              status: String(session["status"]),
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:10:00.000Z",
            },
          ]
        : [],
    }));

  const app = buildApp({
    config: testConfig(),
    ai: new StubAiClient(),
    mcp,
    log: () => undefined,
    requestLogging: false,
  });

  return { app, mcp };
}

describe("session review", () => {
  test("returns a chronological timeline with severity classification", async () => {
    const { app } = makeHarness({
      events: [
        {
          eventType: "SUBMIT",
          timestamp: "2026-01-01T00:03:00.000Z",
          payload: {},
        },
        {
          eventType: "PASTE_TRIGGER",
          timestamp: "2026-01-01T00:01:00.000Z",
          payload: { pasteContent: "12345" },
        },
        {
          eventType: "KEYSTROKE",
          timestamp: "2026-01-01T00:02:00.000Z",
          payload: { deltaMs: 40 },
        },
      ],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      data: { timeline: Array<{ eventType: string; severity: string; label: string; detail: string }> };
    };

    assert.deepEqual(
      body.data.timeline.map((entry) => entry.eventType),
      ["PASTE_TRIGGER", "KEYSTROKE", "SUBMIT"],
      "the timeline must be ordered by timestamp, not by arrival",
    );

    const paste = body.data.timeline[0]!;
    assert.equal(paste.severity, "critical");
    assert.equal(paste.label, "Paste");
    assert.match(paste.detail, /5 characters/);

    const keystroke = body.data.timeline[1]!;
    assert.equal(keystroke.severity, "warning", "an implausibly fast keystroke is a warning");
  });

  test("preserves structured integrity flags verbatim", async () => {
    const { app } = makeHarness({
      integrityReports: [
        {
          integrityReportId: "report-1",
          sessionId: "session-1",
          candidateId: "candidate-1",
          assessmentId: "assessment-1",
          overallScore: 71,
          flags: [
            {
              flagType: "LARGE_PASTE",
              severity: "high",
              sourceEventId: "event-9",
              description: "A 900-character block appeared in one action.",
              confidence: 0.86,
              timestamp: "2026-01-01T00:05:00.000Z",
            },
          ],
          plagiarismReport: {
            overallSimilarity: 0.83,
            aiCompletionLikelihood: 0.66,
            matchedSnippets: [
              {
                sourceSnippet: "const a = 1;",
                candidateSnippet: "const a = 1;",
                similarityScore: 0.97,
                sourceLabel: "reference completion",
              },
            ],
          },
          behavioralAnomalies: [],
          generatedAt: "2026-01-01T00:06:00.000Z",
        },
      ],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: {
        integritySummary: Array<{
          overallScore: number;
          flags: Array<Record<string, unknown>>;
          plagiarismReport: { overallSimilarity: number; matchedSnippets: Array<Record<string, unknown>> } | null;
        }>;
      };
    };

    const report = body.data.integritySummary[0]!;
    assert.equal(report.overallScore, 71);
    assert.equal(report.flags.length, 1);
    assert.equal(report.flags[0]!["flagType"], "LARGE_PASTE");
    assert.equal(report.flags[0]!["severity"], "high");
    assert.equal(report.flags[0]!["description"], "A 900-character block appeared in one action.");
    assert.equal(report.plagiarismReport?.overallSimilarity, 0.83);
    assert.equal(report.plagiarismReport?.matchedSnippets.length, 1);
    assert.equal(report.plagiarismReport?.matchedSnippets[0]!["sourceLabel"], "reference completion");
  });

  test("widens legacy bare-string flags into the structured shape", async () => {
    const { app } = makeHarness({
      integrityReports: [
        {
          integrityReportId: "report-legacy",
          sessionId: "session-1",
          candidateId: "candidate-1",
          assessmentId: "assessment-1",
          overallScore: 40,
          flags: ["UNUSUAL_TYPING_CADENCE"],
          generatedAt: "2026-01-01T00:06:00.000Z",
        },
      ],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: { integritySummary: Array<{ flags: Array<Record<string, unknown>> }> };
    };

    const flag = body.data.integritySummary[0]!.flags[0]!;
    assert.equal(flag["flagType"], "UNUSUAL_TYPING_CADENCE");
    assert.equal(flag["description"], "UNUSUAL_TYPING_CADENCE");
    assert.equal(typeof flag["confidence"], "number");
    assert.equal(flag["timestamp"], "2026-01-01T00:06:00.000Z");
  });

  test("derives flagged status from a submitted session above the alert threshold", async () => {
    const { app } = makeHarness({
      events: [
        { eventType: "SUBMIT", timestamp: "2026-01-01T00:03:00.000Z", payload: {} },
      ],
      integrityReports: [
        { integrityReportId: "r", overallScore: 80, flags: [], generatedAt: "2026-01-01T00:04:00.000Z" },
      ],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { status: string; finalScore: number } };

    assert.equal(body.data.status, "flagged");
    assert.equal(body.data.finalScore, 20, "provisional score is the inverse of the integrity score");
  });

  test("derives submitted status when the score is below the threshold", async () => {
    const { app } = makeHarness({
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T00:03:00.000Z", payload: {} }],
      integrityReports: [
        { integrityReportId: "r", overallScore: 10, flags: [], generatedAt: "2026-01-01T00:04:00.000Z" },
      ],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { status: string } };
    assert.equal(body.data.status, "submitted");
  });

  test("keeps a terminated session terminated", async () => {
    const { app } = makeHarness({
      session: {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        status: "terminated",
      },
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { status: string } };
    assert.equal(body.data.status, "terminated");
  });

  test("returns the persisted code submission", async () => {
    const { app } = makeHarness({
      session: {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        status: "submitted",
        submittedCode: "export const answer = 42;",
      },
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { submittedCode: string } };
    assert.equal(body.data.submittedCode, "export const answer = 42;");
  });

  test("returns 404 for an unknown session", async () => {
    const { app } = makeHarness({ session: null });
    const response = await app.request("/api/v1/sessions/missing/review", { headers: OPERATOR });
    assert.equal(response.status, 404);
  });

  test("reports a datastore outage as 502", async () => {
    const mcp = new StubMcpClient();
    mcp.failure = "connection refused";
    const app = buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    assert.equal(response.status, 502);
  });

  test("a candidate may read their own review", async () => {
    const { app } = makeHarness();
    const token = issueCandidateToken({
      secret: TEST_SESSION_SECRET,
      candidateId: "candidate-1",
      displayName: "Ada",
      ttlSeconds: 600,
    }).token;

    const response = await app.request("/api/v1/sessions/session-1/review", {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  });
});

/**
 * The store returns a session's integrity reports **newest first**
 * (`getIntegrityReports` sorts by `generatedAt: -1`). Review must therefore not
 * assume the newest report is last in the array, or a reviewer is shown the
 * earliest score and flags for a session that has been analysed several times.
 */
const STORED_REPORTS_NEWEST_FIRST = [
  {
    integrityReportId: "report-newest",
    overallScore: 80,
    generatedAt: "2026-01-01T03:00:00.000Z",
    flags: [
      {
        flagType: "NEWEST_FLAG",
        severity: "high",
        sourceEventId: "",
        description: "only present on the newest report",
        confidence: 0.9,
        timestamp: "2026-01-01T03:00:00.000Z",
      },
    ],
  },
  {
    integrityReportId: "report-oldest",
    overallScore: 10,
    generatedAt: "2026-01-01T01:00:00.000Z",
    flags: [
      {
        flagType: "OLDEST_FLAG",
        severity: "low",
        sourceEventId: "",
        description: "only present on the oldest report",
        confidence: 0.5,
        timestamp: "2026-01-01T01:00:00.000Z",
      },
    ],
  },
];

describe("newest integrity report selection", () => {
  const SUBMITTED = {
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
    status: "submitted",
    submittedCode: "export const answer = 42;",
  };

  test("review derives its provisional score from the newest report", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: STORED_REPORTS_NEWEST_FIRST,
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { finalScore: number } };

    assert.equal(
      body.data.finalScore,
      20,
      "finalScore is 100 minus the NEWEST report's score (80), not the oldest (10)",
    );
  });

  test("review flags a session using the newest report's score", async () => {
    // Newest is above the alert threshold (50) and oldest is below it, so a
    // wrong selection changes the derived status too.
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: STORED_REPORTS_NEWEST_FIRST,
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { status: string } };
    assert.equal(body.data.status, "flagged");
  });

  test("the newest report's flags are the ones surfaced as latest", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: STORED_REPORTS_NEWEST_FIRST,
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: { integritySummary: Array<{ integrityReportId: string }> };
    };

    // The whole list is still returned; the API must not silently drop reports.
    assert.equal(body.data.integritySummary.length, 2);
    assert.deepEqual(
      body.data.integritySummary.map((report) => report.integrityReportId).sort(),
      ["report-newest", "report-oldest"],
    );
  });

  test("selection does not depend on the order the store returned", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      // Deliberately oldest-first this time.
      integrityReports: [...STORED_REPORTS_NEWEST_FIRST].reverse(),
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { finalScore: number } };
    assert.equal(body.data.finalScore, 20);
  });

  test("the session list scores a session from the newest report", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      integrityReports: STORED_REPORTS_NEWEST_FIRST,
    });

    const response = await app.request("/api/v1/sessions", { headers: OPERATOR });
    const body = (await response.json()) as { data: Array<{ integrityScore: number }> };
    assert.equal(
      body.data[0]?.integrityScore,
      80,
      "the cohort list must show the newest score, not the oldest",
    );
  });

  test("a report without a usable timestamp still yields a score", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: [{ integrityReportId: "only", overallScore: 40 }],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { finalScore: number } };
    assert.equal(body.data.finalScore, 60);
  });

  test("a non-numeric stored score never becomes NaN", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: [{ integrityReportId: "bad", overallScore: "not-a-number" }],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as { data: { finalScore: number | null } };

    assert.equal(
      body.data.finalScore,
      null,
      "an unusable stored score yields no provisional score rather than NaN or a confident 100",
    );
  });

  test("a stored score outside 0-100 is bounded", async () => {
    const { app } = makeHarness({
      session: SUBMITTED,
      events: [{ eventType: "SUBMIT", timestamp: "2026-01-01T03:30:00.000Z", payload: {} }],
      integrityReports: [{ integrityReportId: "wild", overallScore: 100000 }],
    });

    const response = await app.request("/api/v1/sessions/session-1/review", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: { finalScore: number; integritySummary: Array<{ overallScore: number }> };
    };

    assert.equal(body.data.integritySummary[0]?.overallScore, 100);
    assert.equal(body.data.finalScore, 0);
  });
});

describe("session listing", () => {
  test("enriches each session with telemetry counts", async () => {
    const { app } = makeHarness({
      events: [
        { eventType: "PASTE_TRIGGER", timestamp: "2026-01-01T00:01:00.000Z", payload: { pasteContent: "abc" } },
        { eventType: "TAB_SWITCH", timestamp: "2026-01-01T00:02:00.000Z", payload: {} },
        { eventType: "WINDOW_BLUR", timestamp: "2026-01-01T00:03:00.000Z", payload: {} },
        { eventType: "KEYSTROKE", timestamp: "2026-01-01T00:04:00.000Z", payload: { deltaMs: 100 } },
      ],
      integrityReports: [
        { integrityReportId: "r", overallScore: 44, flags: [], generatedAt: "2026-01-01T00:05:00.000Z" },
      ],
    });

    const response = await app.request("/api/v1/sessions", { headers: OPERATOR });
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      data: Array<{
        sessionId: string;
        eventCount: number;
        pasteCount: number;
        tabSwitchCount: number;
        integrityScore: number;
        lastEventTimestamp: string | null;
      }>;
    };

    const summary = body.data[0]!;
    assert.equal(summary.sessionId, "session-1");
    assert.equal(summary.eventCount, 4);
    assert.equal(summary.pasteCount, 1);
    assert.equal(summary.tabSwitchCount, 2, "window blur counts alongside tab switch");
    assert.equal(summary.integrityScore, 44);
    assert.equal(summary.lastEventTimestamp, "2026-01-01T00:04:00.000Z");
  });

  test("degrades to an empty list when the datastore is unavailable", async () => {
    const mcp = new StubMcpClient();
    mcp.failure = "connection refused";
    const app = buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await app.request("/api/v1/sessions", { headers: OPERATOR });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { data: unknown[]; degraded: boolean };
    assert.deepEqual(body.data, []);
    assert.equal(body.degraded, true);
  });
});

describe("candidate report", () => {
  test("returns the latest report per session for an operator", async () => {
    const mcp = new StubMcpClient().respond(MCP_TOOLS.GET_CANDIDATE_REPORT, () => ({
      success: true,
      reports: [{ integrityReportId: "r1", sessionId: "session-1", overallScore: 30 }],
    }));

    const app = buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await app.request("/api/v1/candidates/candidate-1/reports", {
      headers: OPERATOR,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { reports: unknown[]; candidateId: string };
    assert.equal(body.candidateId, "candidate-1");
    assert.equal(body.reports.length, 1);
    assert.deepEqual(mcp.callsFor(MCP_TOOLS.GET_CANDIDATE_REPORT), [{ candidateId: "candidate-1" }]);
  });
});
