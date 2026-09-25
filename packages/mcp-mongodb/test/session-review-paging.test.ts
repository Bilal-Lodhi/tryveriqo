/**
 * Session-review pagination and truncation-disclosure tests.
 *
 * `get_session_review` returned at most the newest 500 events and said nothing
 * about it, so a reviewer looking at a long session saw a partial timeline
 * presented as the whole one, and `eventCount` in the cohort list undercounted.
 * These tests pin the disclosure: the true total, the page actually returned, a
 * truncation flag, and a continuation offset.
 *
 * Note for maintainers: this package's tests import the package by name, so they
 * exercise `dist/`. Run `npm run build` after a source change or the suite will
 * silently test the previous build.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MCP_TOOLS,
  MongoStore,
  REVIEW_EVENT_LIMIT_DEFAULT,
  REVIEW_EVENT_LIMIT_MAX,
  createToolHandlers,
  dispatchTool,
} from "@assessment/mcp-mongodb";
import { createFakeDb } from "./fake-db.js";

async function makeStore() {
  const fake = createFakeDb();
  const store = new MongoStore({
    uri: "mongodb://127.0.0.1:27017",
    databaseName: "assessment_paging_test",
    connect: async () => ({ handle: fake.db, close: async () => undefined }),
  });
  await store.connect();
  return { store, db: fake };
}

/** Creates a session and `count` telemetry events, one second apart. */
async function seedSession(store: MongoStore, sessionId: string, count: number) {
  await store.createSession({ sessionId, candidateId: "candidate-1", assessmentId: "assessment-1" });
  await store.ingestMicroEvents(
    Array.from({ length: count }, (_, index) => ({
      sessionId,
      eventType: "KEYSTROKE",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      payload: { char: "a", deltaMs: 100 + index },
    })),
  );
}

async function review(store: MongoStore, args: Record<string, unknown>) {
  const handlers = createToolHandlers(store);
  const result = await dispatchTool(handlers, MCP_TOOLS.GET_SESSION_REVIEW, args);
  return { status: result.status, body: result.payload as Record<string, unknown> };
}

describe("countSessionEvents", () => {
  test("counts every stored event for a session", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 7);
    assert.equal(await store.countSessionEvents("session-1"), 7);
  });

  test("counts nothing for an unknown session", async () => {
    const { store } = await makeStore();
    assert.equal(await store.countSessionEvents("missing"), 0);
  });

  test("does not count another session's events", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 5);
    await seedSession(store, "session-2", 3);
    assert.equal(await store.countSessionEvents("session-1"), 5);
    assert.equal(await store.countSessionEvents("session-2"), 3);
  });
});

describe("getSessionEvents paging", () => {
  test("the newest page is returned first", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 10);

    const page = await store.getSessionEvents("session-1", { limit: 3 });
    assert.equal(page.length, 3);
    // Newest first: index 9, 8, 7.
    assert.equal(page[0]?.["timestamp"], "2026-01-01T00:00:09.000Z");
    assert.equal(page[2]?.["timestamp"], "2026-01-01T00:00:07.000Z");
  });

  test("skip walks backwards through the record without overlap", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 10);

    const first = await store.getSessionEvents("session-1", { limit: 4, skip: 0 });
    const second = await store.getSessionEvents("session-1", { limit: 4, skip: 4 });
    const third = await store.getSessionEvents("session-1", { limit: 4, skip: 8 });

    const timestamps = [...first, ...second, ...third].map((event) => event["timestamp"]);
    assert.equal(timestamps.length, 10);
    assert.equal(new Set(timestamps).size, 10, "pages must not overlap");
    assert.equal(timestamps[0], "2026-01-01T00:00:09.000Z");
    assert.equal(timestamps[9], "2026-01-01T00:00:00.000Z");
  });

  test("a negative skip is treated as the start", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 5);
    const page = await store.getSessionEvents("session-1", { limit: 2, skip: -10 });
    assert.equal(page.length, 2);
    assert.equal(page[0]?.["timestamp"], "2026-01-01T00:00:04.000Z");
  });
});

