/**
 * Route: POST /api/v1/guardian/ingest
 * Feature 2 — REAL-TIME INTENT & PLAGIARISM GUARDIAN
 *
 * Streaming micro-event ingestion handler. Accepts batches of micro-inputs
 * (paste triggers, code deltas, tab switches) and delegates to the Intent
 * Guardian Agent backed by Gemini for semantic plagiarism detection.
 *
 * Sessions are persisted to MongoDB via the MCP HTTP adapter sidecar.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ENTERPRISE HARDENING (2026-05-28):
 *   - Every MCP HTTP call is wrapped in an isolated AbortController
 *     timeout (MCP_TIMEOUT_MS) so that a slow MongoDB Atlas connection
 *     never starves the ingestion loop.
 *   - Deep observability telemetry logs at every pipeline milestone.
 * ═══════════════════════════════════════════════════════════════════
 */

import { Hono } from "hono";
import type { IngestMicroEventRequest, IngestMicroEventResponse, MicroEvent, SuspicionPayload } from "../types.js";
import { GeminiClient } from "../agents/gemini-client.js";
import { loadConfig } from "../config.js";

const guardianRouter = new Hono();
const config = loadConfig();
const gemini = new GeminiClient(config);

// ─── MCP Constants ──────────────────────────────────────────────

/** MCP HTTP Adapter base URL (sidecar on port 3001). */
const MCP_BASE = process.env["MCP_URL"] ?? "http://localhost:3001";

/**
 * Maximum time (ms) any single MCP fetch call is allowed to take.
 * Exceeding this threshold aborts the request and falls through to
 * the in-memory-only path so the ingestion pipeline stays responsive.
 */
const MCP_TIMEOUT_MS = 5_000;

// ─── In-Memory Session Store (replaced by MongoDB via MCP in production) ──

interface SessionState {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  events: MicroEvent[];
  currentCode: string;
  pasteCount: number;
  keystrokeDeltas: number[];
  tabSwitchCount: number;
  fullscreenExitCount: number;
  copyAttemptCount: number;
  lastSuspicionPayload: SuspicionPayload | null;
}

const sessionStore = new Map<string, SessionState>();

// ─── POST /api/v1/guardian/ingest ─────────────────────────────────

