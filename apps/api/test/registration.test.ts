/**
 * Candidate registration authorization tests.
 *
 * Regression coverage for the defect this replaced: `POST /api/v1/identity/set`
 * accepted any `candidateId` from any caller, so a caller who knew a candidate
 * id could obtain a token for that candidate — including an **existing** one —
 * and read that candidate's own submitted code and integrity report history.
 *
 * Every case below is driven through the real Hono app with stub collaborators.
 * The capability's clock is injected; nothing sleeps.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import { issueRegistrationCapability } from "../src/middleware/registration-capability.js";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  TEST_SESSION_SECRET,
  testConfig,
  telemetryEvent,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

function makeApp(
  options: {
    registrationMode?: "capability" | "open";
    existingSession?: boolean;
    capabilityTtlSeconds?: number;
  } = {},
) {
  const ai = new StubAiClient();
  const mcp = new StubMcpClient()
    .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session: options.existingSession
        ? {
            sessionId: "session-1",
            candidateId: "victim",
            assessmentId: "assessment-1",
            status: "submitted",
            submittedCode: "// victim's private solution",
          }
        : null,
      events: [],
      integrityReports: [],
    }))
    .respond(MCP_TOOLS.CREATE_SESSION, () => ({ success: true, mongoDocumentId: "doc-1" }))
    .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }))
    .respond(MCP_TOOLS.DELETE_SESSION, () => ({ success: true, deleted: true }));

  const app = buildApp({
    config: testConfig({
      auth: {
        apiToken: TEST_API_TOKEN,
        sessionSecret: TEST_SESSION_SECRET,
        candidateTokenTtlSeconds: 3600,
        registrationMode: options.registrationMode ?? "capability",
        registrationCapabilityTtlSeconds: options.capabilityTtlSeconds ?? 900,
      },
    }),
    ai,
    mcp,
    sessions: new SessionRegistry(),
    log: () => undefined,
    requestLogging: false,
  });

  return { app, mcp, ai };
}

async function post(
  app: ReturnType<typeof buildApp>,
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

/** Mints a capability through the real operator endpoint. */
async function mint(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
): Promise<{ status: number; capability: string; capabilityId: string; expiresAt: string }> {
  const response = await post(app, "/api/v1/identity/capability", body, TEST_API_TOKEN);
  const parsed = (await response.json()) as {
    capability: string;
    capabilityId: string;
    expiresAt: string;
  };
  return { status: response.status, ...parsed };
}

/** A capability minted directly, for expiry tests that need a past clock. */
function expiredCapability(candidateId: string): string {
  return issueRegistrationCapability({
    sessionSecret: TEST_SESSION_SECRET,
    candidateId,
    ttlSeconds: 900,
    now: Date.now() - 3_600_000,
  }).capability;
}

describe("registration capability issuance", () => {
  test("an operator can mint a capability", async () => {
    const { app } = makeApp();
    const response = await post(
      app,
      "/api/v1/identity/capability",
      { candidateId: "candidate-1" },
      TEST_API_TOKEN,
    );

    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(typeof body["capability"], "string");
    assert.equal(body["candidateId"], "candidate-1");
    assert.equal(body["assessmentId"], null);
    assert.ok(new Date(String(body["expiresAt"])).getTime() > Date.now());
  });

  test("an operator can bind a capability to an assessment", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1", assessmentId: "assessment-9" });
    assert.equal(issued.status, 201);
  });

  test("an anonymous caller cannot mint a capability", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/capability", { candidateId: "candidate-1" });
    assert.equal(response.status, 401);
  });

  test("a candidate token cannot mint a capability", async () => {
    const { app } = makeApp();
    const registered = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: (await mint(app, { candidateId: "candidate-1" })).capability,
    });
    const { sessionToken } = (await registered.json()) as { sessionToken: string };

    const response = await post(
      app,
      "/api/v1/identity/capability",
      { candidateId: "candidate-2" },
      sessionToken,
    );
    assert.equal(response.status, 403);
  });

  test("issuance rejects a missing or over-long candidate id", async () => {
    const { app } = makeApp();
    assert.equal((await post(app, "/api/v1/identity/capability", {}, TEST_API_TOKEN)).status, 400);
    assert.equal(
      (await post(app, "/api/v1/identity/capability", { candidateId: "x".repeat(201) }, TEST_API_TOKEN)).status,
      400,
    );
  });

  test("issuance refuses a lifetime outside the accepted range", async () => {
    const { app } = makeApp();
    assert.equal(
      (await post(app, "/api/v1/identity/capability", { candidateId: "c-1", ttlSeconds: 1 }, TEST_API_TOKEN)).status,
      400,
    );
    assert.equal(
      (
        await post(
          app,
          "/api/v1/identity/capability",
          { candidateId: "c-1", ttlSeconds: 7 * 24 * 3600 },
          TEST_API_TOKEN,
        )
      ).status,
      400,
    );
  });
});

