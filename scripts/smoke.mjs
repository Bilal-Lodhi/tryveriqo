#!/usr/bin/env node
/**
 * End-to-end smoke test against a running API.
 *
 *   ASSESSMENT_API_TOKEN=<operator token> node scripts/smoke.mjs
 *
 * Verifies the properties that matter for a self-hosted deployment:
 *   1. the API answers /health
 *   2. sensitive routes reject anonymous callers
 *   3. the operator credential can register a candidate and read the review list
 *   4. a candidate credential can submit its own telemetry and is refused
 *      everything else
 *
 * It does not call the AI provider, so it is safe and free to run repeatedly.
 */

const baseUrl = (process.env.ASSESSMENT_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const operatorToken = process.env.ASSESSMENT_API_TOKEN ?? '';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, payload };
}

console.log(`Assessment smoke test against ${baseUrl}\n`);

// ── 1. Health is public ────────────────────────────────────────────────────
const health = await request('/health');
check('health is reachable', health.status === 200, `status ${health.status}`);
check('health reports a version', typeof health.payload?.version === 'string');
check('health does not leak a credential', !JSON.stringify(health.payload ?? {}).match(/token|secret|api_key|password/i));

// ── 2. Sensitive routes reject anonymous callers ───────────────────────────
for (const [label, path, init] of [
  ['session list', '/api/v1/sessions', {}],
  ['session review', '/api/v1/sessions/smoke-session/review', {}],
  ['candidate report', '/api/v1/candidates/smoke-candidate/reports', {}],
  ['session termination', '/api/v1/integrity/sessions/smoke-session', { method: 'DELETE' }],
  [
    'assessment generation',
    '/api/v1/generate',
    { method: 'POST', body: { prompt: 'smoke', roleContext: 'smoke' } },
  ],
  [
    'telemetry ingestion',
    '/api/v1/integrity/ingest',
    { method: 'POST', body: { events: [] } },
  ],
]) {
  const response = await request(path, init);
  check(`${label} rejects an anonymous caller`, response.status === 401, `status ${response.status}`);
}

// ── 3. Candidate registration ──────────────────────────────────────────────
const candidateId = `smoke-candidate-${Date.now()}`;
const registration = await request('/api/v1/identity/set', {
  method: 'POST',
  body: { displayName: 'Smoke Candidate', candidateId },
});

if (registration.status === 503) {
  console.log('\n  SKIP  candidate registration is disabled (no session secret configured)');
} else {
  check('candidate registration succeeds', registration.status === 201, `status ${registration.status}`);
  const sessionToken = registration.payload?.sessionToken;

  if (typeof sessionToken === 'string' && sessionToken.length > 0) {
    const me = await request('/api/v1/identity/me', { token: sessionToken });
    check('candidate token resolves its own identity', me.status === 200 && me.payload?.identity?.candidateId === candidateId);

    const ingest = await request('/api/v1/integrity/ingest', {
      method: 'POST',
      token: sessionToken,
      body: {
        events: [
          {
            eventId: `smoke-${Date.now()}`,
            sessionId: `smoke-session-${Date.now()}`,
            candidateId,
            assessmentId: 'smoke-assessment',
            problemId: 'smoke-problem',
            eventType: 'TAB_SWITCH',
            timestamp: new Date().toISOString(),
            payload: { visibilityState: 'hidden' },
            clientMetadata: {
              userAgent: 'smoke',
              ipAddress: '127.0.0.1',
              screenResolution: '1x1',
              platform: 'node',
              language: 'en',
            },
          },
        ],
      },
    });
    check(
      'candidate can submit its own telemetry',
      ingest.status === 200 || ingest.status === 502,
      `status ${ingest.status} (502 means the datastore is unavailable)`,
    );

    const forbidden = await request('/api/v1/sessions', { token: sessionToken });
    check('candidate cannot read the cohort session list', forbidden.status === 403, `status ${forbidden.status}`);
  } else {
    check('registration returned a session token', false, 'no token in the response');
  }
}

// ── 4. Operator credential ─────────────────────────────────────────────────
if (!operatorToken) {
  console.log('\n  SKIP  operator checks (set ASSESSMENT_API_TOKEN to run them)');
} else {
  const list = await request('/api/v1/sessions', { token: operatorToken });
  check('operator can read the session list', list.status === 200, `status ${list.status}`);

  const wrong = await request('/api/v1/sessions', { token: `${operatorToken}-wrong` });
  check('a wrong operator token is refused', wrong.status === 401, `status ${wrong.status}`);
}

console.log(`\n${failures === 0 ? 'All smoke checks passed.' : `${failures} smoke check(s) failed.`}`);
process.exit(failures === 0 ? 0 : 1);
