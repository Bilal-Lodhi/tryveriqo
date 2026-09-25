/**
 * In-memory candidate session state for integrity analysis.
 *
 * The API keeps a live, per-process projection of each active candidate
 * session so that suspicion thresholds can be evaluated on every ingested
 * telemetry batch without a database round trip on the hot path. MongoDB (via
 * the MCP tool surface) remains the durable record.
 *
 * Two reliability behaviours live here, both adopted from the post-baseline
 * product history and restated in Assessment terms:
 *   - duplicate suppression: identical telemetry replayed by a retrying client
 *     must not inflate integrity counters;
 *   - post-restart recovery: a session whose in-memory projection was lost when
 *     the process restarted is rehydrated from its persisted record instead of
 *     being silently recreated as empty.
 *
 * Everything in this module is pure state manipulation: no network, no clocks
 * other than the caller-supplied `now`, so it is directly testable.
 */

import type {
  IntegrityReport,
  KeystrokeMetrics,
  MicroEvent,
  SessionStatus,
} from "./types.js";

export interface SessionState {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  problemId: string;
  status: SessionStatus;
  /** Live code snapshot reconstructed from telemetry. */
  currentCode: string;
  /**
   * The most recent observations, bounded by `MAX_RETAINED_EVENTS`.
   *
   * This is a working window, not the record: the durable telemetry in MongoDB is
   * what a reviewer reads, and it is never trimmed. Use `eventsObserved` for the
   * true count.
   */
  events: MicroEvent[];
  /** True number of observations ever folded in, never reduced by trimming. */
  eventsObserved: number;
  pasteCount: number;
  /** Recent keystroke deltas, bounded by `MAX_RETAINED_KEYSTROKES`. */
  keystrokeDeltas: number[];
  /** True number of keystroke samples ever folded in. */
  keystrokeObservations: number;
  /**
   * Recent pasted content, bounded by `MAX_RETAINED_PASTES`.
   *
   * Kept separately from `events` so that trimming the event window cannot change
   * what an integrity analysis is shown, and vice versa.
   */
  recentPasteContents: string[];
  /** True number of paste observations ever folded in. */
  pasteObservations: number;
  tabSwitchCount: number;
  windowBlurCount: number;
  fullscreenExitCount: number;
  copyAttemptCount: number;
  devToolsOpenCount: number;
  submitted: boolean;
  lastIntegrityReport: IntegrityReport | null;
  /** SHA-256 of `currentCode` at the last AI analysis; suppresses repeat calls. */
  lastAnalyzedCodeHash: string;
  /** Fingerprints of recently seen events, for duplicate suppression. */
  recentEventFingerprints: Set<string>;
  /** True when this projection was rebuilt from the persisted record. */
  recoveredFromStore: boolean;
  /**
   * True when the recovery page was itself truncated, so the retained *windows*
   * were rebuilt from part of the stored history rather than all of it.
   */
  recoveredPartially: boolean;
  /**
   * True when the counters that feed analysis thresholds are exact totals.
   *
   * False on a projection rebuilt by replaying a truncated page with no exact
   * counts supplied: its counters then describe the page, not the record, and
   * thresholds can under-trigger. Recorded so that is visible rather than
   * implied.
   */
  countersExact: boolean;
  /**
   * Epoch milliseconds of the most recent observation folded into this
   * projection, or 0 when it has never been observed. This is what the
   * `SESSION_TTL_SECONDS` staleness horizon is measured against.
   */
  lastActivityAt: number;
}

/** Maximum fingerprints retained per session. */
export const FINGERPRINT_WINDOW = 128;

/**
 * Retained-observation windows.
 *
 * The projection exists so thresholds can be evaluated on the ingestion hot path
 * without a datastore round trip. Nothing bounded its arrays before, so a session
 * that kept receiving distinct telemetry grew them without limit — duplicate
 * suppression does not help, because genuinely distinct observations are exactly
 * what grows them. These windows bound the footprint; the counters beside them
 * stay true totals, and stored telemetry remains authoritative for review.
 */
export const MAX_RETAINED_EVENTS = 1000;
export const MAX_RETAINED_KEYSTROKES = 2000;
export const MAX_RETAINED_PASTES = 50;

