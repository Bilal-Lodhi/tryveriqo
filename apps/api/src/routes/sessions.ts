/**
 * Session review routes (reviewer console).
 *
 *   GET /api/v1/sessions                       — reviewable session list
 *   GET /api/v1/sessions/:sessionId/review      — full review payload
 *
 * Both endpoints expose candidate-personal data and are limited to the operator
 * credential.
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type {
  IntegrityReport,
  SessionReviewResponse,
  SessionSummary,
  SessionStatus,
  TimelineEntry,
} from "../types.js";
import {
  requireAuth,
  requireCandidateAccessAsync,
  requireOperator,
  type AppEnv,
} from "../middleware/auth.js";
import { fetchSessionReview, listSessions, type SessionReviewData } from "../mcp-client.js";
import { REVIEW_EVENT_LIMIT_MAX } from "@assessment/mcp-mongodb";
import { finiteScore, isUsableScore, selectLatestReport } from "../integrity-report.js";
import { nowIso } from "../utils/time.js";
import type { ApiDependencies } from "./dependencies.js";

/**
 * Reads an optional bounded integer from the query string.
 *
 * Returns `undefined` when absent, `"invalid"` when present but unusable. A
 * malformed value is an error rather than a silent default: substituting a page
 * size the caller did not ask for would make the disclosure below a lie.
 */
function readBoundedIntQuery(
  c: Context<AppEnv>,
  name: string,
  bounds: { min: number; max: number },
): number | undefined | "invalid" {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) return "invalid";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < bounds.min || parsed > bounds.max) return "invalid";
  return parsed;
}

export function sessionRoutes(deps: ApiDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { mcp, config, log } = deps;
  const alertThreshold = config.integrity.alertScoreThreshold;

  // ── GET / ──────────────────────────────────────────────────────
  // The reviewable session list spans all candidates, so it is
  // operator-only: no candidate credential may enumerate the cohort.
  router.get("/", requireOperator(), async (c) => {
    const requestId = c.get("correlationId") ?? crypto.randomUUID();
    const listed = await listSessions(mcp);

    if (!listed.ok || !listed.data?.data) {
      if (listed.error) {
        log(`[sessions] [${requestId}] Session list unavailable: ${listed.error}`);
      }
      // A degraded list is preferable to a failed console, and the console
      // retries on refresh.
      return c.json({ success: true, data: [] satisfies SessionSummary[], degraded: true });
    }

    const summaries = await Promise.all(
      listed.data.data.map(async (session) => {
        const review = await fetchSessionReview(mcp, session.sessionId);
        return summarise(session, review.ok ? review.data : null, alertThreshold);
      }),
    );

    return c.json({ success: true, data: summaries, degraded: false });
  });

  // ── GET /:sessionId/review ─────────────────────────────────────
  // The owner of the review is the candidate the session belongs to, so
  // ownership is resolved from the stored session rather than from the caller.
  const candidateOwnedBy = async (c: Context<AppEnv>): Promise<string | null> => {
    const sessionId = c.req.param("sessionId");
    if (!sessionId) return null;
    // Ownership needs only the session record, so ask for the smallest possible
    // page rather than pulling a full timeline just to read one field.
    const review = await fetchSessionReview(mcp, sessionId, { eventLimit: 1 });
    return review.data?.session?.candidateId ?? null;
  };

  router.get(
    "/:sessionId/review",
    requireAuth(),
    requireCandidateAccessAsync(candidateOwnedBy),
    async (c) => {
      const sessionId = c.req.param("sessionId");
      const requestId = c.get("correlationId") ?? crypto.randomUUID();

      // Paging is validated before the store is touched, so a malformed request
      // is a 400 rather than a silently different page size.
      const eventLimit = readBoundedIntQuery(c, "eventLimit", {
        min: 1,
        max: REVIEW_EVENT_LIMIT_MAX,
      });
      if (eventLimit === "invalid") {
        return c.json(
          {
            success: false,
            error: `Query parameter 'eventLimit' must be an integer between 1 and ${REVIEW_EVENT_LIMIT_MAX}.`,
          },
          400,
        );
      }
      const eventOffset = readBoundedIntQuery(c, "eventOffset", {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      });
      if (eventOffset === "invalid") {
        return c.json(
          { success: false, error: "Query parameter 'eventOffset' must be a non-negative integer." },
          400,
        );
      }

      const review = await fetchSessionReview(mcp, sessionId, {
        ...(eventLimit === undefined ? {} : { eventLimit }),
        ...(eventOffset === undefined ? {} : { eventOffset }),
      });
      if (!review.ok) {
        log(`[sessions] [${requestId}] Review unavailable: ${review.error ?? "unknown"}`);
        return c.json({ success: false, error: "The assessment store is unavailable." }, 502);
      }

      const data = review.data;
      if (!data?.session) {
        return c.json({ success: false, error: `Session '${sessionId}' was not found.` }, 404);
      }

      const events = data.events ?? [];
      const reports = data.integrityReports ?? [];

      const timeline = events.map(toTimelineEntry).sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      // A reviewer must never be shown a partial timeline as though it were the
      // whole one. `timelineTotal` comes from the store's own count, not from the
      // length of the page, so this cannot silently drift.
      const timelineReturned = data.eventsReturned ?? events.length;
      const timelineTotal = data.eventTotal ?? timelineReturned;
      const timelineTruncated = data.eventsTruncated ?? timelineTotal > timelineReturned;
      const nextEventOffset =
        data.nextEventOffset ?? (timelineTruncated ? timelineReturned : null);

      const integritySummary = reports.map((report) => toIntegrityReport(report, data));
      // Select by newest `generatedAt`, never by array position: the store
      // returns reports newest-first, so a positional pick would hand the
      // reviewer the OLDEST score and flags for this session.
      const latestDocument = selectLatestReport(reports);
      const latest = latestDocument ? toIntegrityReport(latestDocument, data) : null;
      const hasSubmission = events.some((event) => event.eventType === "SUBMIT");
      const status = deriveStatus(data.session.status, hasSubmission, latest, alertThreshold);
      // An unusable stored score yields no provisional score at all. Defaulting
      // it to zero would display a confident 100 for a session whose analysis
      // data is malformed, which is exactly the misreading this route must avoid.
      const scoreUsable = latestDocument !== null && isUsableScore(latestDocument["overallScore"]);

      const response: SessionReviewResponse = {
        sessionId: data.session.sessionId,
        candidateId: data.session.candidateId,
        assessmentId: data.session.assessmentId,
        status,
        submittedCode: data.session.submittedCode ?? "",
        timeline,
        integritySummary,
        // A provisional score: the review is assistance for a human reviewer, and
        // the final assessment score remains a reviewer decision.
        finalScore:
          hasSubmission && latest && scoreUsable
            ? Math.max(0, 100 - latest.overallScore)
            : null,
        timelineTotal,
        timelineReturned,
        timelineTruncated,
        nextEventOffset,
      };

      return c.json({ success: true, data: response });
    },
  );

  return router;
}

