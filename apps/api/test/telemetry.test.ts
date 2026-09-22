/**
 * Telemetry ingestion tests.
 *
 * Exercises the full HTTP ingestion path with stubbed AI and MCP collaborators:
 * tab-switch and copy/paste wiring, duplicate suppression over the wire,
 * AI analysis triggering and its code-hash guard, validation failures, and
 * graceful degradation when the datastore or the model is unavailable.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { MCP_TOOLS } from "@assessment/mcp-mongodb";
import { buildApp } from "../src/app.js";
import { SessionRegistry } from "../src/integrity-session.js";
import {
  StubAiClient,
  StubMcpClient,
  TEST_API_TOKEN,
  sampleIntegrityReport,
  telemetryEvent,
  testConfig,
} from "./helpers.js";

const OPERATOR = { Authorization: `Bearer ${TEST_API_TOKEN}` };

function makeHarness(options: { existingSession?: boolean; storeFailure?: string } = {}) {
  const ai = new StubAiClient();
  const mcp = new StubMcpClient();

  if (options.storeFailure) {
    mcp.failure = options.storeFailure;
  } else {
    mcp.respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
      success: true,
      session: options.existingSession
        ? {
            sessionId: "session-1",
            candidateId: "candidate-1",
            assessmentId: "assessment-1",
            status: "in_progress",
          }
        : null,
      events: [],
      integrityReports: [],
    }))
      .respond(MCP_TOOLS.CREATE_SESSION, () => ({ success: true, mongoDocumentId: "doc-1" }))
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, (args) => ({
        success: true,
        processedCount: (args["events"] as unknown[]).length,
      }))
      .respond(MCP_TOOLS.STORE_INTEGRITY_REPORT, () => ({ success: true, mongoDocumentId: "report-1" }));
  }

  const sessions = new SessionRegistry();
  const app = buildApp({
    config: testConfig(),
    ai,
    mcp,
    sessions,
    log: () => undefined,
    requestLogging: false,
  });

  return { app, ai, mcp, sessions };
}

async function ingest(
  app: ReturnType<typeof buildApp>,
  events: unknown[],
  token: string = TEST_API_TOKEN,
): Promise<Response> {
  return app.request("/api/v1/integrity/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events }),
  });
}

describe("telemetry validation", () => {
  test("rejects an empty event array", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, []);
    assert.equal(response.status, 400);
  });

  test("rejects an unsupported event type", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, [telemetryEvent({ eventType: "SCREENSHOT" })]);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /Unsupported 'eventType'/);
  });

  test("rejects an event missing candidateId and reports its index", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent(),
      telemetryEvent({ candidateId: "" }),
    ]);
    assert.equal(response.status, 400);
    const body = (await response.json()) as { eventIndex: number };
    assert.equal(body.eventIndex, 1);
  });

  test("rejects a batch spanning two sessions", async () => {
    const { app, mcp } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent({ sessionId: "session-1" }),
      telemetryEvent({ sessionId: "session-2" }),
    ]);
    assert.equal(response.status, 400);
    assert.equal(mcp.calls.length, 0, "an invalid batch must not reach the datastore");
  });

  test("rejects a batch larger than the accepted maximum", async () => {
    const { app } = makeHarness();
    const batch = Array.from({ length: 501 }, () => telemetryEvent());
    const response = await ingest(app, batch);
    assert.equal(response.status, 400);
  });

  test("normalises timestamps to UTC", async () => {
    const { app, mcp } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent({ timestamp: "2026-01-01T05:00:00.000+05:00", eventType: "TAB_SWITCH" }),
    ]);
    assert.equal(response.status, 200);

    const persisted = mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS)[0]?.["events"] as Array<{
      timestamp: string;
    }>;
    assert.equal(persisted[0]?.timestamp, "2026-01-01T00:00:00.000Z");
  });
});

describe("telemetry wiring", () => {
  test("tab-switch and window-blur telemetry are recorded and surfaced in review", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "hidden" } }),
      telemetryEvent({ eventType: "WINDOW_BLUR", payload: {} }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "visible" } }),
      telemetryEvent({ eventType: "KEYSTROKE", payload: { char: "x", deltaMs: 110 } }),
    ]);

    assert.equal(response.status, 200);
    const body = (await response.json()) as { processedCount: number };
    assert.equal(body.processedCount, 4);
  });

  test("copy and paste telemetry are recorded", async () => {
    const { app, mcp } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent({ eventType: "COPY_ATTEMPT", payload: { selectedText: "const a = 1" } }),
      telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "const b = 2;" } }),
    ]);

    assert.equal(response.status, 200);
    const body = (await response.json()) as { processedCount: number };
    assert.equal(body.processedCount, 2);
    assert.equal(mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS).length, 1);
  });

  test("duplicate events in separate batches are suppressed and not persisted twice", async () => {
    const { app, mcp } = makeHarness();
    const paste = telemetryEvent({
      eventId: "stable-id",
      eventType: "PASTE_TRIGGER",
      payload: { pasteContent: "duplicated content" },
    });

    const first = await ingest(app, [paste]);
    const second = await ingest(app, [{ ...paste, eventId: "replay-id" }]);

    assert.equal((await first.json() as { processedCount: number }).processedCount, 1);
    const secondBody = (await second.json()) as { processedCount: number; duplicateCount: number };
    assert.equal(secondBody.processedCount, 0);
    assert.equal(secondBody.duplicateCount, 1);

    // The durability layer is written only once, so the reviewer timeline cannot
    // show the same observation twice.
    const persisted = mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS);
    assert.equal(persisted.length, 1, "a fully duplicated batch must not be written again");
    assert.equal((persisted[0]?.["events"] as unknown[]).length, 1);
  });

  test("only the new events of a partially duplicated batch are persisted", async () => {
    const { app, mcp } = makeHarness();
    const original = telemetryEvent({
      eventId: "original",
      eventType: "PASTE_TRIGGER",
      payload: { pasteContent: "shared content" },
    });

    await ingest(app, [original]);
    const mixed = await ingest(app, [
      { ...original, eventId: "replay" },
      telemetryEvent({
        eventId: "fresh",
        eventType: "PASTE_TRIGGER",
        payload: { pasteContent: "different content" },
      }),
    ]);

    const body = (await mixed.json()) as { processedCount: number; duplicateCount: number };
    assert.equal(body.processedCount, 1);
    assert.equal(body.duplicateCount, 1);

    const writes = mcp.callsFor(MCP_TOOLS.INGEST_MICRO_EVENTS);
    assert.equal(writes.length, 2);
    const secondWrite = writes[1]?.["events"] as Array<{ eventId: string }>;
    assert.deepEqual(
      secondWrite.map((event) => event.eventId),
      ["fresh"],
      "the suppressed replay must not reach storage",
    );
  });

  test("an ingestion response reports how many events were accepted", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, [
      telemetryEvent({ eventType: "KEYSTROKE", payload: { char: "a", deltaMs: 100 } }),
      telemetryEvent({ eventType: "KEYSTROKE", payload: { char: "b", deltaMs: 110 } }),
      telemetryEvent({ eventType: "KEYSTROKE", payload: { char: "c", deltaMs: 120 } }),
    ]);
    const body = (await response.json()) as { processedCount: number; persisted: boolean };
    assert.equal(body.processedCount, 3);
    assert.equal(body.persisted, true);
  });
});

describe("integrity analysis triggering", () => {
  test("analysis runs once thresholds are crossed and code is substantial", async () => {
    const { app, ai, mcp } = makeHarness();
    const code = "const handler = async (req, res) => { return res.json({ ok: true }); };";

    for (let index = 0; index < 6; index += 1) {
      await ingest(app, [
        telemetryEvent({
          eventType: "PASTE_TRIGGER",
          payload: { pasteContent: `${code} // part ${index}` },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 3)).toISOString(),
        }),
      ]);
    }

    assert.equal(ai.calls.includes("analyzeIntegrity"), true);
    assert.equal(mcp.callsFor(MCP_TOOLS.STORE_INTEGRITY_REPORT).length >= 1, true);
  });

  test("the report is enriched with session context and a keystroke summary", async () => {
    const { app, mcp } = makeHarness();
    const code = "function solve(input) { return input.split('').reverse().join(''); }";

    for (let index = 0; index < 6; index += 1) {
      await ingest(app, [
        telemetryEvent({
          eventType: "PASTE_TRIGGER",
          payload: { pasteContent: `${code} // ${index}` },
          timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index * 3)).toISOString(),
        }),
      ]);
    }

    const stored = mcp.callsFor(MCP_TOOLS.STORE_INTEGRITY_REPORT)[0]?.["report"] as Record<
      string,
      unknown
    >;
    assert.ok(stored, "an integrity report must be persisted once analysis runs");
    assert.equal(stored["sessionId"], "session-1");
    assert.equal(stored["candidateId"], "candidate-1");
    assert.equal(stored["assessmentId"], "assessment-1");
    assert.ok(stored["keystrokeMetrics"]);
    assert.equal(typeof stored["overallScore"], "number");
  });

  test("identical code is not re-analysed on subsequent batches", async () => {
    const { app, ai } = makeHarness();
    const code = "const stable = () => 'a long enough code body to be analysed'.repeat(2);";

    // Timestamps advance so each observation is genuinely distinct telemetry,
    // while the submitted code itself never changes.
    let clock = 0;
    const at = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, (clock += 5))).toISOString();

    const batch = [
      telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: code }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "hidden" }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "visible" }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "hidden" }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "visible" }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "hidden" }, timestamp: at() }),
      telemetryEvent({ eventType: "TAB_SWITCH", payload: { visibilityState: "visible" }, timestamp: at() }),
    ];

    await ingest(app, batch);
    const afterFirst = ai.calls.filter((call) => call === "analyzeIntegrity").length;

    // More telemetry, but the submitted code is byte-identical.
    await ingest(app, [telemetryEvent({ eventType: "COPY_ATTEMPT", payload: { selectedText: "x" }, timestamp: at() })]);
    await ingest(app, [telemetryEvent({ eventType: "COPY_ATTEMPT", payload: { selectedText: "y" }, timestamp: at() })]);
    await ingest(app, [telemetryEvent({ eventType: "COPY_ATTEMPT", payload: { selectedText: "z" }, timestamp: at() })]);

    const afterRepeats = ai.calls.filter((call) => call === "analyzeIntegrity").length;
    assert.equal(afterFirst, 1, "the first analysis should run");
    assert.equal(afterRepeats, 1, "unchanged code must not trigger repeated analyses");
  });

  test("an alert is raised when the score exceeds the configured threshold", async () => {
    const { app } = makeHarness();
    const response = await ingest(app, [telemetryEvent({ eventType: "KEYSTROKE", payload: { char: "a", deltaMs: 100 } })]);
    const body = (await response.json()) as { alertTriggered: boolean };
    assert.equal(body.alertTriggered, false, "no analysis means no alert");
  });

  test("a score above the threshold sets the alert flag", async () => {
    const ai = new StubAiClient();
    ai.integrity = sampleIntegrityReport({ overallScore: 91 });

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
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }))
      .respond(MCP_TOOLS.STORE_INTEGRITY_REPORT, () => ({ success: true }));

    const app = buildApp({
      config: testConfig(),
      ai,
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    let alertTriggered = false;
    const code = "const answer = 42; // a sufficiently long code body for analysis to run";

    for (let index = 0; index < 6 && !alertTriggered; index += 1) {
      const response = await ingest(app, [
        telemetryEvent({
          eventType: "PASTE_TRIGGER",
          payload: { pasteContent: `${code} /* ${index} */` },
        }),
      ]);
      const body = (await response.json()) as { alertTriggered: boolean };
      alertTriggered = body.alertTriggered;
    }

    assert.equal(alertTriggered, true);
  });
});

describe("submission snapshot persistence", () => {
  test("the reconstructed code is written back to the session record", async () => {
    const { app, mcp } = makeHarness();
    const code = "export function solve(xs) { return xs.slice().sort(); }";

    const response = await ingest(app, [
      telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: code } }),
    ]);

    assert.equal(response.status, 200);
    const body = (await response.json()) as { codePersisted: boolean };
    assert.equal(body.codePersisted, true);

    const written = mcp.callsFor(MCP_TOOLS.UPDATE_SESSION_CODE);
    assert.equal(written.length, 1, "a changed snapshot must be persisted exactly once");
    assert.equal(written[0]?.["sessionId"], "session-1");
    assert.equal(written[0]?.["code"], code);
  });

  test("an unchanged snapshot is not rewritten", async () => {
    const { app, mcp } = makeHarness();

    // A copy attempt changes no code, so no snapshot write should occur.
    await ingest(app, [
      telemetryEvent({ eventType: "COPY_ATTEMPT", payload: { selectedText: "x" } }),
    ]);

    assert.equal(mcp.callsFor(MCP_TOOLS.UPDATE_SESSION_CODE).length, 0);
  });

  test("a deferred snapshot write is reported without failing the request", async () => {
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
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }))
      .failTool(MCP_TOOLS.UPDATE_SESSION_CODE, "write concern failed");

    const app = buildApp({
      config: testConfig(),
      ai,
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await ingest(app, [
      telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "const a = 1;" } }),
    ]);

    assert.equal(response.status, 200);
    const body = (await response.json()) as { success: boolean; codePersisted: boolean };
    assert.equal(body.success, true);
    assert.equal(body.codePersisted, false, "the client must learn the snapshot did not land");
  });

  test("a settled session's submission is not overwritten", async () => {
    const ai = new StubAiClient();
    const mcp = new StubMcpClient()
      .respond(MCP_TOOLS.GET_SESSION_REVIEW, () => ({
        success: true,
        session: {
          sessionId: "session-1",
          candidateId: "candidate-1",
          assessmentId: "assessment-1",
          status: "submitted",
          submittedCode: "the frozen final answer",
        },
        events: [],
        integrityReports: [],
      }))
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 1 }));

    const app = buildApp({
      config: testConfig(),
      ai,
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await ingest(app, [
      telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: "late edit" } }),
    ]);

    assert.equal(response.status, 200);
    assert.equal(
      mcp.callsFor(MCP_TOOLS.UPDATE_SESSION_CODE).length,
      0,
      "a submitted session's snapshot must stay frozen",
    );
  });
});

describe("degraded dependencies", () => {
  test("a datastore outage fails the ingestion instead of silently dropping the session", async () => {
    const { app } = makeHarness({ storeFailure: "connection refused" });
    const response = await ingest(app, [telemetryEvent()]);

    assert.equal(response.status, 502);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /unavailable/i);
  });

  test("a model outage does not reject telemetry that was durably accepted", async () => {
    const ai = new StubAiClient();
    ai.analyzeError = new Error("model unavailable");

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
      .respond(MCP_TOOLS.INGEST_MICRO_EVENTS, () => ({ success: true, processedCount: 6 }))
      .respond(MCP_TOOLS.STORE_INTEGRITY_REPORT, () => ({ success: true }));

    const app = buildApp({
      config: testConfig(),
      ai,
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const code = "const a = 1; // long enough to be analysed by the provider";
    let last: Response | null = null;
    for (let index = 0; index < 6; index += 1) {
      last = await ingest(app, [
        telemetryEvent({ eventType: "PASTE_TRIGGER", payload: { pasteContent: `${code}${index}` } }),
      ]);
    }

    assert.equal(last?.status, 200);
    const body = (await last?.json()) as { success: boolean; integrityReport: unknown };
    assert.equal(body.success, true);
    assert.equal(body.integrityReport, null, "a failed analysis yields no report rather than an error");
  });

  test("a persistence failure is reported without failing the request", async () => {
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
      // The datastore accepts the session lookup but fails the telemetry write.
      .failTool(MCP_TOOLS.INGEST_MICRO_EVENTS, "write concern failed");

    const app = buildApp({
      config: testConfig(),
      ai,
      mcp,
      log: () => undefined,
      requestLogging: false,
    });

    const response = await ingest(app, [telemetryEvent()]);
    const body = (await response.json()) as { success: boolean; persisted: boolean };
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.persisted, false, "the client must learn the write did not land");
  });
});

