/**
 * Integrity session engine tests.
 *
 * Covers duplicate suppression, the keystroke heuristics, the code-hash
 * analysis guard, and post-restart recovery from the persisted record. All
 * pure state manipulation — no network, no database.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  FINGERPRINT_WINDOW,
  SessionRegistry,
  applyEvent,
  applyEvents,
  computeKeystrokeMetrics,
  createSessionState,
  eventFingerprint,
  hasAnomalousKeystrokes,
  hydrateFromPersisted,
  isDuplicateEvent,
  shouldAnalyze,
} from "../src/integrity-session.js";
import type { MicroEvent, MicroEventType } from "../src/types.js";

const THRESHOLDS = {
  maxPasteEventsPerSession: 5,
  minHumanKeystrokeMs: 80,
  alertScoreThreshold: 50,
};

function event(
  eventType: MicroEventType,
  payload: Record<string, unknown> = {},
  overrides: Partial<MicroEvent> = {},
): MicroEvent {
  return {
    eventId: `event-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: "session-1",
    candidateId: "candidate-1",
    assessmentId: "assessment-1",
    problemId: "problem-1",
    eventType,
    timestamp: "2026-01-01T00:00:00.000Z",
    payload,
    clientMetadata: {
      userAgent: "test",
      ipAddress: "127.0.0.1",
      screenResolution: "1920x1080",
      platform: "web",
      language: "en-US",
    },
    ...overrides,
  };
}

describe("duplicate suppression", () => {
  test("identical observations are applied only once", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    const paste = event("PASTE_TRIGGER", { pasteContent: "const x = 1;" });
    const first = applyEvent(session, paste);
    // A retrying client re-serialises the same observation with a new eventId.
    // It must still be recognised as a duplicate.
    const replay = applyEvent(session, {
      ...paste,
      eventId: "different-event-id",
    });

    assert.equal(first.applied, true);
    assert.equal(replay.applied, false);
    assert.equal(replay.duplicate, true);
    assert.equal(session.pasteCount, 1, "counters must not be inflated by replays");
    assert.equal(session.events.length, 1);
  });

  test("applyEvents reports applied and duplicate counts", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    const batch = [
      event("KEYSTROKE", { deltaMs: 120, char: "a" }),
      event("KEYSTROKE", { deltaMs: 130, char: "b" }),
    ];

    const first = applyEvents(session, batch);
    assert.deepEqual(first, { appliedCount: 2, duplicateCount: 0 });

    const second = applyEvents(session, batch);
    assert.deepEqual(second, { appliedCount: 0, duplicateCount: 2 });
    assert.equal(session.keystrokeDeltas.length, 2);
  });

  test("distinct events with the same type are not suppressed", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    // Two tab switches a few seconds apart are two distinct observations.
    applyEvent(
      session,
      event("TAB_SWITCH", { visibilityState: "hidden" }, { timestamp: "2026-01-01T00:00:00.000Z" }),
    );
    applyEvent(
      session,
      event("TAB_SWITCH", { visibilityState: "hidden" }, { timestamp: "2026-01-01T00:00:12.000Z" }),
    );

    assert.equal(session.tabSwitchCount, 2);
  });

  test("an event repeated within the same second collapses", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    applyEvent(
      session,
      event("TAB_SWITCH", { visibilityState: "hidden" }, { timestamp: "2026-01-01T00:00:00.100Z" }),
    );
    applyEvent(
      session,
      event("TAB_SWITCH", { visibilityState: "hidden" }, { timestamp: "2026-01-01T00:00:00.900Z" }),
    );

    assert.equal(session.tabSwitchCount, 1);
  });

  test("the fingerprint window is bounded", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    for (let index = 0; index < FINGERPRINT_WINDOW + 40; index += 1) {
      applyEvent(session, event("KEYSTROKE", { deltaMs: index * 10, char: String.fromCharCode(97 + (index % 26)) }));
    }

    assert.ok(session.recentEventFingerprints.size <= FINGERPRINT_WINDOW);
  });

  test("a fingerprint is stable for identical observations", () => {
    const one = event("PASTE_TRIGGER", { pasteContent: "abc" });
    // Same observation, re-sent by a retrying client: a new id, same time.
    const two = { ...one, eventId: "other" };
    assert.equal(eventFingerprint(one), eventFingerprint(two));
  });

  test("a fingerprint distinguishes observations from different moments", () => {
    const one = event("TAB_SWITCH", {}, { timestamp: "2026-01-01T00:00:00.000Z" });
    const later = event("TAB_SWITCH", {}, { timestamp: "2026-01-01T00:00:30.000Z" });
    assert.notEqual(eventFingerprint(one), eventFingerprint(later));
  });
});

describe("code reconstruction", () => {
  test("paste events extend the code snapshot", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    applyEvent(session, event("PASTE_TRIGGER", { pasteContent: "function a() {}" }));
    assert.equal(session.currentCode, "function a() {}");
  });

  test("a unified diff replaces the snapshot with its added lines", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    applyEvent(
      session,
      event("CODE_DELTA", { diffPatch: "@@ -1,1 +1,2 @@\n+const a = 1;\n+const b = 2;" }),
    );
    assert.equal(session.currentCode, "const a = 1;\nconst b = 2;");
  });

  test("a submission snapshot wins and moves the session to submitted", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    applyEvent(session, event("PASTE_TRIGGER", { pasteContent: "draft" }));
    applyEvent(session, event("SUBMIT", { pasteContent: "final answer" }));

    assert.equal(session.currentCode, "final answer");
    assert.equal(session.submitted, true);
    assert.equal(session.status, "submitted");
  });
});

describe("integrity heuristics", () => {
  test("keystroke metrics summarise the sample", () => {
    const metrics = computeKeystrokeMetrics([100, 200, 300]);
    assert.equal(metrics.sampleCount, 3);
    assert.equal(metrics.avgDeltaMs, 200);
    assert.equal(metrics.maxDeltaMs, 300);
    assert.equal(metrics.minDeltaMs, 100);
  });

  test("empty keystroke samples report zeros rather than NaN", () => {
    assert.deepEqual(computeKeystrokeMetrics([]), {
      avgDeltaMs: 0,
      maxDeltaMs: 0,
      minDeltaMs: 0,
      sampleCount: 0,
    });
  });

  test("implausibly fast typing is flagged", () => {
    assert.equal(hasAnomalousKeystrokes([10, 10, 10, 10, 10, 10, 10, 10, 10, 10], 80), true);
    assert.equal(hasAnomalousKeystrokes([200, 200, 200, 200, 200, 200, 200, 200, 200, 200], 80), false);
  });

  test("short keystroke samples are never flagged", () => {
    assert.equal(hasAnomalousKeystrokes([10, 10, 10], 80), false);
  });

  test("analysis is skipped until the submission has substance", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    applyEvent(session, event("PASTE_TRIGGER", { pasteContent: "short" }));
    assert.equal(session.pasteCount, 1);
    assert.equal(shouldAnalyze(session, THRESHOLDS), false, "a 5-character paste is not analysable");
  });

  test("analysis triggers on excessive pasting", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    for (let index = 0; index < THRESHOLDS.maxPasteEventsPerSession + 1; index += 1) {
      applyEvent(session, event("PASTE_TRIGGER", { pasteContent: `block ${index} ${"x".repeat(40)}` }));
    }
    assert.equal(shouldAnalyze(session, THRESHOLDS), true);
  });

  test("analysis is suppressed once a session is terminated", () => {
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
      status: "terminated",
    });
    applyEvent(session, event("PASTE_TRIGGER", { pasteContent: "x".repeat(200) }));
    assert.equal(shouldAnalyze(session, THRESHOLDS), false);
  });
});

describe("post-restart session recovery", () => {
  test("rebuilds counters and code from the persisted record", () => {
    const storedEvents: MicroEvent[] = [
      event("KEYSTROKE", { deltaMs: 120, char: "a" }, { timestamp: "2026-01-01T00:00:01.000Z" }),
      event("PASTE_TRIGGER", { pasteContent: "const a = 1;" }, { timestamp: "2026-01-01T00:00:02.000Z" }),
      event("TAB_SWITCH", { visibilityState: "hidden" }, { timestamp: "2026-01-01T00:00:03.000Z" }),
      event("COPY_ATTEMPT", { selectedText: "const a" }, { timestamp: "2026-01-01T00:00:04.000Z" }),
    ];

    const recovered = hydrateFromPersisted({
      session: {
        sessionId: "session-recovered",
        candidateId: "candidate-9",
        assessmentId: "assessment-9",
        status: "in_progress",
      },
      events: storedEvents,
    });

    assert.equal(recovered.recoveredFromStore, true);
    assert.equal(recovered.pasteCount, 1);
    assert.equal(recovered.tabSwitchCount, 1);
    assert.equal(recovered.copyAttemptCount, 1);
    assert.equal(recovered.keystrokeDeltas.length, 1);
    assert.equal(recovered.currentCode, "const a = 1;");
    assert.equal(recovered.candidateId, "candidate-9");
  });

  test("a persisted code snapshot takes precedence over reconstructed code", () => {
    const recovered = hydrateFromPersisted({
      session: {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        submittedCode: "authoritative snapshot",
      },
      events: [event("PASTE_TRIGGER", { pasteContent: "reconstructed" })],
    });

    assert.equal(recovered.currentCode, "authoritative snapshot");
    assert.equal(recovered.pasteCount, 1, "counters are still rebuilt from history");
  });

  test("recovery normalises an unknown persisted status", () => {
    const recovered = hydrateFromPersisted({
      session: {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        status: "something-unexpected",
      },
      events: [],
    });
    assert.equal(recovered.status, "in_progress");
  });

  test("replayed recovery is idempotent", () => {
    const storedEvents = [
      event("PASTE_TRIGGER", { pasteContent: "abc" }),
      event("PASTE_TRIGGER", { pasteContent: "abc" }),
    ];
    const recovered = hydrateFromPersisted({
      session: { sessionId: "session-1", candidateId: "candidate-1", assessmentId: "assessment-1" },
      events: storedEvents,
    });
    assert.equal(recovered.pasteCount, 1, "duplicates in stored history collapse on recovery");
  });

  test("duplicate detection works on a recovered session", () => {
    const paste = event("PASTE_TRIGGER", { pasteContent: "abc" });
    const recovered = hydrateFromPersisted({
      session: { sessionId: "session-1", candidateId: "candidate-1", assessmentId: "assessment-1" },
      events: [paste],
    });
    assert.equal(isDuplicateEvent(recovered, paste), true);
  });
});

describe("session registry", () => {
  test("tracks and removes sessions", () => {
    const registry = new SessionRegistry();
    const session = createSessionState({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    assert.equal(registry.has("session-1"), false);
    registry.set(session);
    assert.equal(registry.has("session-1"), true);
    assert.equal(registry.size, 1);
    assert.equal(registry.delete("session-1"), true);
    assert.equal(registry.delete("session-1"), false);
    assert.equal(registry.size, 0);
  });
});
