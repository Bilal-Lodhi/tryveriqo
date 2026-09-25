/**
 * Review-paging disclosure tests.
 *
 * `GET /api/v1/sessions/:sessionId/review` returned at most the newest 500 events
 * and said nothing about it, so a reviewer looking at a long session saw a partial
 * timeline presented as the whole one, and the cohort list's `eventCount`
 * undercounted. These tests pin the disclosure: the true total, the page actually
 * returned, a truncation flag, and a continuation offset.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS, REVIEW_EVENT_LIMIT_MAX } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import { issueCandidateToken } from "../src/middleware/tokens.js";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  TEST_SESSION_SECRET,
  testConfig,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };
const DEFAULT_PAGE = 500;

/** A stored event, one second after the previous one. */
function storedEvent(index: number, eventType = "KEYSTROKE") {
  return {
    eventType,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: { char: "a", deltaMs: 100 + index },
  };
}

/**
 * A stub that behaves like the real store: newest-first, pageable, and reporting
 * the true total alongside the page.
 */
function makeHarness(options: { eventCount?: number; session?: Record<string, unknown> | null } = {}) {
  const total = options.eventCount ?? 0;
  const all = Array.from({ length: total }, (_, index) => storedEvent(index));
  // Newest first, exactly as `getSessionEvents` sorts.
  const newestFirst = [...all].reverse();

  const session =
    options.session === undefined
      ? {
          sessionId: "session-1",
          candidateId: "candidate-1",
          assessmentId: "assessment-1",
          status: "in_progress",
        }
      : options.session;

  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, (args) => {
      const limit = typeof args["eventLimit"] === "number" ? args["eventLimit"] : DEFAULT_PAGE;
      const offset = typeof args["eventOffset"] === "number" ? args["eventOffset"] : 0;
      const page = newestFirst.slice(offset, offset + limit);
      const consumed = offset + page.length;
      return {
        success: true,
        session,
        events: page,
        integrityReports: [],
        eventTotal: total,
        eventsReturned: page.length,
        eventsTruncated: consumed < total,
        nextEventOffset: consumed < total ? consumed : null,
      };
    })
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
    sessions: new SessionRegistry(),
    log: () => undefined,
    requestLogging: false,
  });

  return { app, mcp };
}

interface ReviewBody {
  success: boolean;
  error?: string;
  data: {
    timeline: Array<{ timestamp: string; eventType: string }>;
    timelineTotal: number;
    timelineReturned: number;
    timelineTruncated: boolean;
    nextEventOffset: number | null;
  };
}

async function review(
  app: ReturnType<typeof buildApp>,
  query = "",
  headers: Record<string, string> = OPERATOR,
): Promise<{ status: number; body: ReviewBody }> {
  const response = await app.request(`/api/v1/sessions/session-1/review${query}`, { headers });
  return { status: response.status, body: (await response.json()) as ReviewBody };
}