guardianRouter.post("/ingest", async (c) => {
  const requestId = crypto.randomUUID();
  console.log(`[Guardian Route] [${requestId}] Incoming POST /api/v1/guardian/ingest`);

  let body: IngestMicroEventRequest;
  try {
    body = await c.req.json<IngestMicroEventRequest>();
  } catch (parseError) {
    console.error(`[Guardian Route] [${requestId}] JSON parse failure:`, parseError);
    return c.json(
      { success: false, error: "Invalid JSON body", correlationId: requestId },
      400
    );
  }

  if (!body.events || !Array.isArray(body.events) || body.events.length === 0) {
    console.warn(`[Guardian Route] [${requestId}] Validation failed: empty/missing events array`);
    return c.json(
      { success: false, error: "Field 'events' must be a non-empty array" },
      400
    );
  }

  // Determine the primary session from the first event
  const primaryEvent = body.events[0];
  const sessionId = primaryEvent?.sessionId;
  if (!sessionId) {
    console.warn(`[Guardian Route] [${requestId}] Validation failed: missing sessionId in first event`);
    return c.json({ success: false, error: "Each event must contain a sessionId" }, 400);
  }

  const processedCount = body.events.length;
  let suspicionPayload: SuspicionPayload | null = null;
  let alertTriggered = false;

  try {
    // ── Step 1: Ensure session exists in MongoDB (timeout-isolated) ──
    console.log(`[Guardian Route] [${requestId}] Ensuring session ${sessionId} in MongoDB...`);
    await ensureMongoSession(sessionId, primaryEvent, requestId);

    // ── Step 2: Persist micro-events to MongoDB (timeout-isolated) ──
    console.log(`[Guardian Route] [${requestId}] Persisting ${processedCount} events to MongoDB...`);
    await persistMicroEvents(body.events, requestId);

    // ── Step 3: In-memory processing (real-time guardian analysis) ──
    console.log(`[Guardian Route] [${requestId}] Processing ${processedCount} events in-memory...`);
    for (const event of body.events) {
      processEvent(event);
    }

    const session = sessionStore.get(sessionId);
    if (!session) {
      console.error(`[Guardian Route] [${requestId}] Session ${sessionId} not found after processing`);
      return c.json({ success: false, error: `Session ${sessionId} not found after processing` }, 404);
    }

    // ── Step 4: Suspicion analysis threshold check ──
    const shouldAnalyze =
      session.pasteCount > config.security.maxPasteEventsPerSession ||
      session.tabSwitchCount > 3 ||
      session.fullscreenExitCount > 0 ||
      session.copyAttemptCount > 2 ||
      hasAnomalousKeystrokes(session.keystrokeDeltas);

    console.log(
      `[Guardian Route] [${requestId}] Suspicion check — ` +
        `pastes=${session.pasteCount}/${config.security.maxPasteEventsPerSession} ` +
        `tabs=${session.tabSwitchCount} fullscreen=${session.fullscreenExitCount} ` +
        `copies=${session.copyAttemptCount} codeLen=${session.currentCode.length} ` +
        `shouldAnalyze=${shouldAnalyze}`
    );

    if (shouldAnalyze && session.currentCode.length > 50) {
      const keystrokeMetrics = computeKeystrokeMetrics(session.keystrokeDeltas);
      const pasteContents = session.events
        .filter((e) => e.eventType === "PASTE_TRIGGER" && e.payload.pasteContent)
        .map((e) => e.payload.pasteContent!);

      // Gather reference completions — in production this queries a cache of
      // Gemini outputs for the same problem from the MCP MongoDB store
      const referenceCompletions = await getReferenceCompletions(
        session.assessmentId,
        primaryEvent?.problemId ?? ""
      );

      console.log(
        `[Guardian Route] [${requestId}] Invoking GeminiClient.analyzeSuspicion ` +
          `— codeLen=${session.currentCode.length} pastes=${pasteContents.length} ` +
          `refCompletions=${referenceCompletions.length} keystrokeAvg=${keystrokeMetrics.avgDeltaMs.toFixed(1)}ms`
      );

      const analysisStartMs = Date.now();
      suspicionPayload = await gemini.analyzeSuspicion(
        session.currentCode,
        pasteContents,
        keystrokeMetrics,
        referenceCompletions
      );
      console.log(
        `[Guardian Route] [${requestId}] Gemini suspicion analysis complete in ${Date.now() - analysisStartMs}ms ` +
          `— score=${suspicionPayload.overallScore} flags=${suspicionPayload.flags.length}`
      );

      // Enrich with session context
      suspicionPayload.sessionId = sessionId;
      suspicionPayload.candidateId = session.candidateId;
      suspicionPayload.assessmentId = session.assessmentId;
      suspicionPayload.generatedAt = new Date().toISOString();

      session.lastSuspicionPayload = suspicionPayload;
      sessionStore.set(sessionId, session);

      alertTriggered = suspicionPayload.overallScore > 50;

      // ── Persist suspicion report to MongoDB (timeout-isolated) ──
      await persistSuspicionReport(suspicionPayload, requestId);
    }

    const response: IngestMicroEventResponse = {
      success: true,
      processedCount,
      suspicionPayload,
      alertTriggered,
    };

    console.log(
      `[Guardian Route] [${requestId}] COMPLETE — processedCount=${processedCount} ` +
        `alertTriggered=${alertTriggered} score=${suspicionPayload?.overallScore ?? "N/A"}`
    );
    return c.json(response, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown guardian error";
    console.error(
      `[Guardian Route] [${requestId}] FAILURE — ${message}`,
      error instanceof Error ? error.stack : ""
    );
    return c.json(
      { success: false, error: `Guardian analysis failed: ${message}`, correlationId: requestId },
      500
    );
  }
});

// ─── GET /api/v1/guardian/sessions/:sessionId ─────────────────────

guardianRouter.get("/sessions/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessionStore.get(sessionId);

  if (!session) {
    return c.json({ success: false, error: "Session not found" }, 404);
  }

  return c.json({
    success: true,
    session: {
      sessionId: session.sessionId,
      candidateId: session.candidateId,
      assessmentId: session.assessmentId,
      eventCount: session.events.length,
      pasteCount: session.pasteCount,
      tabSwitchCount: session.tabSwitchCount,
      fullscreenExitCount: session.fullscreenExitCount,
      copyAttemptCount: session.copyAttemptCount,
      currentCodeLength: session.currentCode.length,
      lastSuspicionPayload: session.lastSuspicionPayload,
    },
  });
});

// ═══════════════════════════════════════════════════════════════════
// MCP Timeout-Isolated Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Executes an MCP HTTP fetch with a hard timeout. Returns the Response
 * on success, or null if the call timed out / errored.
 */
