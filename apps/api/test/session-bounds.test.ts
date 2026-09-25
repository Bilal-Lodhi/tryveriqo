/**
 * Bounded in-memory session projection tests.
 *
 * The projection exists so integrity thresholds can be evaluated on the ingestion
 * hot path without a datastore round trip. Nothing bounded its arrays, so a
 * session that kept receiving genuinely distinct telemetry — which is exactly what
 * duplicate suppression does not remove — grew them without limit.
 *
 * The bound must not redefine anything, so these tests pin both halves: the
 * windows stay bounded, and the counters beside them stay true totals.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import {
  MAX_RETAINED_EVENTS,
  MAX_RETAINED_KEYSTROKES,
  MAX_RETAINED_PASTES,
  applyEvent,
  applyEvents,
  computeKeystrokeMetrics,
  createSessionState,
  hydrateFromPersisted,
  shouldAnalyze,
  type SessionState,
} from "../src/integrity-session.js";
import type { MicroEvent, MicroEventType } from "../src/types.js";
import { StubAiClient, StubMcpClient, TEST_API_TOKEN, testConfig } from "./helpers.js";

const THRESHOLDS = {
  maxPasteEventsPerSession: 5,
  minHumanKeystrokeMs: 80,
  alertScoreThreshold: 50,
};

/** Comfortably longer than the 50-character floor `shouldAnalyze` requires. */
const SUBSTANTIAL_CODE =
  "export function solve(xs) { return xs.slice().sort((a, b) => a - b); } // long enough";

/** A distinct observation: `index` varies the second, so fingerprints differ. */
function event(index: number, eventType: MicroEventType = "TAB_SWITCH"): MicroEvent {
  return {
    eventId: `event-${index}`,
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
    problemId: "problem-1",
    eventType,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    payload: eventType === "KEYSTROKE" ? { char: "a", deltaMs: 100 + (index % 50) } : {},
    clientMetadata: {
      userAgent: "test",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
  };
}

function freshSession(): SessionState {
  return createSessionState({
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
  });
}

describe("the event window is bounded", () => {
  test("a session far beyond the window retains only the window", () => {
    const session = freshSession();
    const total = MAX_RETAINED_EVENTS + 500;

    for (let index = 0; index < total; index += 1) {
      applyEvent(session, event(index));
    }

    assert.equal(session.events.length, MAX_RETAINED_EVENTS);
    assert.equal(
      session.eventsObserved,
      total,
      "the observed total must stay a total, not become the window size",
    );
  });

  test("the window keeps the newest observations", () => {
    const session = freshSession();
    const total = MAX_RETAINED_EVENTS + 10;

    for (let index = 0; index < total; index += 1) {
      applyEvent(session, event(index));
    }

    // The last observation applied must still be present; the first must not.
    assert.equal(
      session.events.at(-1)?.eventId,
      `event-${total - 1}`,
      "the newest observation must be retained",
    );
    assert.equal(
      session.events.some((retained) => retained.eventId === "event-0"),
      false,
      "the oldest observation must have been trimmed",
    );
  });

  test("the window stays ordered oldest to newest", () => {
    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_EVENTS + 20; index += 1) {
      applyEvent(session, event(index));
    }

    const timestamps = session.events.map((retained) => retained.timestamp);
    const sorted = [...timestamps].sort();
    assert.deepEqual(timestamps, sorted);
  });

  test("a batch applies and trims without unbounded growth", () => {
    const session = freshSession();
    const batch = Array.from({ length: 400 }, (_, index) => event(index));

    for (let round = 0; round < 10; round += 1) {
      applyEvents(
        session,
        batch.map((original) => ({
          ...original,
          eventId: `${original.eventId}-round-${round}`,
          timestamp: new Date(
            Date.UTC(2026, 0, 1, 0, 0, round * 400 + Number(original.eventId.split("-")[1])),
          ).toISOString(),
        })),
      );
    }

    assert.equal(session.eventsObserved, 4000);
    assert.equal(session.events.length, MAX_RETAINED_EVENTS);
  });

  test("an empty session has an empty window and a zero total", () => {
    const session = freshSession();
    assert.equal(session.events.length, 0);
    assert.equal(session.eventsObserved, 0);
  });
});