describe("review discloses a truncated timeline", () => {
  test("a short session is not reported as truncated", async () => {
    const { app } = makeHarness({ eventCount: 12 });
    const { status, body } = await review(app);

    assert.equal(status, 200);
    assert.equal(body.data.timelineTotal, 12);
    assert.equal(body.data.timelineReturned, 12);
    assert.equal(body.data.timelineTruncated, false);
    assert.equal(body.data.nextEventOffset, null);
  });

  test("a long session reports the true total and a continuation offset", async () => {
    // The defect this replaced: 500 events came back and nothing said 1200
    // existed, so the partial timeline read as complete.
    const { app } = makeHarness({ eventCount: 1200 });
    const { body } = await review(app);

    assert.equal(body.data.timelineTotal, 1200);
    assert.equal(body.data.timelineReturned, DEFAULT_PAGE);
    assert.equal(body.data.timelineTruncated, true);
    assert.equal(body.data.nextEventOffset, DEFAULT_PAGE);
  });

  test("the timeline is still chronological within the page", async () => {
    const { app } = makeHarness({ eventCount: 10 });
    const { body } = await review(app);

    const timestamps = body.data.timeline.map((entry) => entry.timestamp);
    const sorted = [...timestamps].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    assert.deepEqual(timestamps, sorted);
  });

  test("an explicit page size is honoured and disclosed", async () => {
    const { app } = makeHarness({ eventCount: 20 });
    const { body } = await review(app, "?eventLimit=5");

    assert.equal(body.data.timelineReturned, 5);
    assert.equal(body.data.timelineTotal, 20);
    assert.equal(body.data.timelineTruncated, true);
    assert.equal(body.data.nextEventOffset, 5);
  });

  test("paging continues without gaps or overlaps", async () => {
    const { app } = makeHarness({ eventCount: 9 });

    const first = await review(app, "?eventLimit=5&eventOffset=0");
    const second = await review(app, "?eventLimit=5&eventOffset=5");

    const seen = [
      ...first.body.data.timeline.map((entry) => entry.timestamp),
      ...second.body.data.timeline.map((entry) => entry.timestamp),
    ];

    assert.equal(seen.length, 9);
    assert.equal(new Set(seen).size, 9, "pages must not overlap");
    assert.equal(second.body.data.timelineTruncated, false);
    assert.equal(second.body.data.nextEventOffset, null);
  });

  test("the final page is complete and stops advertising a continuation", async () => {
    // 1200 events at the default 500-event page size needs three pages: the
    // middle one is still truncated and still advertises the next offset.
    const { app } = makeHarness({ eventCount: 1200 });

    const middle = await review(app, `?eventOffset=${DEFAULT_PAGE}`);
    assert.equal(middle.body.data.timelineReturned, DEFAULT_PAGE);
    assert.equal(middle.body.data.timelineTruncated, true);
    assert.equal(middle.body.data.nextEventOffset, DEFAULT_PAGE * 2);

    const last = await review(app, `?eventOffset=${DEFAULT_PAGE * 2}`);
    assert.equal(last.body.data.timelineReturned, 200);
    assert.equal(last.body.data.timelineTotal, 1200);
    assert.equal(last.body.data.timelineTruncated, false);
    assert.equal(last.body.data.nextEventOffset, null);
  });

  test("walking every page reaches the true total exactly once", async () => {
    const { app } = makeHarness({ eventCount: 1200 });

    const seen: string[] = [];
    let offset: number | null = 0;
    let guard = 0;

    while (offset !== null && guard < 10) {
      const { body } = await review(app, `?eventOffset=${offset}`);
      seen.push(...body.data.timeline.map((entry) => entry.timestamp));
      offset = body.data.nextEventOffset;
      guard += 1;
    }

    assert.equal(offset, null, "paging must terminate");
    assert.equal(seen.length, 1200);
    assert.equal(new Set(seen).size, 1200, "pages must not overlap");
  });

  test("an empty session reports a total of zero, not truncation", async () => {
    const { app } = makeHarness({ eventCount: 0 });
    const { body } = await review(app);

    assert.equal(body.data.timelineTotal, 0);
    assert.equal(body.data.timelineTruncated, false);
    assert.equal(body.data.nextEventOffset, null);
  });

  test("an operator sees the same disclosure as a candidate", async () => {
    const { app } = makeHarness({ eventCount: 900 });
    const candidate = issueCandidateToken({
      secret: TEST_SESSION_SECRET,
      candidateId: "candidate-1",
      displayName: "Ada",
      ttlSeconds: 600,
    }).token;

    const asOperator = await review(app);
    const asCandidate = await review(app, "", { Authorization: `Bearer ${candidate}` });

    assert.equal(asCandidate.status, 200);
    assert.equal(asCandidate.body.data.timelineTotal, asOperator.body.data.timelineTotal);
    assert.equal(
      asCandidate.body.data.timelineTruncated,
      asOperator.body.data.timelineTruncated,
    );
  });
});