describe("get_session_review discloses truncation", () => {
  test("a session inside one page reports no truncation", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 10);

    const { status, body } = await review(store, { sessionId: "session-1" });

    assert.equal(status, 200);
    assert.equal(body["eventTotal"], 10);
    assert.equal(body["eventsReturned"], 10);
    assert.equal(body["eventsTruncated"], false);
    assert.equal(body["nextEventOffset"], null);
  });

  test("a session beyond one page reports the true total", async () => {
    // The defect this replaced: the response contained 5 events and nothing
    // saying 9 existed, so a partial timeline read as a complete one.
    const { store } = await makeStore();
    await seedSession(store, "session-1", 9);

    const { body } = await review(store, { sessionId: "session-1", eventLimit: 5 });

    assert.equal(body["eventTotal"], 9);
    assert.equal(body["eventsReturned"], 5);
    assert.equal(body["eventsTruncated"], true);
    assert.equal(body["nextEventOffset"], 5);
  });

  test("the default page size is bounded and disclosed", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", REVIEW_EVENT_LIMIT_DEFAULT + 25);

    const { body } = await review(store, { sessionId: "session-1" });

    assert.equal(body["eventsReturned"], REVIEW_EVENT_LIMIT_DEFAULT);
    assert.equal(body["eventTotal"], REVIEW_EVENT_LIMIT_DEFAULT + 25);
    assert.equal(body["eventsTruncated"], true);
    assert.equal(body["nextEventOffset"], REVIEW_EVENT_LIMIT_DEFAULT);
  });

  test("paging to the end reports no further continuation", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 9);

    const { body } = await review(store, {
      sessionId: "session-1",
      eventLimit: 5,
      eventOffset: 5,
    });

    assert.equal(body["eventsReturned"], 4);
    assert.equal(body["eventTotal"], 9);
    assert.equal(body["eventsTruncated"], false);
    assert.equal(body["nextEventOffset"], null);
  });

  test("the last page and the first page do not overlap", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 9);

    const first = await review(store, { sessionId: "session-1", eventLimit: 5 });
    const last = await review(store, { sessionId: "session-1", eventLimit: 5, eventOffset: 5 });

    const firstTimestamps = (first.body["events"] as Array<{ timestamp: string }>).map(
      (event) => event.timestamp,
    );
    const lastTimestamps = (last.body["events"] as Array<{ timestamp: string }>).map(
      (event) => event.timestamp,
    );

    assert.equal(new Set([...firstTimestamps, ...lastTimestamps]).size, 9);
  });

  test("an empty session reports a total of zero, not truncation", async () => {
    const { store } = await makeStore();
    await store.createSession({
      sessionId: "session-empty",
      candidateId: "candidate-1",
      assessmentId: "assessment-1",
    });

    const { body } = await review(store, { sessionId: "session-empty" });

    assert.equal(body["eventTotal"], 0);
    assert.equal(body["eventsReturned"], 0);
    assert.equal(body["eventsTruncated"], false);
    assert.equal(body["nextEventOffset"], null);
  });

  test("an unknown session still reports the paging fields", async () => {
    const { store } = await makeStore();
    const { body } = await review(store, { sessionId: "missing" });

    assert.equal(body["session"], null);
    assert.equal(body["eventTotal"], 0);
    assert.equal(body["eventsTruncated"], false);
  });
});

describe("get_session_review paging arguments are validated", () => {
  test("a limit above the maximum is refused", async () => {
    const { store } = await makeStore();
    const { status, body } = await review(store, {
      sessionId: "session-1",
      eventLimit: REVIEW_EVENT_LIMIT_MAX + 1,
    });
    assert.equal(status, 400);
    assert.match(String(body["error"]), /eventLimit/);
  });

  test("a zero or negative limit is refused", async () => {
    const { store } = await makeStore();
    for (const eventLimit of [0, -1]) {
      const { status } = await review(store, { sessionId: "session-1", eventLimit });
      assert.equal(status, 400, `expected 400 for eventLimit=${eventLimit}`);
    }
  });

  test("a non-integer limit is refused rather than silently defaulted", async () => {
    const { store } = await makeStore();
    for (const eventLimit of ["lots", 1.5, true, {}]) {
      const { status } = await review(store, { sessionId: "session-1", eventLimit });
      assert.equal(status, 400, `expected 400 for eventLimit=${JSON.stringify(eventLimit)}`);
    }
  });

  test("a negative offset is refused", async () => {
    const { store } = await makeStore();
    const { status, body } = await review(store, { sessionId: "session-1", eventOffset: -1 });
    assert.equal(status, 400);
    assert.match(String(body["error"]), /eventOffset/);
  });

  test("the maximum limit is accepted", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 3);
    const { status, body } = await review(store, {
      sessionId: "session-1",
      eventLimit: REVIEW_EVENT_LIMIT_MAX,
    });
    assert.equal(status, 200);
    assert.equal(body["eventsReturned"], 3);
  });

  test("an offset past the end returns an empty page and no continuation", async () => {
    const { store } = await makeStore();
    await seedSession(store, "session-1", 4);

    const { status, body } = await review(store, { sessionId: "session-1", eventOffset: 100 });

    assert.equal(status, 200);
    assert.equal(body["eventsReturned"], 0);
    assert.equal(body["eventTotal"], 4);
    assert.equal(body["eventsTruncated"], false);
  });
});

describe("the advertised schema documents paging", () => {
  test("get_session_review advertises the paging parameters", async () => {
    const { TOOL_DEFINITIONS_BY_NAME } = await import("@assessment/mcp-mongodb");
    const definition = TOOL_DEFINITIONS_BY_NAME[MCP_TOOLS.GET_SESSION_REVIEW];

    assert.ok(definition, "get_session_review must be advertised");
    const properties = definition.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties["eventLimit"], "eventLimit must be advertised");
    assert.ok(properties["eventOffset"], "eventOffset must be advertised");
    assert.match(String(definition.description), /eventTotal/);
  });
});