describe("the keystroke window is bounded", () => {
  test("keystroke samples are bounded and counted separately", () => {
    const session = freshSession();
    const total = MAX_RETAINED_KEYSTROKES + 300;

    for (let index = 0; index < total; index += 1) {
      applyEvent(session, event(index, "KEYSTROKE"));
    }

    assert.equal(session.keystrokeDeltas.length, MAX_RETAINED_KEYSTROKES);
    assert.equal(session.keystrokeObservations, total);
  });

  test("a keystroke without a numeric delta is not counted as a sample", () => {
    const session = freshSession();
    applyEvent(session, {
      ...event(0, "KEYSTROKE"),
      payload: { char: "a" },
    });

    assert.equal(session.keystrokeDeltas.length, 0);
    assert.equal(session.keystrokeObservations, 0);
    assert.equal(session.eventsObserved, 1, "the observation itself still counts");
  });

  test("metrics summarise the retained window and stay finite", () => {
    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_KEYSTROKES + 50; index += 1) {
      applyEvent(session, event(index, "KEYSTROKE"));
    }

    const metrics = computeKeystrokeMetrics(session.keystrokeDeltas);
    assert.equal(metrics.sampleCount, MAX_RETAINED_KEYSTROKES);
    assert.ok(Number.isFinite(metrics.avgDeltaMs));
    assert.ok(Number.isFinite(metrics.minDeltaMs));
    assert.ok(Number.isFinite(metrics.maxDeltaMs));
  });

  test("the anomalous-keystroke heuristic still works on a full window", () => {
    const session = freshSession();
    // `shouldAnalyze` also requires a substantial submission, so build one first.
    applyEvent(session, {
      ...event(0, "PASTE_TRIGGER"),
      payload: { pasteContent: SUBSTANTIAL_CODE },
    });

    // Every delta is implausibly fast, so the ratio is 1.0 regardless of window.
    for (let index = 0; index < MAX_RETAINED_KEYSTROKES + 10; index += 1) {
      applyEvent(session, {
        ...event(index + 1, "KEYSTROKE"),
        payload: { char: "a", deltaMs: 5 },
      });
    }

    assert.equal(session.keystrokeDeltas.length, MAX_RETAINED_KEYSTROKES);
    assert.equal(shouldAnalyze(session, THRESHOLDS), true);
  });
});

describe("the paste window is bounded and independent", () => {
  test("pasted content is bounded and counted separately", () => {
    const session = freshSession();
    const total = MAX_RETAINED_PASTES + 20;

    for (let index = 0; index < total; index += 1) {
      applyEvent(session, {
        ...event(index, "PASTE_TRIGGER"),
        payload: { pasteContent: `block ${index}` },
      });
    }

    assert.equal(session.recentPasteContents.length, MAX_RETAINED_PASTES);
    assert.equal(session.pasteObservations, total);
    assert.equal(session.pasteCount, total, "the paste counter stays a total");
  });

  test("the paste window keeps the newest content", () => {
    const session = freshSession();
    const total = MAX_RETAINED_PASTES + 5;

    for (let index = 0; index < total; index += 1) {
      applyEvent(session, {
        ...event(index, "PASTE_TRIGGER"),
        payload: { pasteContent: `block ${index}` },
      });
    }

    assert.equal(session.recentPasteContents.at(-1), `block ${total - 1}`);
    assert.equal(session.recentPasteContents.includes("block 0"), false);
  });

  test("a paste without content is counted but contributes no sample", () => {
    const session = freshSession();
    applyEvent(session, { ...event(0, "PASTE_TRIGGER"), payload: {} });

    assert.equal(session.pasteCount, 1);
    assert.equal(session.pasteObservations, 0);
    assert.equal(session.recentPasteContents.length, 0);
  });

  test("trimming the event window does not change the paste window", () => {
    // The two windows have separate bounds precisely so one cannot redefine the
    // other's contents.
    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_PASTES; index += 1) {
      applyEvent(session, {
        ...event(index, "PASTE_TRIGGER"),
        payload: { pasteContent: `paste ${index}` },
      });
    }
    const pastesBefore = [...session.recentPasteContents];

    // Flood with events that are not pastes, well past the event window.
    for (let index = 0; index < MAX_RETAINED_EVENTS + 100; index += 1) {
      applyEvent(session, event(MAX_RETAINED_PASTES + index, "TAB_SWITCH"));
    }

    assert.deepEqual(
      session.recentPasteContents,
      pastesBefore,
      "non-paste events must not evict pasted content",
    );
    assert.equal(session.events.length, MAX_RETAINED_EVENTS);
  });
});

describe("counters that are totals stay totals", () => {
  test("every event-type counter survives window trimming", () => {
    const session = freshSession();
    const perType = MAX_RETAINED_EVENTS / 2;

    for (let index = 0; index < perType; index += 1) {
      applyEvent(session, event(index * 2, "TAB_SWITCH"));
      applyEvent(session, event(index * 2 + 1, "WINDOW_BLUR"));
    }

    assert.equal(session.events.length, MAX_RETAINED_EVENTS);
    assert.equal(session.tabSwitchCount, perType);
    assert.equal(session.windowBlurCount, perType);
    assert.equal(session.eventsObserved, perType * 2);
  });

  test("a duplicate is still suppressed after the window is full", () => {
    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_EVENTS + 50; index += 1) {
      applyEvent(session, event(index));
    }

    const before = session.tabSwitchCount;
    const replayed = applyEvent(session, {
      ...event(MAX_RETAINED_EVENTS + 49),
      eventId: "replayed",
    });

    assert.equal(replayed.applied, false);
    assert.equal(replayed.duplicate, true);
    assert.equal(session.tabSwitchCount, before);
    assert.equal(session.eventsObserved, MAX_RETAINED_EVENTS + 50);
  });
});