/** Keeps the newest `max` entries, dropping the oldest. */
function trimToWindow<T>(list: T[], max: number): void {
  if (list.length > max) list.splice(0, list.length - max);
}

export function createSessionState(seed: {
  sessionId: string;
  candidateId: string;
  assessmentId: string;
  problemId?: string;
  status?: SessionStatus;
  currentCode?: string;
  recoveredFromStore?: boolean;
  lastActivityAt?: number;
}): SessionState {
  return {
    sessionId: seed.sessionId,
    candidateId: seed.candidateId,
    assessmentId: seed.assessmentId,
    problemId: seed.problemId ?? "",
    status: seed.status ?? "in_progress",
    currentCode: seed.currentCode ?? "",
    events: [],
    eventsObserved: 0,
    pasteCount: 0,
    keystrokeDeltas: [],
    keystrokeObservations: 0,
    recentPasteContents: [],
    pasteObservations: 0,
    tabSwitchCount: 0,
    windowBlurCount: 0,
    fullscreenExitCount: 0,
    copyAttemptCount: 0,
    devToolsOpenCount: 0,
    submitted: isSettledStatus(seed.status ?? "in_progress"),
    lastIntegrityReport: null,
    lastAnalyzedCodeHash: "",
    recentEventFingerprints: new Set<string>(),
    recoveredFromStore: seed.recoveredFromStore ?? false,
    recoveredPartially: false,
    // A fresh projection accumulates real totals as it goes, so its counters are
    // exact by construction.
    countersExact: true,
    lastActivityAt: seed.lastActivityAt ?? 0,
  };
}

/**
 * True for the statuses in which the candidate's answer is already final. A
 * settled session must never be re-analysed, and its persisted code snapshot is
 * frozen, so `submitted` is derived from the status rather than tracked
 * separately on every reconstruction path.
 */
export function isSettledStatus(status: SessionStatus): boolean {
  return status === "submitted" || status === "flagged" || status === "evaluated";
}

/**
 * Fingerprint used for duplicate suppression.
 *
 * `eventId` is excluded, because a retrying client re-serialises the same batch
 * with fresh ids. The observation time is included at one-second granularity: a
 * genuine replay carries its original timestamp and collapses to the same
 * fingerprint, while two distinct real-world observations (for example two tab
 * switches a few seconds apart) stay distinguishable.
 */
export function eventFingerprint(event: MicroEvent): string {
  const payload = event.payload ?? {};
  const parsed = new Date(event.timestamp);
  const timeBucket = Number.isNaN(parsed.getTime())
    ? String(event.timestamp)
    : String(Math.floor(parsed.getTime() / 1000));

  const material = [
    event.eventType,
    String(event.problemId ?? ""),
    timeBucket,
    String(payload.char ?? ""),
    String(payload.pasteContent ?? "").slice(0, 512),
    String(payload.selectedText ?? "").slice(0, 512),
    String(payload.diffPatch ?? "").slice(0, 512),
    payload.deltaMs === undefined ? "" : String(Math.round(payload.deltaMs / 10) * 10),
    payload.visibilityState ?? "",
    payload.devToolsOpen === undefined ? "" : String(payload.devToolsOpen),
  ];
  return material.join("\u0001");
}

export interface ApplyEventOutcome {
  applied: boolean;
  duplicate: boolean;
}

/** True when the same observation has already been folded into this session. */
export function isDuplicateEvent(session: SessionState, event: MicroEvent): boolean {
  return session.recentEventFingerprints.has(eventFingerprint(event));
}

function rememberFingerprint(session: SessionState, fingerprint: string): void {
  session.recentEventFingerprints.add(fingerprint);
  if (session.recentEventFingerprints.size > FINGERPRINT_WINDOW) {
    const retained = [...session.recentEventFingerprints].slice(-FINGERPRINT_WINDOW);
    session.recentEventFingerprints = new Set(retained);
  }
}

/**
 * Folds one telemetry event into a session projection.
 * Duplicate events are dropped without touching any counter.
 *
 * `now` is supplied by the caller rather than read from a clock here, so the
 * staleness horizon is testable without sleeping.
 */
