/**
 * Data-layer naming and behaviour tests.
 *
 * Proves that readers and writers resolve the same collection names, that the
 * session deletion path removes dependent telemetry and reports, and that the
 * aggregate candidate report returns one row per session.
 *
 * The MongoDB driver is not emulated: `createFakeDb` implements exactly the
 * surface `MongoStore` uses, so a new query shape in the store fails loudly here
 * rather than passing silently.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTIONS,
  DEFAULT_DATABASE_NAME,
  MCP_TOOLS,
  MongoStore,
  createToolHandlers,
} from "@assessment/mcp-mongodb";
import { createFakeDb } from "./fake-db.js";

// ─── Store factory ─────────────────────────────────────────────────

async function makeStore(): Promise<{
  store: MongoStore;
  db: ReturnType<typeof createFakeDb>;
}> {
  const fake = createFakeDb();
  const store = new MongoStore({
    uri: "mongodb://127.0.0.1:27017",
    databaseName: "assessment_test",
    connect: async () => ({ handle: fake.db, close: async () => undefined }),
  });
  await store.connect();
  return { store, db: fake };
}
// ─── Tests ─────────────────────────────────────────────────────────

describe("collection naming", () => {
  test("the four collections have assessment-native names", () => {
    assert.deepEqual(COLLECTIONS, {
      testSuites: "generated_test_suites",
      sessions: "assessment_sessions",
      microEvents: "micro_events",
      integrityReports: "integrity_reports",
    });
    assert.equal(DEFAULT_DATABASE_NAME, "assessment");
  });

  test("writes and reads resolve the same collections", async () => {
    const { store, db } = await makeStore();

    await store.storeTestSuite({ metadata: { suiteId: "suite-1" } });
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    await store.ingestMicroEvents([
      { sessionId: "session-1", eventType: "KEYSTROKE", timestamp: "2026-01-01T00:00:00.000Z" },
    ]);
    await store.storeIntegrityReport({
      integrityReportId: "report-1",
      sessionId: "session-1",
      candidateId: "candidate-1",
      overallScore: 30,
      generatedAt: "2026-01-01T00:10:00.000Z",
    });

    // The documents must land in the four declared collections, nowhere else.
    assert.equal(db.docs(COLLECTIONS.testSuites).length, 1);
    assert.equal(db.docs(COLLECTIONS.sessions).length, 1);
    assert.equal(db.docs(COLLECTIONS.microEvents).length, 1);
    assert.equal(db.docs(COLLECTIONS.integrityReports).length, 1);

    const suite = await store.getTestSuite("suite-1");
    assert.ok(suite, "the suite must be readable through the same collection it was written to");
    const session = await store.getSession("session-1");
    assert.ok(session);
    const events = await store.getSessionEvents("session-1");
    assert.equal(events.length, 1);
    const reports = await store.getIntegrityReports("session-1");
    assert.equal(reports.length, 1);
  });

  test("no legacy database or collection name is referenced", async () => {
    const { store } = await makeStore();
    assert.equal(store.databaseNameInUse, "assessment_test");
    for (const name of Object.values(COLLECTIONS)) {
      assert.doesNotMatch(name, /gorilla|audit|employee|risk_assess|exfiltration/i);
    }
  });

  test("creating a session twice is idempotent", async () => {
    const { store, db } = await makeStore();
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    assert.equal(db.docs(COLLECTIONS.sessions).length, 1);
  });

  test("session updates write the fields readers expect", async () => {
    const { store } = await makeStore();
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    assert.equal(await store.updateSession("session-1", { submittedCode: "code" }), true);
    assert.equal(await store.updateSession("session-1", { status: "submitted" }), true);

    const session = await store.getSession("session-1");
    assert.equal(session?.["submittedCode"], "code");
    assert.equal(session?.["status"], "submitted");
  });
});

describe("session termination", () => {
  test("deleting a session removes its telemetry and reports", async () => {
    const { store, db } = await makeStore();
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    await store.createSession({
      sessionId: "session-2",
      candidateId: "candidate-2",
      assessmentId: "assessment-1",
    });
    await store.ingestMicroEvents([
      { sessionId: "session-1", eventType: "PASTE_TRIGGER", timestamp: "2026-01-01T00:00:00.000Z" },
      { sessionId: "session-1", eventType: "TAB_SWITCH", timestamp: "2026-01-01T00:00:01.000Z" },
      { sessionId: "session-2", eventType: "KEYSTROKE", timestamp: "2026-01-01T00:00:02.000Z" },
    ]);
    await store.storeIntegrityReport({ sessionId: "session-1", overallScore: 20 });
    await store.storeIntegrityReport({ sessionId: "session-2", overallScore: 10 });

    assert.equal(await store.deleteSession("session-1"), true);

    assert.equal(await store.getSession("session-1"), null);
    assert.equal((await store.getSessionEvents("session-1")).length, 0);
    assert.equal((await store.getIntegrityReports("session-1")).length, 0);

    // The other candidate's data is untouched.
    assert.ok(await store.getSession("session-2"));
    assert.equal((await store.getSessionEvents("session-2")).length, 1);
    assert.equal((await store.getIntegrityReports("session-2")).length, 1);

    assert.equal(db.docs(COLLECTIONS.sessions).length, 1);
  });

  test("deleting an unknown session reports no deletion", async () => {
    const { store } = await makeStore();
    assert.equal(await store.deleteSession("never-existed"), false);
  });
});

describe("candidate report aggregation", () => {
  test("returns one report per session, the most recent", async () => {
    const { store } = await makeStore();
    await store.storeIntegrityReport({
      sessionId: "session-1",
      candidateId: "candidate-1",
      overallScore: 10,
      generatedAt: "2026-01-01T00:01:00.000Z",
    });
    await store.storeIntegrityReport({
      sessionId: "session-1",
      candidateId: "candidate-1",
      overallScore: 70,
      generatedAt: "2026-01-01T00:05:00.000Z",
    });
    await store.storeIntegrityReport({
      sessionId: "session-2",
      candidateId: "candidate-1",
      overallScore: 30,
      generatedAt: "2026-01-02T00:01:00.000Z",
    });
    await store.storeIntegrityReport({
      sessionId: "session-3",
      candidateId: "other-candidate",
      overallScore: 99,
      generatedAt: "2026-01-03T00:01:00.000Z",
    });

    const reports = await store.getCandidateReport("candidate-1");
    assert.equal(reports.length, 2, "one row per session for this candidate");
    assert.deepEqual(
      reports.map((report) => report["sessionId"]).sort(),
      ["session-1", "session-2"],
    );
    const sessionOne = reports.find((report) => report["sessionId"] === "session-1");
    assert.equal(sessionOne?.["overallScore"], 70, "the newest report per session must win");
  });
});

describe("tool handlers against the real store", () => {
  test("a suite round-trips through store_test_suite and get_test_suite", async () => {
    const { store } = await makeStore();
    const handlers = createToolHandlers(store);

    const stored = (await handlers[MCP_TOOLS.STORE_TEST_SUITE]({
      suite: { metadata: { suiteId: "suite-round-trip", generatedAt: "2026-01-01T00:00:00.000Z" } },
    })) as { success: boolean; mongoDocumentId: string };
    assert.equal(stored.success, true);
    assert.ok(stored.mongoDocumentId);

    const fetched = (await handlers[MCP_TOOLS.GET_TEST_SUITE]({ suiteId: "suite-round-trip" })) as {
      success: boolean;
      data: { metadata: { suiteId: string } } | null;
    };
    assert.equal(fetched.data?.metadata.suiteId, "suite-round-trip");
  });

  test("judge joins across renamed collections resolve", async () => {
    const { store } = await makeStore();
    const handlers = createToolHandlers(store);

    await handlers[MCP_TOOLS.CREATE_SESSION]({
      sessionId: "session-join",
      candidateId: "candidate-join",
      assessmentId: "assessment-join",
    });
    await handlers[MCP_TOOLS.INGEST_MICRO_EVENTS]({
      events: [
        {
          sessionId: "session-join",
          eventType: "SUBMIT",
          timestamp: "2026-01-01T00:09:00.000Z",
        },
      ],
    });
    await handlers[MCP_TOOLS.STORE_INTEGRITY_REPORT]({
      report: {
        sessionId: "session-join",
        candidateId: "candidate-join",
        assessmentId: "assessment-join",
        overallScore: 55,
        generatedAt: "2026-01-01T00:10:00.000Z",
      },
    });
    await handlers[MCP_TOOLS.UPDATE_SESSION_CODE]({ sessionId: "session-join", code: "final code" });

    const review = (await handlers[MCP_TOOLS.GET_SESSION_REVIEW]({ sessionId: "session-join" })) as {
      session: { candidateId: string; submittedCode: string } | null;
      events: Array<{ eventType: string }>;
      integrityReports: Array<{ overallScore: number }>;
    };

    assert.equal(review.session?.candidateId, "candidate-join");
    assert.equal(review.session?.submittedCode, "final code");
    assert.equal(review.events.length, 1);
    assert.equal(review.events[0]?.eventType, "SUBMIT");
    assert.equal(review.integrityReports[0]?.overallScore, 55);
  });

  test("tool handlers reject malformed arguments", async () => {
    const { store } = await makeStore();
    const handlers = createToolHandlers(store);

    await assert.rejects(() => handlers[MCP_TOOLS.GET_TEST_SUITE]({}), /suiteId/);
    await assert.rejects(() => handlers[MCP_TOOLS.INGEST_MICRO_EVENTS]({ events: [] }), /events/);
    await assert.rejects(
      () => handlers[MCP_TOOLS.CREATE_SESSION]({ sessionId: "s", candidateId: "c" }),
      /assessmentId/,
    );
  });

  test("health_check reports connectivity and the database in use", async () => {
    const { store } = await makeStore();
    const handlers = createToolHandlers(store);
    const health = (await handlers[MCP_TOOLS.HEALTH_CHECK]({})) as {
      connected: boolean;
      healthy: boolean;
      database: string;
    };
    assert.equal(health.connected, true);
    assert.equal(health.healthy, true);
    assert.equal(health.database, "assessment_test");
  });

  test("list_sessions returns the fields the console reads", async () => {
    const { store } = await makeStore();
    const handlers = createToolHandlers(store);
    await handlers[MCP_TOOLS.CREATE_SESSION]({
      sessionId: "session-list",
      candidateId: "candidate-list",
      assessmentId: "assessment-list",
    });

    const listed = (await handlers[MCP_TOOLS.LIST_SESSIONS]({})) as {
      data: Array<Record<string, unknown>>;
    };
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0]?.["sessionId"], "session-list");
    assert.equal(listed.data[0]?.["candidateId"], "candidate-list");
    assert.equal(listed.data[0]?.["assessmentId"], "assessment-list");
    assert.equal(listed.data[0]?.["status"], "in_progress");
    assert.ok(listed.data[0]?.["createdAt"]);
  });
});