describe("registration requires a capability", () => {
  test("an unknown candidateId without a capability is refused", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "brand-new-candidate",
    });
    assert.equal(response.status, 403);
  });

  test("an existing candidateId without a capability is refused", async () => {
    // The defect this replaced: this returned 201 and handed out a token for an
    // existing candidate's identity.
    const { app } = makeApp({ existingSession: true });
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Not the victim",
      candidateId: "victim",
    });

    assert.equal(response.status, 403);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body["sessionToken"], undefined, "no token may be minted");
  });

  test("candidateId alone can no longer mint a token for an existing candidate", async () => {
    const { app, mcp } = makeApp({ existingSession: true });

    // Sweep the plausible unauthenticated shapes.
    for (const body of [
      { displayName: "X", candidateId: "victim" },
      { displayName: "X", candidateId: "victim", registrationCapability: "" },
      { displayName: "X", candidateId: "victim", registrationCapability: "  " },
      { displayName: "X", candidateId: "victim", registrationCapability: "rv1.bogus.bogus" },
      { displayName: "X", candidateId: "victim", assessmentId: "assessment-1" },
    ]) {
      const response = await post(app, "/api/v1/identity/set", body);
      assert.equal(response.status, 403, `expected refusal for ${JSON.stringify(body)}`);
    }

    assert.equal(mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS).length, 0);
  });

  test("the refusal does not reveal whether the candidate id exists", async () => {
    const known = makeApp({ existingSession: true });
    const unknown = makeApp({ existingSession: false });

    const knownResponse = await post(known.app, "/api/v1/identity/set", {
      displayName: "X",
      candidateId: "victim",
    });
    const unknownResponse = await post(unknown.app, "/api/v1/identity/set", {
      displayName: "X",
      candidateId: "nobody",
    });

    assert.equal(knownResponse.status, unknownResponse.status);
    assert.deepEqual(await knownResponse.json(), await unknownResponse.json());
  });

  test("a capability for another candidate is refused", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1" });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-2",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 403);
  });

  test("a capability for another assessment is refused", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1", assessmentId: "assessment-A" });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      assessmentId: "assessment-B",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 403);
  });

  test("an assessment-bound capability is refused when no assessment is presented", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1", assessmentId: "assessment-A" });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 403);
  });

  test("an expired capability is refused", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: expiredCapability("candidate-1"),
    });
    assert.equal(response.status, 403);
  });

  test("a malformed capability is refused", async () => {
    const { app } = makeApp();
    for (const capability of ["not-a-token", "rv1.a.b", "a.b.c", "rv1.."]) {
      const response = await post(app, "/api/v1/identity/set", {
        displayName: "Ada",
        candidateId: "candidate-1",
        registrationCapability: capability,
      });
      assert.equal(response.status, 403, `expected refusal for ${capability}`);
    }
  });

  test("an oversized capability is refused without signature work", async () => {
    const { app } = makeApp();
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: "r".repeat(5000),
    });
    assert.equal(response.status, 403);
  });

  test("a non-string capability is refused", async () => {
    const { app } = makeApp();
    for (const capability of [123, {}, [], true, null]) {
      const response = await post(app, "/api/v1/identity/set", {
        displayName: "Ada",
        candidateId: "candidate-1",
        registrationCapability: capability,
      });
      assert.equal(response.status, 403);
    }
  });

  test("a capability signed with another secret is refused", async () => {
    const { app } = makeApp();
    const foreign = issueRegistrationCapability({
      sessionSecret: "a-different-session-secret-0123456789",
      candidateId: "candidate-1",
      ttlSeconds: 900,
    }).capability;

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: foreign,
    });
    assert.equal(response.status, 403);
  });

  test("validation still runs before the capability check", async () => {
    // A malformed request is a 400 whether or not a capability is present, so a
    // caller is not told "403" for a body the server never parsed.
    const { app } = makeApp();
    assert.equal((await post(app, "/api/v1/identity/set", { candidateId: "c-1" })).status, 400);
    assert.equal((await post(app, "/api/v1/identity/set", { displayName: "Ada" })).status, 400);
  });
});

