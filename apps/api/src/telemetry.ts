/**
 * Telemetry event validation.
 *
 * Candidate clients are untrusted input sources. Every event is normalised and
 * bounded here before it can influence an integrity signal, so a malformed or
 * hostile payload cannot inflate counters or bloat storage.
 */

import type { ClientMetadata, MicroEvent, MicroEventPayload, MicroEventType } from "./types.js";

/** Hard bound on one ingestion batch. */
export const MAX_EVENTS_PER_BATCH = 500;

/** Maximum stored size for any single free-text telemetry field. */
export const MAX_PAYLOAD_TEXT_LENGTH = 20_000;

/**
 * Maximum free text accepted across one batch, counted in characters.
 *
 * Without this, the documented per-field and per-batch caps compose into roughly
 * 30 MB of legitimate content for a single request — 500 events × three
 * free-text fields × 20,000 characters — which is not a bound anyone intended.
 * This makes the batch-level limit explicit and keeps it comfortably inside the
 * request-body ceiling, even allowing for multi-byte characters and JSON
 * escaping.
 */
export const MAX_BATCH_TEXT_LENGTH = 500_000;

/** Free-text payload fields counted against the batch budget. */
const TEXT_FIELDS = ["pasteContent", "selectedText", "diffPatch"] as const;

/** Characters of free text carried by one raw event, before truncation. */
function rawTextLength(source: Record<string, unknown>): number {
  const payload = source["payload"];
  if (payload === null || typeof payload !== "object") return 0;

  const fields = payload as Record<string, unknown>;
  let total = 0;
  for (const field of TEXT_FIELDS) {
    const value = fields[field];
    if (typeof value === "string") total += value.length;
  }
  return total;
}

const EVENT_TYPES: readonly MicroEventType[] = [
  "KEYSTROKE",
  "PASTE_TRIGGER",
  "CODE_DELTA",
  "TAB_SWITCH",
  "WINDOW_BLUR",
  "COPY_ATTEMPT",
  "DEVELOPER_TOOLS_OPEN",
  "FULLSCREEN_EXIT",
  "SUBMIT",
];

export interface EventValidationFailure {
  ok: false;
  error: string;
  index?: number;
}

export interface EventValidationSuccess {
  ok: true;
  events: MicroEvent[];
  sessionId: string;
}

export type EventValidation = EventValidationSuccess | EventValidationFailure;

function clampText(value: unknown, maxLength = MAX_PAYLOAD_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isEventType(value: unknown): value is MicroEventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

function normalisePayload(raw: unknown): MicroEventPayload {
  if (raw === null || typeof raw !== "object") return {};
  const source = raw as Record<string, unknown>;
  const payload: MicroEventPayload = {};

  const char = clampText(source["char"], 16);
  if (char !== undefined) payload.char = char;

  if (typeof source["deltaMs"] === "number" && Number.isFinite(source["deltaMs"])) {
    payload.deltaMs = Math.max(0, source["deltaMs"]);
  }

  const diffPatch = clampText(source["diffPatch"]);
  if (diffPatch !== undefined) payload.diffPatch = diffPatch;

  const pasteContent = clampText(source["pasteContent"]);
  if (pasteContent !== undefined) payload.pasteContent = pasteContent;

  const selectedText = clampText(source["selectedText"]);
  if (selectedText !== undefined) payload.selectedText = selectedText;

  if (source["visibilityState"] === "visible" || source["visibilityState"] === "hidden") {
    payload.visibilityState = source["visibilityState"];
  }
  if (typeof source["devToolsOpen"] === "boolean") {
    payload.devToolsOpen = source["devToolsOpen"];
  }

  return payload;
}

function normaliseClientMetadata(raw: unknown): ClientMetadata {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    userAgent: clampText(source["userAgent"], 512) ?? "",
    ipAddress: clampText(source["ipAddress"], 64) ?? "",
    screenResolution: clampText(source["screenResolution"], 32) ?? "",
    platform: clampText(source["platform"], 64) ?? "",
    language: clampText(source["language"], 32) ?? "",
  };
}