export function applyEvent(session: SessionState, event: MicroEvent, now?: number): ApplyEventOutcome {
  const fingerprint = eventFingerprint(event);
  if (session.recentEventFingerprints.has(fingerprint)) {
    return { applied: false, duplicate: true };
  }

  // The true total is incremented before any trimming, so it stays a total even
  // once the working window is full.
  session.eventsObserved += 1;
  session.events.push(event);
  trimToWindow(session.events, MAX_RETAINED_EVENTS);
  if (typeof now === "number" && Number.isFinite(now)) {
    session.lastActivityAt = now;
  }

  switch (event.eventType) {
    case "KEYSTROKE":
      if (typeof event.payload?.deltaMs === "number") {
        session.keystrokeObservations += 1;
        session.keystrokeDeltas.push(event.payload.deltaMs);
        trimToWindow(session.keystrokeDeltas, MAX_RETAINED_KEYSTROKES);
      }
      break;

    case "PASTE_TRIGGER":
      session.pasteCount += 1;
      if (event.payload?.pasteContent) {
        session.pasteObservations += 1;
        session.recentPasteContents.push(event.payload.pasteContent);
        trimToWindow(session.recentPasteContents, MAX_RETAINED_PASTES);
        session.currentCode += event.payload.pasteContent;
      }
      break;

    case "CODE_DELTA":
      if (event.payload?.diffPatch) {
        session.currentCode = applyDiffPatch(session.currentCode, event.payload.diffPatch);
      }
      break;

    case "TAB_SWITCH":
      session.tabSwitchCount += 1;
      break;

    case "WINDOW_BLUR":
      session.windowBlurCount += 1;
      break;

    case "FULLSCREEN_EXIT":
      session.fullscreenExitCount += 1;
      break;

    case "COPY_ATTEMPT":
      session.copyAttemptCount += 1;
      break;

    case "DEVELOPER_TOOLS_OPEN":
      session.devToolsOpenCount += 1;
      break;

    case "SUBMIT":
      session.submitted = true;
      session.status = "submitted";
      // A submission event carries the final snapshot of the candidate's code.
      if (event.payload?.pasteContent) {
        session.currentCode = event.payload.pasteContent;
      }
      break;
  }

  rememberFingerprint(session, fingerprint);
  return { applied: true, duplicate: false };
}

export interface EventDecision {
  event: MicroEvent;
  applied: boolean;
  duplicate: boolean;
}

/**
 * Decides each event's fate and folds the new ones into the session.
 *
 * Returns the decision for every input event, in order, so a caller can persist
 * exactly the observations that were genuinely new. That matters: the reviewer
 * timeline is built from stored telemetry, so persisting a suppressed replay
 * would show the same action twice.
 */
export function decideAndApplyEvents(
  session: SessionState,
  events: readonly MicroEvent[],
  now?: number,
): EventDecision[] {
  return events.map((event) => {
    if (session.recentEventFingerprints.has(eventFingerprint(event))) {
      return { event, applied: false, duplicate: true };
    }
    applyEvent(session, event, now);
    return { event, applied: true, duplicate: false };
  });
}

/** Applies a whole batch, reporting how many events were genuinely new. */
export function applyEvents(
  session: SessionState,
  events: readonly MicroEvent[],
  now?: number,
): { appliedCount: number; duplicateCount: number } {
  let appliedCount = 0;
  let duplicateCount = 0;
  for (const event of events) {
    const outcome = applyEvent(session, event, now);
    if (outcome.applied) appliedCount += 1;
    else duplicateCount += 1;
  }
  return { appliedCount, duplicateCount };
}

/**
 * True when a live projection has received no observation for longer than the
 * configured staleness horizon (`SESSION_TTL_SECONDS`).
 *
 * Two cases are deliberately *not* stale:
 *   - a non-positive horizon, which means the operator disabled eviction;
 *   - a projection with no recorded activity, because there is nothing to
 *     measure. Guessing would evict a session the server simply never observed.
 *
 * Eviction only drops the in-process projection. The durable session record and
 * its telemetry are never touched, so a later batch recovers the session from
 * the store instead of losing it.
 */