async function mcpFetch(
  tool: string,
  body: unknown,
  requestId: string
): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(
      `[Guardian MCP] [${requestId}] ABORTING ${tool} after ${MCP_TIMEOUT_MS}ms`
    );
    controller.abort();
  }, MCP_TIMEOUT_MS);

  try {
    const startMs = Date.now();
    const res = await fetch(`${MCP_BASE}/tools/${tool}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    console.log(
      `[Guardian MCP] [${requestId}] ${tool} completed — HTTP ${res.status} in ${Date.now() - startMs}ms`
    );
    return res;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(
        `[Guardian MCP] [${requestId}] ${tool} TIMED OUT after ${MCP_TIMEOUT_MS}ms`
      );
    } else {
      console.error(
        `[Guardian MCP] [${requestId}] ${tool} error:`,
        error instanceof Error ? error.message : String(error)
      );
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureMongoSession(
  sessionId: string,
  primaryEvent: MicroEvent,
  requestId: string
): Promise<void> {
  // Check if session exists
  const checkRes = await mcpFetch("get_session_review", { sessionId }, requestId);

  let exists = false;
  if (checkRes?.ok) {
    try {
      const checkData = (await checkRes.json()) as { success: boolean; session?: unknown };
      exists = checkData.success && !!checkData.session;
    } catch {
      exists = false;
    }
  }

  if (!exists) {
    console.log(`[Guardian MCP] [${requestId}] Session '${sessionId}' not found, creating...`);
    const createRes = await mcpFetch(
      "create_session",
      {
        sessionId,
        candidateId: primaryEvent.candidateId ?? "unknown",
        assessmentId: primaryEvent.assessmentId ?? "unknown",
      },
      requestId
    );
    if (createRes?.ok) {
      console.log(`[Guardian MCP] [${requestId}] Session '${sessionId}' created`);
    } else {
      console.warn(`[Guardian MCP] [${requestId}] Failed to create session (non-fatal)`);
    }
  }
}

async function persistMicroEvents(
  events: MicroEvent[],
  requestId: string
): Promise<void> {
  const res = await mcpFetch("ingest_micro_events", { events }, requestId);
  if (!res?.ok) {
    console.warn(`[Guardian MCP] [${requestId}] Failed to persist events (non-fatal)`);
  }
}

async function persistSuspicionReport(
  report: SuspicionPayload,
  requestId: string
): Promise<void> {
  const res = await mcpFetch("store_suspicion_report", { report }, requestId);
  if (!res?.ok) {
    console.warn(`[Guardian MCP] [${requestId}] Failed to persist suspicion report (non-fatal)`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════════════════════════

function processEvent(event: MicroEvent): void {
  let session = sessionStore.get(event.sessionId);

  if (!session) {
    session = {
      sessionId: event.sessionId,
      candidateId: event.candidateId,
      assessmentId: event.assessmentId,
      events: [],
      currentCode: "",
      pasteCount: 0,
      keystrokeDeltas: [],
      tabSwitchCount: 0,
      fullscreenExitCount: 0,
      copyAttemptCount: 0,
      lastSuspicionPayload: null,
    };
  }

  session.events.push(event);

  switch (event.eventType) {
    case "KEYSTROKE":
      if (event.payload.deltaMs !== undefined) {
        session.keystrokeDeltas.push(event.payload.deltaMs);
      }
      break;
    case "PASTE_TRIGGER":
      session.pasteCount++;
      if (event.payload.pasteContent) {
        session.currentCode += event.payload.pasteContent;
      }
      break;
    case "CODE_DELTA":
      if (event.payload.diffPatch) {
        session.currentCode = applyDiffPatch(session.currentCode, event.payload.diffPatch);
      }
      break;
    case "TAB_SWITCH":
      session.tabSwitchCount++;
      break;
    case "WINDOW_BLUR":
    case "FULLSCREEN_EXIT":
      session.fullscreenExitCount++;
      break;
    case "COPY_ATTEMPT":
      session.copyAttemptCount++;
      break;
    case "SUBMIT":
      // Final code snapshot
      if (event.payload.pasteContent) {
        session.currentCode = event.payload.pasteContent;
      }
      break;
  }

  sessionStore.set(event.sessionId, session);
}

function hasAnomalousKeystrokes(deltas: number[]): boolean {
  if (deltas.length < 10) return false;
  const fastCount = deltas.filter((d) => d < config.security.minHumanKeystrokeMs).length;
  return fastCount / deltas.length > 0.3;
}

function computeKeystrokeMetrics(deltas: number[]): {
  avgDeltaMs: number;
  maxDeltaMs: number;
  minDeltaMs: number;
} {
  if (deltas.length === 0) return { avgDeltaMs: 0, maxDeltaMs: 0, minDeltaMs: 0 };
  return {
    avgDeltaMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
    maxDeltaMs: Math.max(...deltas),
    minDeltaMs: Math.min(...deltas),
  };
}

function applyDiffPatch(current: string, _diffPatch: string): string {
  // Simplified: append the diff as a code block update.
  // In production, this applies a proper unified diff algorithm.
  if (_diffPatch.startsWith("@@") || _diffPatch.startsWith("---")) {
    const lines = _diffPatch.split("\n");
    const newLines = lines
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return newLines.length > 0 ? newLines.join("\n") : current;
  }
  return current + _diffPatch;
}

async function getReferenceCompletions(
  _assessmentId: string,
  _problemId: string
): Promise<string[]> {
  // In production, queries the MCP MongoDB store for cached Gemini completions
  return [];
}

export { guardianRouter, sessionStore };