/**
 * MCP HTTP transport tests.
 *
 * The tool surface is a datastore administration surface, so these tests prove
 * the transport refuses to run unprotected in production, rejects unauthenticated
 * tool calls, and dispatches through the same handler table as the stdio server.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTIONS,
  MAX_MCP_BODY_BYTES,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
  MongoStore,
  createMcpHttpServer,
  type DbLike,
  type McpHttpServer,
} from "@assessment/mcp-mongodb";

import { createFakeDb } from "./fake-db.js";

async function makeStore(db: DbLike): Promise<MongoStore> {
  const store = new MongoStore({
    uri: "mongodb://127.0.0.1:27017",
    databaseName: "assessment_http_test",
    connect: async () => ({ handle: db, close: async () => undefined }),
  });
  await store.connect();
  return store;
}

describe("production guard", () => {
  test("refuses to start unprotected in production", async () => {
    const store = await makeStore(createFakeDb().db);
    assert.throws(
      () =>
        createMcpHttpServer({
          store,
          port: 0,
          environment: "production",
          authToken: "",
        }),
      /MCP_AUTH_TOKEN must be set/,
    );
  });

  test("starts in production when a token is configured", async () => {
    const store = await makeStore(createFakeDb().db);
    const server = createMcpHttpServer({
      store,
      port: 0,
      environment: "production",
      authToken: "a-strong-token-value",
    });
    assert.equal(server.tools.length > 0, true);
  });
});

describe("authenticated tool dispatch over HTTP", () => {
  let server: McpHttpServer;
  let port: number;
  let db: ReturnType<typeof createFakeDb>;

  const TOKEN = "test-mcp-token-0123456789";

  before(async () => {
    db = createFakeDb();
    const store = await makeStore(db.db);
    server = createMcpHttpServer({
      store,
      port: 0,
      environment: "test",
      authToken: TOKEN,
      corsOrigins: ["http://localhost:8080"],
    });
    port = await server.listen();
  });

  after(async () => {
    await server.close();
  });

  async function callTool(
    tool: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${port}/tools/${tool}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  test("health is reachable without a credential", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { status: string; toolCount: number };
    assert.equal(body.status, "healthy");
    assert.equal(body.toolCount, server.tools.length);
  });

  test("tool listing requires the token", async () => {
    const unauthorised = await fetch(`http://127.0.0.1:${port}/tools`);
    assert.equal(unauthorised.status, 401);

    const authorised = await fetch(`http://127.0.0.1:${port}/tools`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(authorised.status, 200);
    const body = (await authorised.json()) as { tools: string[] };
    assert.deepEqual([...body.tools].sort(), [...server.tools].sort());
  });

  test("tool invocation requires the token", async () => {
    const result = await callTool(MCP_TOOLS.LIST_SESSIONS, {});
    assert.equal(result.status, 401);
  });

  test("a wrong token is rejected", async () => {
    const result = await callTool(MCP_TOOLS.LIST_SESSIONS, {}, "not-the-token");
    assert.equal(result.status, 401);
  });

  test("an unknown tool reports the available tools", async () => {
    const result = await callTool("no_such_tool", {}, TOKEN);
    assert.equal(result.status, 404);
    assert.match(String(result.body["error"]), /Unknown tool/);
    assert.ok(Array.isArray(result.body["availableTools"]));
  });

  test("a tool name that collides with Object.prototype is not a tool", async () => {
    // `constructor`, `toString` and friends are inherited properties of the
    // handler table, so a prototype-chain lookup treated them as real handlers
    // and answered 200 with a fabricated payload.
    for (const name of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
      "isPrototypeOf",
    ]) {
      const result = await callTool(name, {}, TOKEN);
      assert.equal(result.status, 404, `expected 404 for '${name}', got ${result.status}`);
      assert.match(String(result.body["error"]), /Unknown tool/);
    }
  });

  test("the advertised tool list contains only declared tools", async () => {
    const listed = await fetch(`http://127.0.0.1:${port}/tools`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = (await listed.json()) as { tools: string[] };

    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      assert.equal(body.tools.includes(name), false, `'${name}' must not be advertised`);
    }
    assert.deepEqual([...body.tools].sort(), [...MCP_TOOL_NAMES].sort());
  });

  test("a malformed argument is a client error, not a server error", async () => {
    const result = await callTool(MCP_TOOLS.GET_TEST_SUITE, {}, TOKEN);
    assert.equal(result.status, 400);
    assert.match(String(result.body["error"]), /suiteId/);
  });

  test("an oversized body is refused with 413 rather than buffered", async () => {
    // readJsonBody used to concatenate every chunk the socket produced, so a
    // caller could make the transport buffer an arbitrarily large body.
    const response = await fetch(`http://127.0.0.1:${port}/tools/${MCP_TOOLS.LIST_SESSIONS}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ pad: "x".repeat(MAX_MCP_BODY_BYTES + 1024) }),
    });

    assert.equal(response.status, 413);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["success"], false);
    assert.match(String(body["error"]), /limit of \d+ bytes/);
  });

  test("an oversized body is refused even without a credential", async () => {
    // The ceiling must not depend on the caller having authenticated first.
    const response = await fetch(`http://127.0.0.1:${port}/tools/${MCP_TOOLS.LIST_SESSIONS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(MAX_MCP_BODY_BYTES + 1024) }),
    });
    assert.notEqual(response.status, 200);
  });

  test("a normal body is unaffected by the ceiling", async () => {
    const result = await callTool(MCP_TOOLS.LIST_SESSIONS, {}, TOKEN);
    assert.equal(result.status, 200);
  });

  test("a session round-trips through the HTTP transport", async () => {
    const created = await callTool(
      MCP_TOOLS.CREATE_SESSION,
      { sessionId: "http-session", candidateId: "http-candidate", assessmentId: "http-assessment" },
      TOKEN,
    );
    assert.equal(created.status, 200);
    assert.equal(created.body["success"], true);

    await callTool(
      MCP_TOOLS.INGEST_MICRO_EVENTS,
      {
        events: [
          {
            sessionId: "http-session",
            eventType: "PASTE_TRIGGER",
            timestamp: "2026-01-01T00:00:00.000Z",
            payload: { pasteContent: "abc" },
          },
        ],
      },
      TOKEN,
    );
    await callTool(
      MCP_TOOLS.STORE_INTEGRITY_REPORT,
      {
        report: {
          sessionId: "http-session",
          candidateId: "http-candidate",
          overallScore: 42,
          generatedAt: "2026-01-01T00:05:00.000Z",
        },
      },
      TOKEN,
    );

    const review = await callTool(MCP_TOOLS.GET_SESSION_REVIEW, { sessionId: "http-session" }, TOKEN);
    assert.equal(review.status, 200);
    const session = review.body["session"] as { candidateId: string };
    assert.equal(session.candidateId, "http-candidate");
    assert.equal((review.body["events"] as unknown[]).length, 1);
    assert.equal((review.body["integrityReports"] as unknown[]).length, 1);
  });

  test("deleting a session removes dependent records", async () => {
    const deleted = await callTool(MCP_TOOLS.DELETE_SESSION, { sessionId: "http-session" }, TOKEN);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body["deleted"], true);

    assert.equal(db.docs(COLLECTIONS.sessions).length, 0);
    assert.equal(db.docs(COLLECTIONS.microEvents).length, 0);
    assert.equal(db.docs(COLLECTIONS.integrityReports).length, 0);
  });

  test("CORS is an allow-list, never a wildcard", async () => {
    const allowed = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "http://localhost:8080" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:8080");

    const disallowed = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(disallowed.headers.get("access-control-allow-origin"), null);
  });
});