export function isStale(session: SessionState, ttlSeconds: number, now: number): boolean {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return false;
  if (!Number.isFinite(now) || !Number.isFinite(session.lastActivityAt)) return false;
  if (session.lastActivityAt <= 0) return false;
  return now - session.lastActivityAt > ttlSeconds * 1000;
}

/**
 * Replaces a lost in-memory projection with one rebuilt from the persisted
 * session record and its stored telemetry. Used after a restart, or when a
 * request arrives for a session this process has never seen.
 */
export function hydrateFromPersisted(input: {
  session: {
    sessionId: string;
    candidateId: string;
    assessmentId: string;
    problemId?: string;
    status?: string;
    submittedCode?: string;
  };
  events: readonly MicroEvent[];
  codeFromReports?: string;
  /**
   * True when the caller knows the supplied events are only part of the stored
   * history — for example a truncated review page. Recorded on the projection so
   * an undercounted recovery is visible rather than implied to be exact.
   */
  recoveredPartially?: boolean;
  /**
   * Exact per-type event counts from the store, when the caller has them.
   *
   * Replaying a page can only ever reconstruct the counters of that page, so a
   * long session comes back with undercounted signals and `shouldAnalyze` is less
   * likely to trip. Supplying real counts makes the counters totals regardless of
   * how much of the history was replayed.
   */
  eventCounts?: Record<string, number>;
}): SessionState {
  const session = createSessionState({
    sessionId: input.session.sessionId,
    candidateId: input.session.candidateId,
    assessmentId: input.session.assessmentId,
    problemId: input.session.problemId,
    status: normaliseStatus(input.session.status),
    currentCode: input.session.submittedCode ?? "",
    recoveredFromStore: true,
  });
  session.recoveredPartially = input.recoveredPartially ?? false;
  // A partial replay with no exact counts produces page-derived counters, which
  // is precisely the case that can under-trigger a threshold.
  session.countersExact = !(input.recoveredPartially ?? false) || input.eventCounts !== undefined;

  // Oldest first: the code snapshot is reconstructed in observation order.
  const ordered = [...input.events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  if (session.currentCode.length > 0) {
    // Persisted code wins over reconstructed code: it is the authoritative
    // snapshot, so replay only the counters.
    for (const event of ordered) {
      const previousCode = session.currentCode;
      applyEvent(session, event);
      session.currentCode = previousCode;
    }
  } else {
    for (const event of ordered) {
      applyEvent(session, event);
    }
  }

  if (session.currentCode.trim().length === 0 && input.codeFromReports) {
    session.currentCode = input.codeFromReports;
  }

  // Exact counts, when supplied, replace whatever the replay accumulated. The
  // replay is still what built the retained windows and the code snapshot, so it
  // is not wasted work — it is simply no longer the source of truth for counters.
  if (input.eventCounts) {
    applyExactCounts(session, input.eventCounts);
  }

  // Activity is seeded from the newest stored observation, so the staleness
  // horizon measures real candidate activity rather than the moment this
  // process happened to recover the session.
  session.lastActivityAt = newestObservationMs(ordered);

  return session;
}

/**
 * Overwrites the counters with the store's exact per-type counts.
 *
 * Anything the replay counted is discarded, because a partial replay cannot know
 * the true totals. Types the store did not report are left at zero rather than at
 * the replay's value, so an incomplete count map cannot masquerade as exact.
 */
function applyExactCounts(session: SessionState, counts: Record<string, number>): void {
  const count = (eventType: string): number => {
    const value = counts[eventType];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };

  session.pasteCount = count("PASTE_TRIGGER");
  session.tabSwitchCount = count("TAB_SWITCH");
  session.windowBlurCount = count("WINDOW_BLUR");
  session.fullscreenExitCount = count("FULLSCREEN_EXIT");
  session.copyAttemptCount = count("COPY_ATTEMPT");
  session.devToolsOpenCount = count("DEVELOPER_TOOLS_OPEN");

  const total = Object.values(counts).reduce(
    (sum, value) => (Number.isFinite(value) ? sum + value : sum),
    0,
  );
  session.eventsObserved = total;

  // Pastes without content are counted as pastes but contribute no sample, so the
  // sample total cannot exceed the paste count.
  session.pasteObservations = Math.min(count("PASTE_TRIGGER"), session.recentPasteContents.length);

  // Keystroke *samples* are per-delta, and the store counts KEYSTROKE events
  // rather than events that carried a numeric delta, so this figure stays as the
  // replay computed it. It is informational: `hasAnomalousKeystrokes` reads the
  // bounded delta window, not this total, so a partial page does not change the
  // heuristic's input beyond the window it already had.
  session.keystrokeObservations = session.keystrokeDeltas.length;

  session.countersExact = true;
}

/** Epoch milliseconds of the newest observation, or 0 when there is none. */
function newestObservationMs(events: readonly MicroEvent[]): number {
  let newest = 0;
  for (const event of events) {
    const parsed = new Date(event.timestamp).getTime();
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest;
}

function normaliseStatus(raw: string | undefined): SessionStatus {
  switch (raw) {
    case "in_progress":
    case "submitted":
    case "flagged":
    case "evaluated":
    case "terminated":
      return raw;
    default:
      return "in_progress";
  }
}

// ─── Integrity heuristics ──────────────────────────────────────────

export interface IntegrityThresholds {
  maxPasteEventsPerSession: number;
  minHumanKeystrokeMs: number;
  alertScoreThreshold: number;
}

/** True when the session's observable signals warrant an AI integrity pass. */
export function shouldAnalyze(session: SessionState, thresholds: IntegrityThresholds): boolean {
  if (session.submitted || session.status === "terminated") return false;
  if (session.currentCode.trim().length <= 50) return false;

  return (
    session.pasteCount > thresholds.maxPasteEventsPerSession ||
    session.tabSwitchCount > 3 ||
    session.windowBlurCount > 2 ||
    session.fullscreenExitCount > 0 ||
    session.copyAttemptCount > 2 ||
    session.devToolsOpenCount > 0 ||
    hasAnomalousKeystrokes(session.keystrokeDeltas, thresholds.minHumanKeystrokeMs)
  );
}

/**
 * Flags a session as anomalous when a large fraction of keystrokes arrive
 * faster than a human can plausibly type. Advisory only.
 */
export function hasAnomalousKeystrokes(deltas: readonly number[], minHumanMs: number): boolean {
  if (deltas.length < 10) return false;
  const fast = deltas.filter((delta) => delta < minHumanMs).length;
  return fast / deltas.length > 0.3;
}

export function computeKeystrokeMetrics(deltas: readonly number[]): KeystrokeMetrics {
  if (deltas.length === 0) {
    return { avgDeltaMs: 0, maxDeltaMs: 0, minDeltaMs: 0, sampleCount: 0 };
  }
  let total = 0;
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const delta of deltas) {
    total += delta;
    if (delta > max) max = delta;
    if (delta < min) min = delta;
  }
  return {
    avgDeltaMs: total / deltas.length,
    maxDeltaMs: max,
    minDeltaMs: min,
    sampleCount: deltas.length,
  };
}

/**
 * Minimal unified-diff applier: keeps the added lines so the reviewer sees the
 * code the candidate actually produced. It is not a full patch engine, and the
 * persisted code snapshot remains authoritative.
 */
export function applyDiffPatch(current: string, diffPatch: string): string {
  if (diffPatch.startsWith("@@") || diffPatch.startsWith("---") || diffPatch.startsWith("+++")) {
    const added = diffPatch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    return added.length > 0 ? added.join("\n") : current;
  }
  return current + diffPatch;
}

/** Removes the active session projection, e.g. after termination. */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  set(session: SessionState): void {
    this.sessions.set(session.sessionId, session);
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }

  /**
   * Drops every live projection that has been idle for longer than
   * `ttlSeconds`, and reports how many were dropped.
   *
   * This is the enforcement point for `SESSION_TTL_SECONDS`. Only the
   * in-process projection is removed: the durable session record and its
   * telemetry are untouched, and a later batch rehydrates the session from the
   * store.
   */
  evictStale(ttlSeconds: number, now: number): number {
    let evicted = 0;
    for (const [sessionId, session] of this.sessions) {
      if (isStale(session, ttlSeconds, now)) {
        this.sessions.delete(sessionId);
        evicted += 1;
      }
    }
    return evicted;
  }

  clear(): void {
    this.sessions.clear();
  }
}
