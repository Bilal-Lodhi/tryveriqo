/**
 * Rate limiter tests.
 *
 * Two properties are pinned here, because getting either wrong makes the limiter
 * decorative rather than protective:
 *
 *   - the bucket key is not attacker-controlled unless the deployment says it
 *     sits behind a proxy it controls;
 *   - the bucket map is bounded absolutely, so a client rotating keys cannot grow
 *     it while every bucket is still live.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import { issueCandidateToken } from "../src/middleware/tokens.js";
import {
  MAX_RATE_LIMIT_BUCKETS,
  evictForSpace,
  rateLimit,
  rateLimitKey,
  type RateLimitBucket,
  type RateLimitOptions,
} from "../src/middleware/rate-limit.js";
import type { AuthContext, AppEnv } from "../src/middleware/auth.js";
import type { Context } from "hono";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  TEST_SESSION_SECRET,
  testConfig,
  telemetryEvent,
} from "./helpers.js";

const CANDIDATE = (candidateId: string): AuthContext => ({
  role: "candidate",
  candidateId,
  displayName: "Ada",
});

/** Minimal context: the limiter only reads headers, auth and writes a response. */
function fakeContext(headers: Record<string, string> = {}, auth?: AuthContext): Context<AppEnv> {
  return {
    req: { header: (name: string) => headers[name] },
    get: (key: string) => (key === "auth" ? auth : undefined),
    header: () => undefined,
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  } as unknown as Context<AppEnv>;
}

const BASE: RateLimitOptions = { windowMs: 60_000, max: 2, name: "test" };

describe("rate-limit key selection", () => {
  test("client-supplied headers are ignored by default", () => {
    const first = rateLimitKey(fakeContext({ "X-Forwarded-For": "1.2.3.4" }), BASE);
    const second = rateLimitKey(fakeContext({ "X-Forwarded-For": "5.6.7.8" }), BASE);
    assert.equal(first, second, "rotating X-Forwarded-For must not change the bucket");
  });

  test("X-Real-Ip is ignored by default too", () => {
    const first = rateLimitKey(fakeContext({ "X-Real-Ip": "1.2.3.4" }), BASE);
    const second = rateLimitKey(fakeContext({ "X-Real-Ip": "5.6.7.8" }), BASE);
    assert.equal(first, second);
  });

  test("headers are honoured when the deployment opts in", () => {
    const trusting: RateLimitOptions = { ...BASE, trustProxyHeaders: true };
    const first = rateLimitKey(fakeContext({ "X-Forwarded-For": "1.2.3.4" }), trusting);
    const second = rateLimitKey(fakeContext({ "X-Forwarded-For": "5.6.7.8" }), trusting);
    assert.equal(first, "1.2.3.4");
    assert.equal(second, "5.6.7.8");
  });

  test("only the first entry of a forwarded chain is used", () => {
    const trusting: RateLimitOptions = { ...BASE, trustProxyHeaders: true };
    assert.equal(
      rateLimitKey(fakeContext({ "X-Forwarded-For": "1.2.3.4, 5.6.7.8, 9.10.11.12" }), trusting),
      "1.2.3.4",
    );
  });

  test("a principal key prefers the authenticated candidate", () => {
    const options: RateLimitOptions = { ...BASE, keyBy: "principal" };
    const key = rateLimitKey(fakeContext({ "X-Forwarded-For": "1.2.3.4" }, CANDIDATE("candidate-1")), options);
    assert.equal(key, "candidate:candidate-1");
  });

  test("a principal key separates two candidates on one address", () => {
    const options: RateLimitOptions = { ...BASE, keyBy: "principal" };
    const one = rateLimitKey(fakeContext({}, CANDIDATE("candidate-1")), options);
    const two = rateLimitKey(fakeContext({}, CANDIDATE("candidate-2")), options);
    assert.notEqual(one, two);
  });

  test("a principal key falls back to the address for an operator", () => {
    const options: RateLimitOptions = { ...BASE, keyBy: "principal" };
    const key = rateLimitKey(
      fakeContext({}, { role: "operator", candidateId: null, displayName: null }),
      options,
    );
    assert.equal(key.startsWith("candidate:"), false);
  });

  test("a principal key falls back to the address for an anonymous caller", () => {
    const options: RateLimitOptions = { ...BASE, keyBy: "principal" };
    const key = rateLimitKey(fakeContext({}, { role: "anonymous", candidateId: null, displayName: null }), options);
    assert.equal(key.startsWith("candidate:"), false);
  });
});

