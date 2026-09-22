/**
 * Integrity telemetry routes.
 *
 *   POST   /api/v1/integrity/ingest          — ingest a candidate telemetry batch
 *   GET    /api/v1/integrity/sessions/:id    — live session signal summary
 *   DELETE /api/v1/integrity/sessions/:id    — terminate and remove a session
 *
 * Access: an operator may ingest for any candidate; a candidate may ingest only
 * their own telemetry. Session summaries and termination are limited to the
 * operator credential.
 *
 * Integrity analysis is triggered by thresholds, and is skipped when a
 * submission's code has not changed since the last analysis, so a retrying
 * client cannot spend repeated model calls on identical input.
 */

import { Hono } from "hono";
import type { IntegrityReport, MicroEvent } from "../types.js";
import { requireAuth, requireOperator, authOf, type AppEnv } from "../middleware/auth.js";
import { validateIngestRequest } from "../telemetry.js";
import {
  computeKeystrokeMetrics,
  createSessionState,
  decideAndApplyEvents,
  hydrateFromPersisted,
  shouldAnalyze,
  type SessionState,
} from "../integrity-session.js";
import {
  createSession,
  deleteSession,
  fetchSessionReview,
  ingestMicroEvents,
  storeIntegrityReport,
  updateSessionCode,
} from "../mcp-client.js";
import { nowIso } from "../utils/time.js";
import type { ApiDependencies } from "./dependencies.js";

