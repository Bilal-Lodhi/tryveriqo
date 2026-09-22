/**
 * Assessment generation endpoint tests.
 *
 * Exercises the pipeline end to end with a stub AI client and a stub MCP
 * client: validation, the deterministic pre-filter, classifier accept/reject,
 * provider failure modes, cancellation, and persistence reporting.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
} from "../src/agents/gemini-client.js";
import {
  DEFAULT_VERDICT,
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  testConfig,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

function makeHarness(ai = new StubAiClient(), mcp = new StubMcpClient()) {
  const app = buildApp({
    config: testConfig(),
    ai,
    mcp,
    log: () => undefined,
    requestLogging: false,
  });
  return { app, ai, mcp };
}

async function generate(
  app: ReturnType<typeof buildApp>,
  body: unknown,
  headers: Record<string, string> = OPERATOR,
): Promise<Response> {
  return app.request("/api/v1/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  prompt: "Design a mid-level fintech backend assessment covering idempotency.",
  roleContext: "backend-engineer",
  problemCount: 2,
};

describe("request validation", () => {
  test("rejects a malformed JSON body with 400", async () => {
    const { app } = makeHarness();
    const response = await generate(app, "{not json");
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /valid JSON/);
  });

  test("rejects a body that fails structural validation", async () => {
    const { app } = makeHarness();
    const response = await generate(app, { roleContext: "backend" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /prompt/);
  });

  test("does not reach the provider when validation fails", async () => {
    const { app, ai } = makeHarness();
    await generate(app, { prompt: "hi", roleContext: "backend", problemCount: 400 });
    assert.deepEqual(ai.calls, []);
  });

  test("rejects an out-of-range problem count", async () => {
    const { app } = makeHarness();
    const response = await generate(app, { ...VALID_BODY, problemCount: 99 });
    assert.equal(response.status, 400);
  });
});

describe("content pre-filter", () => {
  test("rejects a greeting before spending a model call", async () => {
    const { app, ai } = makeHarness();
    const response = await generate(app, { ...VALID_BODY, prompt: "hello" });

    assert.equal(response.status, 422);
    const body = (await response.json()) as { preFilterFlags: string[] };
    assert.deepEqual(body.preFilterFlags, ["GREETING_ONLY"]);
    assert.deepEqual(ai.calls, [], "the classifier must not run for filtered input");
  });

  test("rejects profanity and reports the flag", async () => {
    const { app, ai } = makeHarness();
    const response = await generate(app, {
      ...VALID_BODY,
      prompt: "generate a fucking test suite",
    });
    assert.equal(response.status, 422);
    const body = (await response.json()) as { preFilterFlags: string[] };
    assert.deepEqual(body.preFilterFlags, ["PROFANITY"]);
    assert.deepEqual(ai.calls, []);
  });

  test("lets a legitimate prompt through to the classifier", async () => {
    const { app, ai } = makeHarness();
    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 201);
    assert.equal(ai.calls[0], "classifyAssessmentIntent");
  });
});

describe("classifier gatekeeping", () => {
  test("rejects a request the classifier judges off-topic", async () => {
    const ai = new StubAiClient();
    ai.verdict = {
      ...DEFAULT_VERDICT,
      isAssessmentRelated: false,
      reason: "This asks for a recipe, not an assessment.",
    };
    const { app, mcp } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string; classifier: { reason: string } };
    assert.match(body.error, /not a usable assessment request/);
    assert.equal(body.classifier.reason, "This asks for a recipe, not an assessment.");
    assert.equal(mcp.callsFor(MCP_TOOLS.STORE_TEST_SUITE).length, 0);
  });

  test("rejects inappropriate content and surfaces the flags", async () => {
    const ai = new StubAiClient();
    ai.verdict = { ...DEFAULT_VERDICT, isAppropriate: false, contentFlags: ["HARASSMENT"] };
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /HARASSMENT/);
  });

  test("rejects a low-confidence classification", async () => {
    const ai = new StubAiClient();
    ai.verdict = { ...DEFAULT_VERDICT, confidence: 0.4 };
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /confidence/);
  });

  test("rejects a verdict with no usable domain", async () => {
    const ai = new StubAiClient();
    ai.verdict = { ...DEFAULT_VERDICT, detectedDomain: "" };
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 422);
  });

  test("a classifier outage degrades rather than blocks generation", async () => {
    const ai = new StubAiClient();
    ai.classifyError = new Error("classifier unavailable");
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 201);
    const body = (await response.json()) as { classifier: { executed: boolean; degraded: boolean } };
    assert.equal(body.classifier.executed, false);
    assert.equal(body.classifier.degraded, true);
    assert.deepEqual(ai.calls, ["classifyAssessmentIntent", "generateTestSuite"]);
  });
});

describe("successful generation", () => {
  test("returns a 201 suite and persists it", async () => {
    const { app, mcp } = makeHarness();
    const response = await generate(app, VALID_BODY);

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      success: boolean;
      suite: { problems: unknown[]; metadata: { promptFingerprint: string } };
      mcpCorrelationId: string;
      persisted: boolean;
      generationRequestId: string;
    };

    assert.equal(body.success, true);
    assert.equal(body.suite.problems.length, 1);
    assert.equal(body.persisted, true);
    assert.match(body.suite.metadata.promptFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(body.mcpCorrelationId);
    assert.ok(body.generationRequestId);
    assert.equal(mcp.callsFor(MCP_TOOLS.STORE_TEST_SUITE).length, 1);
  });

  test("returns the suite even when persistence fails, and says so", async () => {
    const mcp = new StubMcpClient();
    mcp.failTool(MCP_TOOLS.STORE_TEST_SUITE, "write concern failed");
    const { app } = makeHarness(new StubAiClient(), mcp);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 201);
    const body = (await response.json()) as { persisted: boolean; suite: unknown };
    assert.equal(body.persisted, false, "the caller must learn the suite was not stored");
    assert.ok(body.suite);
  });

  test("propagates the client's generation request id for cancellation", async () => {
    const { app } = makeHarness();
    const response = await generate(app, VALID_BODY, {
      ...OPERATOR,
      "X-Generation-Request-Id": "client-supplied-id",
    });
    const body = (await response.json()) as { generationRequestId: string };
    assert.equal(body.generationRequestId, "client-supplied-id");
  });

  test("logs a difficulty-mix deviation but still generates", async () => {
    const { app } = makeHarness();
    const response = await generate(app, {
      ...VALID_BODY,
      difficultyMix: { beginner: 0.9, intermediate: 0.9, advanced: 0.9 },
    });
    assert.equal(response.status, 201);
  });
});

describe("provider failure modes", () => {
  test("reports an unconfigured provider as 503", async () => {
    const ai = new StubAiClient();
    ai.generateError = new ProviderNotConfiguredError("GEMINI_API_KEY is not set.");
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /provider is not configured/);
  });

  test("a retryable provider error is a 503 with a retry hint", async () => {
    const ai = new StubAiClient();
    ai.generateError = new ProviderRequestError("upstream busy", true);
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 503);
    const body = (await response.json()) as { retryable: boolean; error: string };
    assert.equal(body.retryable, true);
    assert.match(body.error, /temporarily unavailable/);
  });

  test("a terminal provider error is a 500 and leaks no provider detail", async () => {
    const ai = new StubAiClient();
    ai.generateError = new ProviderRequestError(
      "PERMISSION_DENIED: key projects/12345 is not authorised",
      false,
    );
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 500);
    const raw = await response.text();
    assert.doesNotMatch(raw, /PERMISSION_DENIED/);
    assert.doesNotMatch(raw, /12345/);
    assert.match(raw, /Assessment generation failed/);
  });
});

describe("cancellation", () => {
  test("cancelling an unknown generation reports 404", async () => {
    const { app } = makeHarness();
    const response = await app.request("/api/v1/generate/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OPERATOR },
      body: JSON.stringify({ generationRequestId: "never-started" }),
    });
    assert.equal(response.status, 404);
  });

  test("cancel requires a generationRequestId", async () => {
    const { app } = makeHarness();
    const response = await app.request("/api/v1/generate/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OPERATOR },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  });

  test("an in-flight generation reports cancellation when the signal aborts", async () => {
    const ai = new StubAiClient();
    // Hold the generation open so the cancel arrives while it is running, and
    // have the generator honour the abort signal the route passes down — which
    // is exactly what the real provider client does.
    let release: (() => void) | undefined;
    ai.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ai.honourAbort = true;

    const { app } = makeHarness(ai);

    const pending = generate(app, VALID_BODY, {
      ...OPERATOR,
      "X-Generation-Request-Id": "cancel-me",
    });

    for (let attempt = 0; attempt < 100 && !ai.entered; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(ai.entered, true, "the generation should have started");

    const cancel = await app.request("/api/v1/generate/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OPERATOR },
      body: JSON.stringify({ generationRequestId: "cancel-me" }),
    });
    assert.equal(cancel.status, 200);
    const cancelBody = (await cancel.json()) as { success: boolean };
    assert.equal(cancelBody.success, true);

    release?.();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = (await response.json()) as { cancelled: boolean };
    assert.equal(body.cancelled, true);
  });

  test("an aborted signal surfaces as a cancellation, not an error", async () => {
    const ai = new StubAiClient();
    ai.generateError = new ProviderRequestError(
      "Assessment generation cancelled by client",
      false,
    );
    const { app } = makeHarness(ai);

    const response = await generate(app, VALID_BODY);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { cancelled: boolean };
    assert.equal(body.cancelled, true);
  });
});

describe("correlation", () => {
  test("every response carries a correlation id", async () => {
    const { app } = makeHarness();
    const response = await generate(app, VALID_BODY);
    assert.ok(response.headers.get("X-Correlation-Id"));
  });

  test("an inbound correlation id is echoed", async () => {
    const { app } = makeHarness();
    const response = await generate(app, VALID_BODY, {
      ...OPERATOR,
      "X-Correlation-Id": "trace-me",
    });
    assert.equal(response.headers.get("X-Correlation-Id"), "trace-me");
  });
});