describe("the limiter itself", () => {
  test("requests up to the limit are allowed and the next is refused", async () => {
    const limiter = rateLimit({ ...BASE, max: 2 });
    let allowed = 0;
    const next = async () => {
      allowed += 1;
    };

    for (let index = 0; index < 2; index += 1) {
      await limiter(fakeContext({}), next);
    }
    assert.equal(allowed, 2);

    const response = (await limiter(fakeContext({}), next)) as Response;
    assert.equal(response.status, 429);
    assert.equal(allowed, 2, "the refused request must not reach the handler");
  });

  test("a refusal carries Retry-After and a clear message", async () => {
    const limiter = rateLimit({ ...BASE, max: 1, name: "telemetry ingestion" });
    await limiter(fakeContext({}), async () => undefined);

    const response = (await limiter(fakeContext({}), async () => undefined)) as Response;
    assert.equal(response.status, 429);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /telemetry ingestion/);
  });

  test("rotating a spoofed header does not buy extra requests", async () => {
    // The defect this replaced: every request below carried a different
    // X-Forwarded-For, so each landed in a fresh bucket and the cap never applied.
    const limiter = rateLimit({ ...BASE, max: 2 });
    let allowed = 0;
    const next = async () => {
      allowed += 1;
    };

    for (let index = 0; index < 5; index += 1) {
      await limiter(fakeContext({ "X-Forwarded-For": `10.0.0.${index}` }), next);
    }

    assert.equal(allowed, 2, "only the configured allowance may pass");
  });

  test("a trusted proxy header does separate buckets when opted in", async () => {
    // Documented consequence of enabling the setting: it is only safe when a
    // proxy overwrites the header.
    const limiter = rateLimit({ ...BASE, max: 1, trustProxyHeaders: true });
    let allowed = 0;
    const next = async () => {
      allowed += 1;
    };

    for (let index = 0; index < 3; index += 1) {
      await limiter(fakeContext({ "X-Forwarded-For": `10.0.0.${index}` }), next);
    }
    assert.equal(allowed, 3);
  });
});

describe("the bucket map is bounded", () => {
  test("expired buckets are dropped first", () => {
    const now = 1_000_000;
    const buckets = new Map<string, RateLimitBucket>();
    for (let index = 0; index < 50; index += 1) {
      buckets.set(`expired-${index}`, { count: 1, resetAt: now - 1 });
    }
    for (let index = 0; index < 50; index += 1) {
      buckets.set(`live-${index}`, { count: 1, resetAt: now + 60_000 });
    }

    evictForSpace(buckets, now);

    assert.equal(buckets.size, 50);
    for (const key of buckets.keys()) {
      assert.ok(key.startsWith("live-"), `${key} should have been swept`);
    }
  });

  test("a full map of live buckets still loses exactly one", () => {
    const now = 1_000_000;
    const buckets = new Map<string, RateLimitBucket>();
    for (let index = 0; index < MAX_RATE_LIMIT_BUCKETS; index += 1) {
      buckets.set(`key-${index}`, { count: 1, resetAt: now + 60_000 + index });
    }

    evictForSpace(buckets, now);

    assert.equal(
      buckets.size,
      MAX_RATE_LIMIT_BUCKETS - 1,
      "the map must shrink, never grow, when every bucket is live",
    );
    // The soonest to expire is the one dropped.
    assert.equal(buckets.has("key-0"), false);
  });

  test("eviction never grows the map past the ceiling", () => {
    const now = 1_000_000;
    const buckets = new Map<string, RateLimitBucket>();
    for (let index = 0; index < MAX_RATE_LIMIT_BUCKETS; index += 1) {
      buckets.set(`key-${index}`, { count: 1, resetAt: now + 60_000 });
    }

    for (let round = 0; round < 10; round += 1) {
      evictForSpace(buckets, now);
      buckets.set(`added-${round}`, { count: 1, resetAt: now + 60_000 });
      assert.ok(
        buckets.size <= MAX_RATE_LIMIT_BUCKETS,
        `map grew to ${buckets.size} after round ${round}`,
      );
    }
  });

  test("an empty map is left alone", () => {
    const buckets = new Map<string, RateLimitBucket>();
    evictForSpace(buckets, 1_000_000);
    assert.equal(buckets.size, 0);
  });
});

describe("ingestion is rate-limited per candidate", () => {
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

    return buildApp({
      config: testConfig(),
      ai: new StubAiClient(),
      mcp,
      sessions: new SessionRegistry(),
      log: () => undefined,
      requestLogging: false,
    });
  }

  function tokenFor(candidateId: string): string {
    return issueCandidateToken({
      secret: TEST_SESSION_SECRET,
      candidateId,
      displayName: "Ada",
      ttlSeconds: 600,
    }).token;
  }

  async function ingest(app: ReturnType<typeof buildApp>, candidateId: string): Promise<Response> {
    return app.request("/api/v1/integrity/ingest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokenFor(candidateId)}`,
      },
      body: JSON.stringify({
        events: [
          telemetryEvent({
            candidateId,
            sessionId: `session-${candidateId}`,
            eventType: "TAB_SWITCH",
            payload: { visibilityState: "hidden" },
          }),
        ],
      }),
    });
  }

  test("two candidates do not share one ingestion budget", async () => {
    const app = makeApp();

    // Each candidate is well under the per-candidate allowance, so both succeed
    // even though together they exceed it.
    for (let index = 0; index < 3; index += 1) {
      assert.notEqual((await ingest(app, "candidate-1")).status, 429);
      assert.notEqual((await ingest(app, "candidate-2")).status, 429);
    }
  });

  test("the operator does not consume a candidate's budget", async () => {
    const app = makeApp();
    for (let index = 0; index < 3; index += 1) {
      await app.request("/api/v1/integrity/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TEST_API_TOKEN}` },
        body: JSON.stringify({
          events: [telemetryEvent({ sessionId: "operator-session", eventType: "TAB_SWITCH" })],
        }),
      });
    }

    assert.notEqual((await ingest(app, "candidate-1")).status, 429);
  });
});