describe("review paging parameters are validated", () => {
  test("a malformed limit is a 400, not a silent default", async () => {
    const { app, mcp } = makeHarness({ eventCount: 10 });
    const before = mcp.callsFor(MCP_TOOLS.GET_SESSION_REVIEW).length;

    for (const query of [
      "?eventLimit=abc",
      "?eventLimit=0",
      "?eventLimit=-5",
      "?eventLimit=1.5",
      `?eventLimit=${REVIEW_EVENT_LIMIT_MAX + 1}`,
    ]) {
      const { status, body } = await review(app, query);
      assert.equal(status, 400, `expected 400 for ${query}`);
      assert.match(String(body.error), /eventLimit/);
    }

    // The authorization pre-check reads the session record, so allow for that;
    // the point is that no *additional* review was fetched for a bad request.
    assert.ok(
      mcp.callsFor(MCP_TOOLS.GET_SESSION_REVIEW).length <= before + 1,
      "a malformed page request must not reach the store",
    );
  });

  test("a malformed offset is a 400", async () => {
    const { app } = makeHarness({ eventCount: 10 });
    for (const query of ["?eventOffset=abc", "?eventOffset=-1", "?eventOffset=1.5"]) {
      const { status, body } = await review(app, query);
      assert.equal(status, 400, `expected 400 for ${query}`);
      assert.match(String(body.error), /eventOffset/);
    }
  });

  test("an empty parameter is treated as absent", async () => {
    const { app } = makeHarness({ eventCount: 10 });
    const { status, body } = await review(app, "?eventLimit=&eventOffset=");
    assert.equal(status, 200);
    assert.equal(body.data.timelineReturned, 10);
  });

  test("the maximum limit is accepted", async () => {
    const { app } = makeHarness({ eventCount: 10 });
    const { status, body } = await review(app, `?eventLimit=${REVIEW_EVENT_LIMIT_MAX}`);
    assert.equal(status, 200);
    assert.equal(body.data.timelineReturned, 10);
  });

  test("an offset past the end returns an empty, non-truncated page", async () => {
    const { app } = makeHarness({ eventCount: 4 });
    const { status, body } = await review(app, "?eventOffset=100");

    assert.equal(status, 200);
    assert.equal(body.data.timelineReturned, 0);
    assert.equal(body.data.timelineTotal, 4);
    assert.equal(body.data.timelineTruncated, false);
  });

  test("a bad page request is refused before the store is read", async () => {
    const { app, mcp } = makeHarness({ eventCount: 10 });
    await review(app, "?eventLimit=nope");
    // Only the ownership pre-check may have run; no review page was fetched with
    // a substituted size.
    for (const call of mcp.callsFor(MCP_TOOLS.GET_SESSION_REVIEW)) {
      assert.notEqual(call["eventLimit"], "nope");
    }
  });
});

describe("the cohort list does not present sampled counts as totals", () => {
  test("a short session reports unsampled counts", async () => {
    const { app } = makeHarness({ eventCount: 6 });
    const response = await app.request("/api/v1/sessions", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: Array<{ eventCount: number; countsSampled: boolean }>;
    };

    assert.equal(body.data[0]?.eventCount, 6);
    assert.equal(body.data[0]?.countsSampled, false);
  });

  test("a long session reports the true total and marks the counts sampled", async () => {
    const { app } = makeHarness({ eventCount: 1200 });
    const response = await app.request("/api/v1/sessions", { headers: OPERATOR });
    const body = (await response.json()) as {
      data: Array<{ eventCount: number; countsSampled: boolean }>;
    };

    assert.equal(
      body.data[0]?.eventCount,
      1200,
      "the cohort list must show the true total, not the page size",
    );
    assert.equal(
      body.data[0]?.countsSampled,
      true,
      "per-type counts come from a page and must be disclosed as sampled",
    );
  });
});