export function integrityRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { ai, mcp, sessions, config, log } = deps;

  // ── POST /ingest ───────────────────────────────────────────────
  router.post("/ingest", requireAuth(), async (c) => {
    const requestId = c.get("correlationId") ?? crypto.randomUUID();
    const auth = authOf(c);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(
        { success: false, error: "Request body must be valid JSON.", correlationId: requestId },
        400,
      );
    }

    const validation = validateIngestRequest(raw);
    if (!validation.ok) {
      return c.json(
        {
          success: false,
          error: validation.error,
          ...(validation.index === undefined ? {} : { eventIndex: validation.index }),
          correlationId: requestId,
        },
        400,
      );
    }

    const { events, sessionId } = validation;
    const candidateId = events[0]!.candidateId;

    if (auth.role === "candidate" && auth.candidateId !== candidateId) {
      return c.json(
        { success: false, error: "Not authorised to submit telemetry for another candidate." },
        403,
      );
    }

    // ── Resolve or recover the session projection ────────────────
    const resolution = await resolveSession(sessionId, events, deps, requestId);
    if (!resolution.ok) {
      return c.json({ success: false, error: resolution.error, correlationId: requestId }, 502);
    }
    const session = resolution.session;

    // ── Fold the batch in memory FIRST, so that a replayed observation is
    // identified before anything is written. Duplicates are suppressed here and
    // deliberately not persisted: the reviewer timeline is built from stored
    // telemetry, so writing a replay would show the same action twice and
    // inflate every count derived from the timeline.
    const codeBeforeBatch = session.currentCode;
    const decisions = decideAndApplyEvents(session, events);
    sessions.set(session);

    const appliedCount = decisions.filter((decision) => decision.applied).length;
    const duplicateCount = decisions.length - appliedCount;

    // ── Durably record only the observations that were genuinely new ───
    const newEvents = decisions
      .filter((decision) => decision.applied)
      .map((decision) => decision.event);
    let persisted = true;
    if (newEvents.length > 0) {
      const written = await ingestMicroEvents(mcp, newEvents);
      persisted = written.ok;
      if (!persisted) {
        log(`[integrity] [${requestId}] Telemetry persistence failed: ${written.error ?? "unknown"}`);
      }
    }

    // The durable submission snapshot is what a reviewer actually reads. Write
    // it back when the batch changed the code — but only while the session is
    // still in progress. Once a session is settled (submitted, flagged,
    // evaluated or terminated) its persisted snapshot is frozen and stays
    // authoritative, so late telemetry can never rewrite a reviewed submission.
    let codePersisted = true;
    if (session.currentCode !== codeBeforeBatch) {
      if (session.submitted || session.status !== "in_progress") {
        session.currentCode = codeBeforeBatch;
        sessions.set(session);
      } else {
        const written = await updateSessionCode(mcp, sessionId, session.currentCode);
        codePersisted = written.ok && written.data?.updated !== false;
        if (!codePersisted) {
          log(
            `[integrity] [${requestId}] Code snapshot persistence failed: ${
              written.error ?? "the session record was not updated"
            }`,
          );
        }
      }
    }

    // ── Decide whether an AI integrity pass is warranted ─────────
    let integrityReport: IntegrityReport | null = null;
    let alertTriggered = false;

    if (shouldAnalyze(session, config.integrity)) {
      const codeHash = await sha256(session.currentCode);
      if (codeHash === session.lastAnalyzedCodeHash && session.lastIntegrityReport) {
        log(
          `[integrity] [${requestId}] Submission unchanged since last analysis; reusing the previous report.`,
        );
        integrityReport = session.lastIntegrityReport;
      } else {
        try {
          const keystrokeMetrics = computeKeystrokeMetrics(session.keystrokeDeltas);
          const pasteContents = session.events
            .filter((event) => event.eventType === "PASTE_TRIGGER" && event.payload?.pasteContent)
            .map((event) => event.payload.pasteContent as string);

          const analysed = await ai.analyzeIntegrity(
            session.currentCode,
            pasteContents,
            keystrokeMetrics,
            [],
          );

          integrityReport = {
            ...analysed,
            integrityReportId: analysed.integrityReportId || crypto.randomUUID(),
            sessionId,
            candidateId: session.candidateId,
            assessmentId: session.assessmentId,
            keystrokeMetrics,
            generatedAt: analysed.generatedAt || nowIso(),
          };

          session.lastIntegrityReport = integrityReport;
          session.lastAnalyzedCodeHash = codeHash;
          sessions.set(session);

          const stored = await storeIntegrityReport(mcp, integrityReport);
          if (!stored.ok) {
            log(
              `[integrity] [${requestId}] Report persistence failed: ${stored.error ?? "unknown"}`,
            );
          }
        } catch (error) {
          // A model outage degrades the signal but must not reject telemetry the
          // server has already durably accepted.
          log(
            `[integrity] [${requestId}] Integrity analysis unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    if (integrityReport) {
      alertTriggered = integrityReport.overallScore > config.integrity.alertScoreThreshold;
    }

    log(
      `[integrity] [${requestId}] Ingested ${appliedCount}/${events.length} events ` +
        `(duplicates=${duplicateCount}) persisted=${persisted} score=${integrityReport?.overallScore ?? "n/a"}`,
    );

    return c.json({
      success: true,
      processedCount: appliedCount,
      duplicateCount,
      persisted,
      codePersisted,
      integrityReport,
      alertTriggered,
      correlationId: requestId,
    });
  });

  // ── GET /sessions/:sessionId ───────────────────────────────────
  router.get("/sessions/:sessionId", requireOperator(), (c) => {
    const sessionId = c.req.param("sessionId");
    const session = sessions.get(sessionId);
    if (!session) {
      return c.json({ success: false, error: "No live session with that id." }, 404);
    }
    return c.json({ success: true, session: sessionSummary(session) });
  });

  // ── DELETE /sessions/:sessionId ────────────────────────────────
  router.delete("/sessions/:sessionId", requireOperator(), async (c) => {
    const sessionId = c.req.param("sessionId");
    const requestId = c.get("correlationId") ?? crypto.randomUUID();

    const deleted = await deleteSession(mcp, sessionId);
    sessions.delete(sessionId);

    if (!deleted.ok) {
      log(`[integrity] [${requestId}] Termination persistence failed: ${deleted.error ?? "unknown"}`);
      return c.json(
        {
          success: false,
          error: "The session could not be terminated in the assessment store.",
          correlationId: requestId,
        },
        502,
      );
    }

    log(`[integrity] [${requestId}] Session ${sessionId} terminated and removed.`);
    return c.json({ success: true, sessionId, deleted: true, correlationId: requestId });
  });

  return router;
}

// ─── Session resolution ────────────────────────────────────────────

type Resolution =
  | { ok: true; session: SessionState }
  | { ok: false; error: string };

/**
 * Returns the live projection for a session, creating it when the session is
 * genuinely new and recovering it from the persisted record when this process
 * has simply never seen it (for example after a restart).
 */
async function resolveSession(
  sessionId: string,
  events: readonly MicroEvent[],
  deps: ApiDependencies,
  requestId: string,
): Promise<Resolution> {
  const { mcp, sessions, log } = deps;

  const existing = sessions.get(sessionId);
  if (existing) return { ok: true, session: existing };

  const seedEvent = events[0]!;

  // Recovery path: is this a session that already exists in the store?
  const review = await fetchSessionReview(mcp, sessionId);

  if (!review.ok) {
    // The store is unreachable. Creating an in-memory projection would silently
    // drop the durable session, so fail rather than corrupt the record.
    return {
      ok: false,
      error: "The assessment store is unavailable; telemetry was not accepted.",
    };
  }

  if (review.data?.session) {
    const storedEvents = (review.data.events ?? []).map((event) => ({
      eventId: "",
      sessionId,
      candidateId: review.data?.session?.candidateId ?? seedEvent.candidateId,
      assessmentId: review.data?.session?.assessmentId ?? seedEvent.assessmentId,
      problemId: "",
      eventType: event.eventType,
      timestamp: event.timestamp,
      payload: (event.payload ?? {}) as MicroEvent["payload"],
      clientMetadata: {
        userAgent: "",
        ipAddress: "",
        screenResolution: "",
        platform: "",
        language: "",
      },
    })) as MicroEvent[];

    const recovered = hydrateFromPersisted({
      session: {
        sessionId,
        candidateId: review.data.session.candidateId,
        assessmentId: review.data.session.assessmentId,
        status: review.data.session.status,
        submittedCode: review.data.session.submittedCode,
      },
      events: storedEvents,
    });

    sessions.set(recovered);
    log(
      `[integrity] [${requestId}] Recovered session ${sessionId} from the store ` +
        `(${recovered.events.length} stored events).`,
    );
    return { ok: true, session: recovered };
  }

  // Genuinely new session: register durably, then project it.
  const created = await createSession(mcp, {
    sessionId,
    candidateId: seedEvent.candidateId,
    assessmentId: seedEvent.assessmentId,
    ...(seedEvent.problemId ? { problemId: seedEvent.problemId } : {}),
  });

  if (!created.ok) {
    return {
      ok: false,
      error: "The assessment session could not be created; telemetry was not accepted.",
    };
  }

  const fresh = createSessionState({
    sessionId,
    candidateId: seedEvent.candidateId,
    assessmentId: seedEvent.assessmentId,
    problemId: seedEvent.problemId,
  });
  sessions.set(fresh);
  log(`[integrity] [${requestId}] Opened new session ${sessionId}.`);
  return { ok: true, session: fresh };
}

function sessionSummary(session: SessionState): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    candidateId: session.candidateId,
    assessmentId: session.assessmentId,
    status: session.status,
    eventCount: session.events.length,
    pasteCount: session.pasteCount,
    tabSwitchCount: session.tabSwitchCount,
    windowBlurCount: session.windowBlurCount,
    fullscreenExitCount: session.fullscreenExitCount,
    copyAttemptCount: session.copyAttemptCount,
    devToolsOpenCount: session.devToolsOpenCount,
    currentCodeLength: session.currentCode.length,
    submitted: session.submitted,
    recoveredFromStore: session.recoveredFromStore,
    lastIntegrityReport: session.lastIntegrityReport,
  };
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
