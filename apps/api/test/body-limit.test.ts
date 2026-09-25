/**
 * Request-body ceiling tests.
 *
 * Nothing bounded a request body before this, and `POST /api/v1/identity/set` is
 * unauthenticated by design, so any caller on the network could make the process
 * buffer an arbitrarily large body. These tests pin the per-route ceilings and
 * the batch free-text budget, including the exact boundary either side.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp, GENERATE_BODY_BYTES, IDENTITY_BODY_BYTES, MAX_API_BODY_BYTES } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import { MAX_BATCH_TEXT_LENGTH, MAX_EVENTS_PER_BATCH } from "../src/telemetry.js";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  testConfig,
  telemetryEvent,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

function makeApp() {
  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session: null,
      events: [],
      integrityReports: [],
    }))
    .respond(MCP_TOOLS.CREATE_SESSION, () => ({ success: true, mongoDocumentId: "doc-1" }))
    .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }));

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

async function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: string,
  token?: string,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

/** A JSON body of a known byte size, padded in an ignored field. */
function paddedBody(byteSize: number): string {
  const skeleton = JSON.stringify({ candidateId: "c", displayName: "d", pad: "" });
  const overhead = Buffer.byteLength(skeleton, "utf8");
  const pad = "x".repeat(Math.max(0, byteSize - overhead));
  return JSON.stringify({ candidateId: "c", displayName: "d", pad });
}

describe("the unauthenticated identity route is body-bounded", () => {
  test("a normal registration body is accepted", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/identity/set",
      JSON.stringify({ displayName: "Ada", candidateId: "c-1" }),
    );
    // 403 because no capability was presented — but not 413, which is the point.
    assert.equal(response.status, 403);
  });

  test("a body one byte under the ceiling is not rejected as too large", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", paddedBody(IDENTITY_BODY_BYTES - 1));
    assert.notEqual(response.status, 413);
  });

  test("a body over the ceiling is refused with 413 before parsing", async () => {
    const { app, mcp } = makeApp();
    const response = await post(app, "/api/v1/identity/set", paddedBody(IDENTITY_BODY_BYTES + 1));

    assert.equal(response.status, 413);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["success"], false);
    assert.match(String(body["error"]), /limit of \d+ bytes/);
    assert.equal(mcp.calls.length, 0, "an oversized body must not reach any collaborator");
  });

  test("a grossly oversized body is refused without being buffered whole", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", paddedBody(2 * 1024 * 1024));
    assert.equal(response.status, 413);
  });

  test("the identity ceiling also covers capability issuance", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/identity/capability",
      paddedBody(IDENTITY_BODY_BYTES + 1),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 413);
  });
});

describe("the generation route is body-bounded", () => {
  test("a normal generation body is not rejected as too large", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/generate",
      JSON.stringify({ prompt: "Generate a backend assessment", roleContext: "backend" }),
      TEST_API_TOKEN,
    );
    assert.notEqual(response.status, 413);
  });

  test("a body over the ceiling is refused with 413", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/generate",
      paddedBody(GENERATE_BODY_BYTES + 1),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 413);
  });

  test("the generation ceiling is larger than the identity ceiling", () => {
    // A generation prompt is legitimately longer than a registration payload,
    // which is why the ceilings are per-route rather than one global value.
    assert.ok(GENERATE_BODY_BYTES > IDENTITY_BODY_BYTES);
  });
});

describe("the ingestion route has the largest ceiling", () => {
  test("the backstop ceiling cannot silently tighten the ingest ceiling", () => {
    // Hono runs every matching middleware, so a smaller `/api/*` backstop would
    // clamp the ingest route to its own limit.
    assert.ok(MAX_API_BODY_BYTES >= GENERATE_BODY_BYTES);
    assert.ok(MAX_API_BODY_BYTES >= IDENTITY_BODY_BYTES);
  });

  test("an ordinary telemetry batch is accepted", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({ events: [telemetryEvent({ eventType: "TAB_SWITCH" })] }),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 200);
  });

  test("a body over the ingest ceiling is refused with 413", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      paddedBody(MAX_API_BODY_BYTES + 1),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 413);
  });
});

describe("batch free-text budget", () => {
  test("a batch under the budget is accepted", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: [
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: { pasteContent: "x".repeat(MAX_BATCH_TEXT_LENGTH - 1) },
          }),
        ],
      }),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 200);
  });

  test("a batch over the budget is refused with a clear 400", async () => {
    const { app, mcp } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: [
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: { pasteContent: "x".repeat(MAX_BATCH_TEXT_LENGTH + 1) },
          }),
        ],
      }),
      TEST_API_TOKEN,
    );

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; eventIndex: number };
    assert.match(body.error, /Free text across one batch/);
    assert.equal(body.eventIndex, 0);
    assert.equal(
      mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS).length,
      0,
      "an over-budget batch must not reach storage",
    );
  });

  test("the budget counts every free-text field, not just pastes", async () => {
    const { app } = makeApp();
    const each = Math.ceil(MAX_BATCH_TEXT_LENGTH / 3) + 1;

    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: [
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: {
              pasteContent: "x".repeat(each),
              selectedText: "y".repeat(each),
              diffPatch: "z".repeat(each),
            },
          }),
        ],
      }),
      TEST_API_TOKEN,
    );

    assert.equal(response.status, 400);
    assert.match(String(((await response.json()) as { error: string }).error), /Free text across one batch/);
  });

  test("the budget accumulates across events in one batch", async () => {
    const { app } = makeApp();
    const perEvent = Math.floor(MAX_BATCH_TEXT_LENGTH / 4) + 1;

    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: Array.from({ length: 4 }, () =>
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: { pasteContent: "x".repeat(perEvent) },
          }),
        ),
      }),
      TEST_API_TOKEN,
    );

    assert.equal(response.status, 400);
    assert.match(String(((await response.json()) as { error: string }).error), /Free text across one batch/);
  });

  test("a batch of many small events stays inside the budget", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: Array.from({ length: MAX_EVENTS_PER_BATCH }, (_, index) =>
          telemetryEvent({
            eventType: "KEYSTROKE",
            payload: { char: "a", deltaMs: 100 + index },
            timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
          }),
        ),
      }),
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 200);
  });

  test("a non-string free-text field is not counted", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/integrity/ingest",
      JSON.stringify({
        events: [
          telemetryEvent({
            eventType: "PASTE_TRIGGER",
            payload: { pasteContent: { not: "a string" } },
          }),
        ],
      }),
      TEST_API_TOKEN,
    );
    // The field is dropped by normalisation; the batch is still valid.
    assert.equal(response.status, 200);
  });
});

describe("body ceilings do not weaken other guarantees", () => {
  test("an oversized body is refused before authentication is even consulted", async () => {
    const { app } = makeApp();
    const anonymous = await post(app, "/api/v1/generate", paddedBody(GENERATE_BODY_BYTES + 1));
    assert.equal(anonymous.status, 413, "the ceiling applies before the auth decision");
  });

  test("a malformed body under the ceiling still reports a parse error", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", "{ not json");
    assert.equal(response.status, 400);
  });

  test("an empty body under the ceiling still reports a validation error", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", "");
    assert.equal(response.status, 400);
  });

  test("the 413 shape matches every other API error", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", paddedBody(IDENTITY_BODY_BYTES + 1));
    const body = (await response.json()) as Record<string, unknown>;

    assert.deepEqual(Object.keys(body).sort(), ["correlationId", "error", "success"]);
    assert.equal(typeof body["correlationId"], "string");
  });
});