function requireNonEmptyString(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 200);
}

/** Validates a candidate timestamp, defaulting to server time when unusable. */
function normaliseTimestamp(raw: unknown): string {
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      // Normalise to UTC ISO-8601 so timelines stay comparable across regions.
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

/**
 * Validates an ingestion body. All events must belong to one session and one
 * candidate, because the in-memory projection, the alert threshold and the
 * authorization decision are all per-session and per-candidate.
 *
 * The single-candidate rule is an authorization boundary, not a tidiness rule:
 * the route decides who a batch belongs to from the batch itself, so a batch
 * that named two candidates could be used to attribute forged events to someone
 * else.
 */
export function validateIngestRequest(body: unknown): EventValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const rawEvents = (body as Record<string, unknown>)["events"];
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return { ok: false, error: "Field 'events' must be a non-empty array." };
  }
  if (rawEvents.length > MAX_EVENTS_PER_BATCH) {
    return {
      ok: false,
      error: `Field 'events' must contain at most ${MAX_EVENTS_PER_BATCH} events per batch.`,
    };
  }

  const events: MicroEvent[] = [];
  let sessionId: string | null = null;
  let candidateId: string | null = null;
  let batchTextLength = 0;

  for (let index = 0; index < rawEvents.length; index += 1) {
    const raw = rawEvents[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: "Each event must be a JSON object.", index };
    }
    const source = raw as Record<string, unknown>;

    // Counted before anything else so an oversized batch is rejected on a cheap
    // character count rather than after it has been normalised and stored.
    batchTextLength += rawTextLength(source);
    if (batchTextLength > MAX_BATCH_TEXT_LENGTH) {
      return {
        ok: false,
        error:
          `Free text across one batch must not exceed ${MAX_BATCH_TEXT_LENGTH} characters. ` +
          "Send fewer events, or split the batch.",
        index,
      };
    }

    const eventSessionId = requireNonEmptyString(source, "sessionId");
    if (!eventSessionId) {
      return { ok: false, error: "Each event requires a non-empty 'sessionId'.", index };
    }
    if (sessionId === null) {
      sessionId = eventSessionId;
    } else if (sessionId !== eventSessionId) {
      return {
        ok: false,
        error: "All events in one batch must belong to the same session.",
        index,
      };
    }

    const candidateIdValue = requireNonEmptyString(source, "candidateId");
    if (!candidateIdValue) {
      return { ok: false, error: "Each event requires a non-empty 'candidateId'.", index };
    }
    if (candidateId === null) {
      candidateId = candidateIdValue;
    } else if (candidateId !== candidateIdValue) {
      return {
        ok: false,
        error: "All events in one batch must belong to the same candidate.",
        index,
      };
    }

    const assessmentId = requireNonEmptyString(source, "assessmentId");
    if (!assessmentId) {
      return { ok: false, error: "Each event requires a non-empty 'assessmentId'.", index };
    }

    if (!isEventType(source["eventType"])) {
      return {
        ok: false,
        error: `Unsupported 'eventType'. Expected one of: ${EVENT_TYPES.join(", ")}.`,
        index,
      };
    }

    events.push({
      eventId: requireNonEmptyString(source, "eventId") ?? crypto.randomUUID(),
      sessionId: eventSessionId,
      candidateId: candidateIdValue,
      assessmentId,
      problemId: requireNonEmptyString(source, "problemId") ?? "",
      eventType: source["eventType"],
      timestamp: normaliseTimestamp(source["timestamp"]),
      payload: normalisePayload(source["payload"]),
      clientMetadata: normaliseClientMetadata(source["clientMetadata"]),
    });
  }

  return { ok: true, events, sessionId: sessionId as string };
}

export const SUPPORTED_EVENT_TYPES = EVENT_TYPES;