describe("registration with a valid capability", () => {
  test("a valid capability issues a usable candidate token", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-42" });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada Lovelace",
      candidateId: "candidate-42",
      registrationCapability: issued.capability,
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as { sessionToken: string; expiresAt: string };
    assert.equal(body.sessionToken.split(".").length, 3);

    const me = await app.request("/api/v1/identity/me", {
      headers: { Authorization: `Bearer ${body.sessionToken}` },
    });
    assert.equal(me.status, 200);
    const identity = (await me.json()) as { identity: { candidateId: string } };
    assert.equal(identity.identity.candidateId, "candidate-42");
  });

  test("an assessment-bound capability issues a token when the assessment matches", async () => {
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1", assessmentId: "assessment-9" });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      assessmentId: "assessment-9",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 201);
  });

  test("the issued token reaches only that candidate's own data", async () => {
    const { app } = makeApp({ existingSession: true });
    const issued = await mint(app, { candidateId: "victim" });

    const registered = await post(app, "/api/v1/identity/set", {
      displayName: "The real candidate",
      candidateId: "victim",
      registrationCapability: issued.capability,
    });
    const { sessionToken } = (await registered.json()) as { sessionToken: string };

    // Its own session: allowed.
    const own = await app.request("/api/v1/sessions/session-1/review", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(own.status, 200);

    // The cohort list is operator-only.
    const cohort = await app.request("/api/v1/sessions", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(cohort.status, 403);
  });

  test("a capability holder still cannot reach another candidate", async () => {
    const { app } = makeApp({ existingSession: true });
    const issued = await mint(app, { candidateId: "someone-else" });

    const registered = await post(app, "/api/v1/identity/set", {
      displayName: "Someone Else",
      candidateId: "someone-else",
      registrationCapability: issued.capability,
    });
    const { sessionToken } = (await registered.json()) as { sessionToken: string };

    // session-1 belongs to "victim" in this harness.
    const foreign = await app.request("/api/v1/sessions/session-1/review", {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(foreign.status, 403);

    const foreignIngest = await post(
      app,
      "/api/v1/integrity/ingest",
      { events: [telemetryEvent({ sessionId: "session-1", candidateId: "someone-else" })] },
      sessionToken,
    );
    assert.equal(foreignIngest.status, 403);
  });

  test("a capability is reusable within its lifetime", async () => {
    // Documented behaviour: the capability is stateless, so it is NOT one-time.
    // A short TTL is what bounds the window.
    const { app } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1" });

    const first = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });
    const second = await post(app, "/api/v1/identity/set", {
      displayName: "Ada again",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201, "the capability is TTL-bounded, not one-time");
  });

  test("the operator credential is unchanged and still required for operator routes", async () => {
    const { app } = makeApp();
    assert.equal((await app.request("/api/v1/sessions")).status, 401);
    assert.equal((await app.request("/api/v1/sessions", { headers: OPERATOR })).status, 200);
  });
});

describe("development open-registration mode", () => {
  test("open mode registers without a capability", async () => {
    const { app } = makeApp({ registrationMode: "open" });
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
    });
    assert.equal(response.status, 201);
  });

  test("open mode still validates its input", async () => {
    const { app } = makeApp({ registrationMode: "open" });
    assert.equal((await post(app, "/api/v1/identity/set", { candidateId: "c-1" })).status, 400);
  });

  test("a capability is still accepted in open mode", async () => {
    const { app } = makeApp({ registrationMode: "open" });
    const issued = await mint(app, { candidateId: "candidate-1" });
    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 201);
  });
});