describe("recovery from a truncated page is disclosed", () => {
  test("a full recovery is not marked partial", () => {
    const recovered = hydrateFromPersisted({
      session: { sessionId: "s", candidateId: "c", assessmentId: "a" },
      events: [event(0), event(1)],
    });

    assert.equal(recovered.recoveredFromStore, true);
    assert.equal(recovered.recoveredPartially, false);
  });

  test("a partial recovery is marked and still counts what it saw", () => {
    const recovered = hydrateFromPersisted({
      session: { sessionId: "s", candidateId: "c", assessmentId: "a" },
      events: [event(0), event(1)],
      recoveredPartially: true,
    });

    assert.equal(recovered.recoveredPartially, true);
    assert.equal(recovered.eventsObserved, 2);
  });

  test("recovery over a long history bounds its own window", () => {
    const recovered = hydrateFromPersisted({
      session: { sessionId: "s", candidateId: "c", assessmentId: "a" },
      events: Array.from({ length: MAX_RETAINED_EVENTS + 200 }, (_, index) => event(index)),
    });

    assert.equal(recovered.events.length, MAX_RETAINED_EVENTS);
    assert.equal(recovered.eventsObserved, MAX_RETAINED_EVENTS + 200);
  });
});

describe("the operator summary reports totals and window sizes", () => {
  function makeApp() {
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
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }));

    const sessions = new SessionRegistry();
    const app = buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp,
      sessions,
      log: () => undefined,
      requestLogging: false,
    });

    return { app, sessions };
  }

  test("a flooded projection reports true totals beside bounded windows", async () => {
    const { app, sessions } = makeApp();

    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_EVENTS + 250; index += 1) {
      applyEvent(session, event(index, "TAB_SWITCH"));
    }
    sessions.set(session);

    const response = await app.request("/api/v1/integrity/sessions/session-1", {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    assert.equal(response.status, 200);

    const body = (await response.json()) as {
      session: Record<string, number | boolean>;
    };

    assert.equal(body.session["eventCount"], MAX_RETAINED_EVENTS + 250);
    assert.equal(body.session["retainedEvents"], MAX_RETAINED_EVENTS);
    assert.equal(body.session["tabSwitchCount"], MAX_RETAINED_EVENTS + 250);
    assert.ok(
      (body.session["retainedEvents"] as number) < (body.session["eventCount"] as number),
      "the window must be visibly smaller than the total",
    );
  });

  test("a fresh projection reports equal totals and window sizes", async () => {
    const { app, sessions } = makeApp();

    const session = freshSession();
    for (let index = 0; index < 12; index += 1) applyEvent(session, event(index));
    sessions.set(session);

    const response = await app.request("/api/v1/integrity/sessions/session-1", {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    const body = (await response.json()) as { session: Record<string, number> };

    assert.equal(body.session["eventCount"], 12);
    assert.equal(body.session["retainedEvents"], 12);
  });

  test("a partial recovery is visible in the summary", async () => {
    const { app, sessions } = makeApp();

    const recovered = hydrateFromPersisted({
      session: { sessionId: "session-1", candidateId: "candidate-1", assessmentId: "assessment-1" },
      events: [event(0), event(1)],
      recoveredPartially: true,
    });
    sessions.set(recovered);

    const response = await app.request("/api/v1/integrity/sessions/session-1", {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    const body = (await response.json()) as { session: Record<string, boolean> };

    assert.equal(body.session["recoveredFromStore"], true);
    assert.equal(body.session["recoveredPartially"], true);
  });
});

describe("a flooded session is still analysed correctly", () => {  test("thresholds still trip after the window has rolled over", () => {
    const session = freshSession();
    // A substantial submission is also required before analysis is considered.
    applyEvent(session, {
      ...event(0, "PASTE_TRIGGER"),
      payload: { pasteContent: SUBSTANTIAL_CODE },
    });

    for (let index = 0; index < MAX_RETAINED_EVENTS + 100; index += 1) {
      applyEvent(session, event(index + 1, "DEVELOPER_TOOLS_OPEN"));
    }

    assert.equal(session.devToolsOpenCount, MAX_RETAINED_EVENTS + 100);
    assert.equal(session.events.length, MAX_RETAINED_EVENTS);
    assert.equal(shouldAnalyze(session, THRESHOLDS), true);
  });

  test("analysis input stays bounded after a flood", () => {
    const session = freshSession();
    for (let index = 0; index < MAX_RETAINED_EVENTS; index += 1) {
      applyEvent(session, {
        ...event(index, "PASTE_TRIGGER"),
        payload: { pasteContent: `block ${index} ${"x".repeat(50)}` },
      });
    }

    // What the analysis is handed is bounded, and the code snapshot still grew.
    assert.equal(session.recentPasteContents.length, MAX_RETAINED_PASTES);
    assert.ok(session.currentCode.length > 0);
    assert.equal(shouldAnalyze(session, THRESHOLDS), true);
  });
});