// ─── Mapping helpers ───────────────────────────────────────────────

function summarise(
  session: {
    sessionId: string;
    candidateId: string;
    assessmentId: string;
    status: string;
    createdAt?: string;
    updatedAt?: string;
  },
  review: SessionReviewData | null,
  alertThreshold: number,
): SessionSummary {
  const events = review?.events ?? [];
  const reports = review?.integrityReports ?? [];

  const lastEventTimestamp =
    events.length > 0
      ? events
          .map((event) => event.timestamp)
          .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null
      : (session.updatedAt ?? null);

  const latestScore = finiteScore(selectLatestReport(reports)?.["overallScore"]);

  // The cohort list samples one page per session, so the counts below are
  // derived from a page whenever the session is longer than that page.
  // `eventCount` uses the store's true total; the per-type counts cannot, because
  // counting each type separately would add a query per type per session to a
  // list that already fans out one call per session. They are disclosed as
  // sampled instead of being presented as totals.
  const eventCount = review?.eventTotal ?? events.length;
  const countsSampled = review?.eventsTruncated ?? eventCount > events.length;

  return {
    sessionId: session.sessionId,
    candidateId: session.candidateId,
    assessmentId: session.assessmentId,
    status: deriveStatus(
      session.status,
      events.some((event) => event.eventType === "SUBMIT"),
      null,
      alertThreshold,
    ),
    eventCount,
    pasteCount: events.filter((event) => event.eventType === "PASTE_TRIGGER").length,
    tabSwitchCount: events.filter(
      (event) => event.eventType === "TAB_SWITCH" || event.eventType === "WINDOW_BLUR",
    ).length,
    integrityScore: latestScore,
    lastEventTimestamp,
    countsSampled,
  };
}

