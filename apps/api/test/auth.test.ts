/**
 * Authentication boundary tests.
 *
 * Proves that every sensitive operation rejects anonymous callers, that a
 * candidate credential is confined to its own candidate, and that the operator
 * credential is required for reviewer surfaces.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { issueCandidateToken } from "../src/middleware/tokens.js";
import { SessionRegistry } from "../src/integrity-session.js";
import { StubAiClient, StubMcpClient, TEST_API_TOKEN, TEST_SESSION_SECRET, testConfig, telemetryEvent } from "./helpers.js";

function makeApp() {
  const ai = new StubAiClient();
  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session: {
        sessionId: "session-1",
        candidateId: "candidate-1",
        assessmentId: "assessment-1",
        status: "in_progress",
      },
      events: [],
      integrityReports: [],
    }))
    .respond(MCP_TOOLS.LIST_SESSIONS, () => ({ success: true, data: [] }))
    .respond(MCP_TOOLS.CREATE_SESSION, () => ({ success: true, mongoDocumentId: "doc-1" }))
    .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }))
    .respond(MCP_TOOLS.DELETE_SESSION, () => ({ success: true, deleted: true }));

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

function candidateToken(candidateId = "candidate-1"): string {
  return issueCandidateToken({
    secret: TEST_SESSION_SECRET,
    candidateId,
    displayName: "Test Candidate",
    ttlSeconds: 600,
  }).token;
}

async function postJson(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("unauthenticated access is refused", () => {
  test("health is public", async () => {
    const { app } = makeApp();
    const response = await app.request("/health");
    assert.equal(response.status, 200);
  });

  test("assessment generation requires a credential", async () => {
    const { app, ai } = makeApp();
    const response = await postJson(app, "/api/v1/generate", {
      prompt: "Generate a backend coding assessment",
      roleContext: "backend",
      problemCount: 2,
    });
    assert.equal(response.status, 401);
    assert.equal(ai.calls.length, 0, "the paid provider must not be reached without a credential");
  });

  test("session listing requires a credential", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/sessions");
    assert.equal(response.status, 401);
  });

  test("session review requires a credential", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/sessions/session-1/review");
    assert.equal(response.status, 401);
  });

  test("candidate report requires a credential", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/candidates/candidate-1/reports");
    assert.equal(response.status, 401);
  });

  test("telemetry ingestion requires a credential", async () => {
    const { app } = makeApp();
    const response = await postJson(app, "/api/v1/integrity/ingest", {
      events: [telemetryEvent()],
    });
    assert.equal(response.status, 401);
  });

  test("session termination requires a credential", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/integrity/sessions/session-1", { method: "DELETE" });
    assert.equal(response.status, 401);
  });

  test("a forged bearer token is rejected", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/sessions", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.equal(response.status, 401);
  });
});

describe("operator credential", () => {
  test("can generate an assessment and reach the provider", async () => {
    const { app, ai, mcp } = makeApp();
    const response = await postJson(
      app,
      "/api/v1/generate",
      { prompt: "Generate a backend coding assessment", roleContext: "backend", problemCount: 2 },
      TEST_API_TOKEN,
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["success"], true);
    assert.deepEqual(ai.calls, ["classifyAssessmentIntent", "generateTestSuite"]);
    assert.equal(mcp.callsFor(MCP_TOOLS.STORE_TEST_SUITE).length, 1);

    const suite = body["suite"] as { metadata: { promptFingerprint: string } };
    assert.match(
      suite.metadata.promptFingerprint,
      /^[0-9a-f]{64}$/,
      "the suite must carry a SHA-256 fingerprint of the originating prompt",
    );
  });

  test("can read reviewer surfaces", async () => {
    const { app } = makeApp();
    const list = await app.request("/api/v1/sessions", {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    assert.equal(list.status, 200);

    const review = await app.request("/api/v1/sessions/session-1/review", {
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    assert.equal(review.status, 200);
  });

  test("can terminate a session", async () => {
    const { app, mcp } = makeApp();
    const response = await app.request("/api/v1/integrity/sessions/session-1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_API_TOKEN}` },
    });
    assert.equal(response.status, 200);
    assert.equal(mcp.callsFor(MCP_TOOLS.DELETE_SESSION).length, 1);
  });
});

describe("candidate credential is confined to its own assessment data", () => {
  test("cannot generate an assessment", async () => {
    const { app, ai } = makeApp();
    const response = await postJson(
      app,
      "/api/v1/generate",
      { prompt: "Generate a backend coding assessment", roleContext: "backend" },
      candidateToken(),
    );
    assert.equal(response.status, 403);
    assert.equal(ai.calls.length, 0);
  });

  test("cannot read the reviewer session list", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/sessions", {
      headers: { Authorization: `Bearer ${candidateToken()}` },
    });
    assert.equal(response.status, 403);
  });

  test("cannot read another candidate's session review", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/sessions/session-1/review", {
      headers: { Authorization: `Bearer ${candidateToken("another-candidate")}` },
    });
    assert.equal(response.status, 403);
  });

  test("cannot terminate a session", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/integrity/sessions/session-1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${candidateToken()}` },
    });
    assert.equal(response.status, 403);
  });

  test("can ingest telemetry for itself", async () => {
    const { app, mcp } = makeApp();
    const response = await postJson(
      app,
      "/api/v1/integrity/ingest",
      { events: [telemetryEvent({ candidateId: "candidate-1" })] },
      candidateToken("candidate-1"),
    );
    assert.equal(response.status, 200);
    assert.equal(mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS).length, 1);
  });

  test("cannot ingest telemetry attributed to another candidate", async () => {
    const { app, mcp } = makeApp();
    const response = await postJson(
      app,
      "/api/v1/integrity/ingest",
      { events: [telemetryEvent({ candidateId: "candidate-2" })] },
      candidateToken("candidate-1"),
    );
    assert.equal(response.status, 403);
    assert.equal(mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS).length, 0);
  });

  test("identity resolution reports the caller", async () => {
    const { app } = makeApp();
    const response = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${candidateToken("candidate-7")}` },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { identity: { candidateId: string } };
    assert.equal(body.identity.candidateId, "candidate-7");
  });
});

describe("candidate session tokens", () => {
  test("a tampered payload fails signature verification", async () => {
    const { app } = makeApp();
    const token = candidateToken("candidate-1");
    const [version, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ kind: "candidate", candidateId: "candidate-9", expiresAt: Date.now() + 60_000 }),
    ).toString("base64url");

    const response = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${version}.${forgedPayload}.${signature}` },
    });
    assert.equal(response.status, 401);
  });

  test("an expired token is refused", async () => {
    const expired = issueCandidateToken({
      secret: TEST_SESSION_SECRET,
      candidateId: "candidate-1",
      displayName: "Test Candidate",
      ttlSeconds: -10,
    }).token;

    const { app } = makeApp();
    const response = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${expired}` },
    });
    assert.equal(response.status, 401);
  });

  test("a token signed with a different secret is refused", async () => {
    const foreign = issueCandidateToken({
      secret: "a-completely-different-secret-value-01",
      candidateId: "candidate-1",
      displayName: "Test Candidate",
      ttlSeconds: 600,
    }).token;

    const { app } = makeApp();
    const response = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${foreign}` },
    });
    assert.equal(response.status, 401);
  });

  test("registration mints a usable token", async () => {
    const { app } = makeApp();
    const registered = await postJson(app, "/api/v1/identity/set", {
      displayName: "Ada Lovelace",
      candidateId: "candidate-42",
    });
    assert.equal(registered.status, 201);

    const body = (await registered.json()) as { sessionToken: string; expiresAt: string };
    assert.ok(body.sessionToken.split(".").length === 3);
    assert.ok(new Date(body.expiresAt).getTime() > Date.now());

    const me = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${body.sessionToken}` },
    });
    assert.equal(me.status, 200);
    const identity = (await me.json()) as { identity: { candidateId: string; displayName: string } };
    assert.equal(identity.identity.candidateId, "candidate-42");
    assert.equal(identity.identity.displayName, "Ada Lovelace");
  });

  test("registration rejects incomplete payloads", async () => {
    const { app } = makeApp();
    const missingName = await postJson(app, "/api/v1/identity/set", { candidateId: "c-1" });
    assert.equal(missingName.status, 400);

    const missingId = await postJson(app, "/api/v1/identity/set", { displayName: "Ada" });
    assert.equal(missingId.status, 400);
  });

  test("registration fails closed when no session secret is configured", async () => {
    const app = buildApp({
      config: testConfig({ auth: { apiToken: TEST_API_TOKEN, sessionSecret: "", candidateTokenTtlSeconds: 600 } }),
      ai: new StubAiClient(),
      mcp: new StubMcpClient(),
      log: () => undefined,
      requestLogging: false,
    });

    const response = await postJson(app, "/api/v1/identity/set", {
      displayName: "Ada Lovelace",
      candidateId: "candidate-42",
    });
    assert.equal(response.status, 503);
  });
});