describe("registration capability persistence across restarts", () => {
  test("a capability minted by one process is accepted by a fresh one", async () => {
    // Capabilities are signed, not stored, so a restart that keeps the same
    // session secret must not invalidate an outstanding capability — and
    // registration must not depend on the datastore being reachable.
    const first = makeApp();
    const issued = await mint(first.app, { candidateId: "candidate-1" });

    // A separate application instance, sharing only the configured secret.
    const second = makeApp();
    const response = await post(second.app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });

    assert.equal(response.status, 201);
  });

  test("rotating the session secret invalidates outstanding capabilities", async () => {
    // The documented operational lever: rotating the secret is how every
    // outstanding capability is revoked at once.
    const first = makeApp();
    const issued = await mint(first.app, { candidateId: "candidate-1" });

    const rotated = buildApp({
      config: testConfig({
        auth: {
          apiToken: TEST_API_TOKEN,
          sessionSecret: "a-rotated-session-secret-0123456789abcdef",
          candidateTokenTtlSeconds: 3600,
          registrationMode: "capability",
          registrationCapabilityTtlSeconds: 900,
        },
      }),
      ai: new StubAiClient(),
      mcp: new StubMcpClient(),
      sessions: new SessionRegistry(),
      log: () => undefined,
      requestLogging: false,
    });

    const response = await post(rotated, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });
    assert.equal(response.status, 403);
  });

  test("registration does not touch the datastore", async () => {
    // A capability is verified locally, so a datastore outage must not stop a
    // candidate from registering.
    const { app, mcp } = makeApp();
    const issued = await mint(app, { candidateId: "candidate-1" });
    const callsBefore = mcp.calls.length;

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });

    assert.equal(response.status, 201);
    assert.equal(
      mcp.calls.length,
      callsBefore,
      "registration must not require the MCP tool surface",
    );
  });
});

describe("registration failure semantics", () => {  test("a missing session secret fails closed rather than issuing a token", async () => {
    const app = buildApp({
      config: testConfig({
        auth: {
          apiToken: TEST_API_TOKEN,
          sessionSecret: "",
          candidateTokenTtlSeconds: 600,
          registrationMode: "capability",
          registrationCapabilityTtlSeconds: 900,
        },
      }),
      ai: new StubAiClient(),
      mcp: new StubMcpClient(),
      log: () => undefined,
      requestLogging: false,
    });

    const response = await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-42",
    });
    assert.equal(response.status, 503);
  });

  test("issuance fails closed when no session secret is configured", async () => {
    const app = buildApp({
      config: testConfig({
        auth: {
          apiToken: TEST_API_TOKEN,
          sessionSecret: "",
          candidateTokenTtlSeconds: 600,
          registrationMode: "capability",
          registrationCapabilityTtlSeconds: 900,
        },
      }),
      ai: new StubAiClient(),
      mcp: new StubMcpClient(),
      log: () => undefined,
      requestLogging: false,
    });

    const response = await post(
      app,
      "/api/v1/identity/capability",
      { candidateId: "candidate-42" },
      TEST_API_TOKEN,
    );
    assert.equal(response.status, 503);
  });

  test("no capability value appears in any log line", async () => {
    const lines: string[] = [];
    const app = buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp: new StubMcpClient().respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
        success: true,
        session: null,
        events: [],
        integrityReports: [],
      })),
      sessions: new SessionRegistry(),
      log: (message: string) => lines.push(message),
      requestLogging: false,
    });

    const issued = await mint(app, { candidateId: "candidate-1" });
    await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: issued.capability,
    });
    // A refused registration logs the failure class, never the credential.
    await post(app, "/api/v1/identity/set", {
      displayName: "Ada",
      candidateId: "candidate-1",
      registrationCapability: expiredCapability("candidate-1"),
    });

    const joined = lines.join("\n");
    assert.ok(lines.length > 0, "the test must actually capture log output");
    assert.equal(joined.includes(issued.capability), false);
    assert.equal(joined.includes(issued.capability.split(".")[1] as string), false);
    assert.equal(joined.includes(TEST_SESSION_SECRET), false);
  });
});