function toTimelineEntry(event: {
  eventType: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}): TimelineEntry {
  const payload = event.payload ?? {};
  let severity: TimelineEntry["severity"] = "info";
  let label = event.eventType;
  let detail = "";

  switch (event.eventType) {
    case "KEYSTROKE": {
      label = "Keystroke";
      const delta = payload["deltaMs"];
      detail = typeof delta === "number" ? `${delta}ms since previous keystroke` : "Keystroke";
      if (typeof delta === "number" && delta < 80) severity = "warning";
      break;
    }
    case "PASTE_TRIGGER": {
      label = "Paste";
      const content = payload["pasteContent"];
      detail = `Pasted ${typeof content === "string" ? content.length : 0} characters`;
      severity = "critical";
      break;
    }
    case "CODE_DELTA": {
      label = "Code change";
      const patch = payload["diffPatch"];
      detail = `Patch of ${typeof patch === "string" ? patch.length : 0} characters`;
      break;
    }
    case "TAB_SWITCH": {
      label = "Tab switch";
      detail = `Visibility: ${String(payload["visibilityState"] ?? "unknown")}`;
      severity = "warning";
      break;
    }
    case "WINDOW_BLUR":
      label = "Window blur";
      detail = "Focus left the assessment window";
      severity = "warning";
      break;
    case "COPY_ATTEMPT": {
      label = "Copy attempt";
      const selected = payload["selectedText"];
      detail = `Copied ${typeof selected === "string" ? selected.length : 0} characters`;
      severity = "critical";
      break;
    }
    case "DEVELOPER_TOOLS_OPEN":
      label = "Developer tools opened";
      severity = "critical";
      break;
    case "FULLSCREEN_EXIT":
      label = "Fullscreen exited";
      severity = "critical";
      break;
    case "SUBMIT":
      label = "Submission";
      detail = "Candidate submitted their answer";
      break;
  }

  return { timestamp: event.timestamp, eventType: event.eventType, label, severity, detail };
}

/**
 * Rebuilds a structured integrity report from its stored document.
 *
 * Structured flag objects are preserved verbatim. Reports written by earlier
 * versions stored flags as bare strings, and those are widened into the
 * structured shape so the review UI never has to branch on shape.
 */
function toIntegrityReport(
  raw: Record<string, unknown>,
  data: SessionReviewData,
): IntegrityReport {
  const rawFlags = Array.isArray(raw["flags"]) ? (raw["flags"] as unknown[]) : [];
  const generatedAt = String(raw["generatedAt"] ?? nowIso());

  const flags = rawFlags.map((flag) => {
    if (typeof flag === "string") {
      return {
        flagType: flag,
        severity: "medium" as const,
        sourceEventId: "",
        description: flag,
        confidence: 0.5,
        timestamp: generatedAt,
      };
    }
    const source = (flag ?? {}) as Record<string, unknown>;
    return {
      flagType: String(source["flagType"] ?? "UNKNOWN"),
      severity: (["low", "medium", "high", "critical"] as const).includes(
        source["severity"] as "low",
      )
        ? (source["severity"] as "low" | "medium" | "high" | "critical")
        : ("medium" as const),
      sourceEventId: String(source["sourceEventId"] ?? ""),
      description: String(source["description"] ?? source["flagType"] ?? ""),
      confidence: typeof source["confidence"] === "number" ? source["confidence"] : 0.5,
      timestamp: String(source["timestamp"] ?? generatedAt),
    };
  });

  return {
    integrityReportId: String(raw["integrityReportId"] ?? raw["_id"] ?? crypto.randomUUID()),
    sessionId: String(raw["sessionId"] ?? data.session?.sessionId ?? ""),
    candidateId: String(raw["candidateId"] ?? data.session?.candidateId ?? ""),
    assessmentId: String(raw["assessmentId"] ?? data.session?.assessmentId ?? ""),
    overallScore: finiteScore(raw["overallScore"]),
    flags,
    plagiarismReport:
      (raw["plagiarismReport"] as IntegrityReport["plagiarismReport"] | undefined) ?? null,
    behavioralAnomalies:
      (raw["behavioralAnomalies"] as IntegrityReport["behavioralAnomalies"] | undefined) ?? [],
    ...(raw["keystrokeMetrics"]
      ? { keystrokeMetrics: raw["keystrokeMetrics"] as IntegrityReport["keystrokeMetrics"] }
      : {}),
    generatedAt,
  };
}

function deriveStatus(
  rawStatus: string | undefined,
  hasSubmission: boolean,
  latest: IntegrityReport | null,
  alertThreshold: number,
): SessionStatus {
  if (rawStatus === "terminated" || rawStatus === "evaluated") return rawStatus;

  const flagged = latest !== null && latest.overallScore > alertThreshold;
  if (hasSubmission && flagged) return "flagged";
  if (hasSubmission) return "submitted";
  if (flagged) return "flagged";

  switch (rawStatus) {
    case "in_progress":
    case "submitted":
    case "flagged":
      return rawStatus;
    default:
      return "in_progress";
  }
}
