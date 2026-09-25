/**
 * Recovery counter-fidelity tests.
 *
 * Rebuilding a session projection replays the events the store returned, and
 * `get_session_review` returns at most one page. For a session longer than a page
 * that made the reconstructed counters page-derived, and those counters feed
 * `shouldAnalyze` — so a long session could fail to cross a threshold it had in
 * fact crossed.
 *
 * These tests pin the fix: when the store supplies exact per-type counts, the
 * rebuilt projection's counters are totals, and it says so.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_TOOLS,
  MongoStore,
  createToolHandlers,
  dispatchTool,
} from "@assessment/mcp-mongodb";
import { createFakeDb } from "./fake-db.js";

async function makeStore() {
  const fake = createFakeDb();
  const store = new MongoStore({
    uri: "mongodb://127.0.0.1:27017",
    databaseName: "assessment_recovery_test",
    connect: async () => ({ handle: fake.db, close: async () => undefined }),
  });
  await store.connect();
  return { store, db: fake };
}

/** Creates a session and `count` events of one type, one second apart. */
async function seed(
  store: MongoStore,
  sessionId: string,
  count: number,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await store.createSession({ sessionId, candidateId: "candidate-1", assessmentId: "assessment-1" });
  await store.ingestMicroEvents(
    Array.from({ length: count }, (_, index) => ({
      sessionId,
      eventType,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload,
    })),
  );
}

async function call(store: MongoStore, args: Record<string, unknown>) {
  const handlers = createToolHandlers(store);
  const result = await dispatchTool(handlers, MCP_TOOLS.GET_SESSION_REVIEW, args);
  return { status: result.status, body: result.payload as Record<string, unknown> };
}

describe("countSessionEventsByType", () => {
  test("counts each type exactly", async () => {
    const { store } = await makeStore();
    await store.createSession({
      sessionId: "session-1",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });
    await store.ingestMicroEvents([
      ...Array.from({ length: 7 }, (_, index) => ({
        sessionId: "session-1",
        eventType: "TAB_SWITCH",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        payload: {},
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        sessionId: "session-1",
        eventType: "PASTE_TRIGGER",
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 1, index)).toISOString(),
        payload: { pasteContent: "x" },
      })),
    ]);

    const counts = await store.countSessionEventsByType("session-1");
    assert.equal(counts["TAB_SWITCH"], 7);
    assert.equal(counts["PASTE_TRIGGER"], 3);
  });

  test("is empty for an unknown session", async () => {
    const { store } = await makeStore();
    assert.deepEqual(await store.countSessionEventsByType("missing"), {});
  });

  test("does not count another session's events", async () => {
    const { store } = await makeStore();
    await seed(store, "session-1", 5, "TAB_SWITCH");
    await seed(store, "session-2", 2, "TAB_SWITCH");

    assert.deepEqual(await store.countSessionEventsByType("session-1"), { TAB_SWITCH: 5 });
  });
});

describe("exact counts are opt-in", () => {
  test("they are absent unless requested", async () => {
    const { store } = await makeStore();
    await seed(store, "session-1", 3, "TAB_SWITCH");

    const { body } = await call(store, { sessionId: "session-1" });
    assert.equal(
      body["eventCounts"],
      undefined,
      "the cohort list calls this per session and must not pay for the aggregation",
    );
  });

  test("they are returned when requested", async () => {
    const { store } = await makeStore();
    await seed(store, "session-1", 3, "TAB_SWITCH");

    const { body } = await call(store, { sessionId: "session-1", includeEventCounts: true });
    assert.deepEqual(body["eventCounts"], { TAB_SWITCH: 3 });
  });

  test("a non-boolean flag is treated as absent", async () => {
    const { store } = await makeStore();
    await seed(store, "session-1", 2, "TAB_SWITCH");

    for (const flag of ["true", 1, {}, null]) {
      const { body } = await call(store, { sessionId: "session-1", includeEventCounts: flag });
      assert.equal(body["eventCounts"], undefined, `expected no counts for ${JSON.stringify(flag)}`);
    }
  });

  test("the advertised schema documents the flag", async () => {
    const { TOOL_DEFINITIONS_BY_NAME } = await import("@assessment/mcp-mongodb");
    const definition = TOOL_DEFINITIONS_BY_NAME[MCP_TOOLS.GET_SESSION_REVIEW];
    const properties = definition.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties["includeEventCounts"], "includeEventCounts must be advertised");
  });
});

describe("exact counts exceed what one page can reconstruct", () => {
  test("a session longer than a page reports the true per-type totals", async () => {
    // The defect: 1200 stored events, a 500-event page, and counters that
    // therefore described 500 of them.
    const { store } = await makeStore();
    await seed(store, "session-1", 1200, "DEVELOPER_TOOLS_OPEN");

    const { body } = await call(store, {
      sessionId: "session-1",
      eventLimit: 500,
      includeEventCounts: true,
    });

    assert.equal(body["eventsReturned"], 500);
    assert.equal(body["eventsTruncated"], true);
    assert.equal(
      (body["eventCounts"] as Record<string, number>)["DEVELOPER_TOOLS_OPEN"],
      1200,
      "the counts must describe the record, not the page",
    );
  });

  test("counts are exact even for the smallest possible page", async () => {
    const { store } = await makeStore();
    await seed(store, "session-1", 40, "TAB_SWITCH");

    const { body } = await call(store, {
      sessionId: "session-1",
      eventLimit: 1,
      includeEventCounts: true,
    });

    assert.equal(body["eventsReturned"], 1);
    assert.equal((body["eventCounts"] as Record<string, number>)["TAB_SWITCH"], 40);
  });
});
