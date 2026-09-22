#!/usr/bin/env node
/**
 * End-to-end lifecycle check against a running API.
 *
 *   ASSESSMENT_API_TOKEN=<operator token> node scripts/verify-lifecycle.mjs
 *
 * Where scripts/smoke.mjs verifies the security boundary, this verifies that a
 * candidate's session actually works end to end:
 *
 *   1. register a candidate
 *   2. ingest a realistic telemetry batch
 *   3. replay the batch and confirm duplicate suppression
 *   4. confirm the session appears in the reviewer list with correct counts
 *   5. confirm review returns the timeline and the persisted submission snapshot
 *   6. terminate the session and confirm it is gone from the store
 *
 * It does not call the AI provider, so it runs without a model credential. When
 * no credential is configured the integrity report is legitimately absent, and
 * the check says so rather than failing.
 *
 * Exit code 0 means every step behaved as required.
 */

const baseUrl = (process.env.ASSESSMENT_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const operatorToken = process.env.ASSESSMENT_API_TOKEN ?? '';

if (!operatorToken) {
  console.error(
    'ASSESSMENT_API_TOKEN is required: session listing, review and termination need the operator credential.',
  );
  process.exit(2);
}

let failures = 0;

function step(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function skip(name, reason) {
  console.log(`  SKIP  ${name} — ${reason}`);
}

async function request(path, { method = 'GET', token = operatorToken, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

const stamp = Date.now();
const candidateId = `verify-candidate-${stamp}`;
const sessionId = `verify-session-${stamp}`;
const assessmentId = `verify-assessment-${stamp}`;
const SUBMITTED_CODE = 'export function solve(xs) { return xs.slice().sort((a, b) => a - b); }';

console.log(`Assessment lifecycle verification against ${baseUrl}\n`);

// ── 1. Register ───────────────────────────────────────────────────────────
const registration = await request('/api/v1/identity/set', {
  method: 'POST',
  token: '',
  body: { displayName: 'Lifecycle Verification', candidateId },
});
step('candidate registers', registration.status === 201, `status ${registration.status}`);

const candidateToken = registration.payload?.sessionToken;
if (typeof candidateToken !== 'string' || candidateToken.length === 0) {
  console.error('\nCannot continue without a candidate token.');
  process.exit(1);
}

// ── 2. Ingest a realistic batch, with a deliberate duplicate ──────────────
//
// The batch carries each observation twice. A duplicate is the *same
// observation* — same session, type, timestamp and payload — re-sent by a
// retrying client, so the fingerprint matches and the second copy is suppressed.
// Suppression is deliberately time-bucketed: a genuine observation of the same
// kind seconds later is treated as new, which is why the copies here are exact.
const startedAt = Date.now();
const observations = [];
const addEvent = (eventType, payload, seconds) => {
  observations.push({
    eventId: `${sessionId}-${eventType}-${seconds}`,
    sessionId,
    candidateId,
    assessmentId,
    problemId: 'problem-1',
    eventType,
    timestamp: new Date(startedAt + seconds * 1000).toISOString(),
    payload,
    clientMetadata: {
      userAgent: 'verify-lifecycle',
      ipAddress: '127.0.0.1',
      screenResolution: '1920x1080',
      platform: 'node',
      language: 'en',
    },
  });
};

addEvent('KEYSTROKE', { char: 'e', deltaMs: 120 }, 0);
addEvent('TAB_SWITCH', { visibilityState: 'hidden' }, 5);
addEvent('PASTE_TRIGGER', { pasteContent: SUBMITTED_CODE }, 10);
addEvent('COPY_ATTEMPT', { selectedText: 'export function solve' }, 15);
addEvent('FULLSCREEN_EXIT', {}, 20);

const batch = [...observations, ...observations];

const ingest = await request('/api/v1/integrity/ingest', {
  method: 'POST',
  token: candidateToken,
  body: { events: batch },
});
step(
  'telemetry is ingested',
  ingest.status === 200 && ingest.payload?.processedCount === observations.length,
  `status ${ingest.status} processed=${ingest.payload?.processedCount} of ${batch.length} sent`,
);
step(
  'the duplicated observations are suppressed',
  ingest.payload?.duplicateCount === observations.length,
  `duplicates=${ingest.payload?.duplicateCount} (expected ${observations.length})`,
);
step('telemetry is durably persisted', ingest.payload?.persisted === true);
step('the submission snapshot is persisted', ingest.payload?.codePersisted === true);

if (ingest.payload?.integrityReport === null) {
  skip('integrity analysis ran', 'no AI provider credential is configured on this instance');
}

// ── 3. Reviewer session list ──────────────────────────────────────────────
// The duplicates were suppressed, so the stored counts must reflect only the
// distinct observations. If suppression failed, these assertions catch it.
const list = await request('/api/v1/sessions');
const summary = (list.payload?.data ?? []).find((entry) => entry.sessionId === sessionId);
step('the session appears in the reviewer list', Boolean(summary), summary ? '' : 'not found');
if (summary) {
  step('the session records the candidate', summary.candidateId === candidateId);
  step(
    'duplicate telemetry did not inflate the counts',
    summary.eventCount === observations.length &&
      summary.pasteCount === 1 &&
      summary.tabSwitchCount === 1,
    `events=${summary.eventCount} (expected ${observations.length}) ` +
      `pastes=${summary.pasteCount} (expected 1) ` +
      `tabs=${summary.tabSwitchCount} (expected 1)`,
  );
}

// ── 4. Review ─────────────────────────────────────────────────────────────
const review = await request(`/api/v1/sessions/${sessionId}/review`);
const reviewData = review.payload?.data;
step('review loads', review.status === 200 && Boolean(reviewData), `status ${review.status}`);

if (reviewData) {
  step(
    'the timeline contains only the non-duplicate observations',
    reviewData.timeline.length === observations.length,
    `${reviewData.timeline.length} entries from ${batch.length} sent`,
  );
  step(
    'telemetry severities are classified',
    reviewData.timeline.some((entry) => entry.severity === 'critical'),
  );
  step(
    'the submission snapshot round-trips',
    reviewData.submittedCode === SUBMITTED_CODE,
    `length ${reviewData.submittedCode.length}, expected ${SUBMITTED_CODE.length}`,
  );
  step('the session status is in_progress', reviewData.status === 'in_progress');
}

// ── 5. Terminate ──────────────────────────────────────────────────────────
const terminate = await request(`/api/v1/integrity/sessions/${sessionId}`, { method: 'DELETE' });
step(
  'termination succeeds',
  terminate.status === 200 && terminate.payload?.deleted === true,
  `status ${terminate.status}`,
);

const afterTermination = await request(`/api/v1/sessions/${sessionId}/review`);
step(
  'the terminated session is gone from the store',
  afterTermination.status === 404,
  `status ${afterTermination.status}`,
);

console.log(
  `\n${failures === 0 ? 'Lifecycle verification passed.' : `${failures} lifecycle check(s) failed.`}`,
);
process.exit(failures === 0 ? 0 : 1);
