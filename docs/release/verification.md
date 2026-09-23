# Verification record

This document records what has actually been executed and observed, and what has
not. It is deliberately explicit about the difference.

Every result below was produced on the build host described here. Nothing in this
file is a projection or an expectation.

## Environment

| Item | Value |
| --- | --- |
| Node.js | `v24.19.0` |
| npm | `11.17.0` |
| Docker | `28.0.4` |
| Docker Compose | `v2.34.0-desktop.1` |
| Flutter | `3.35.3` (stable channel) |
| Dart SDK | `3.9.2` |
| Platform | Windows |

## Backend

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | pass |
| Typecheck | `npm run typecheck` | pass (both workspaces) |
| Build | `npm run build` | pass (both workspaces) |
| Tests (`@assessment/api`) | `npm run test -w @assessment/api` | **154 pass, 0 fail** (33 suites) |
| Tests (`@assessment/mcp-mongodb`) | `npm run test -w @assessment/mcp-mongodb` | **33 pass, 0 fail** (8 suites) |
| Guards | `node scripts/guards/*.mjs` | pass |

## Console

| Check | Command | Result |
| --- | --- | --- |
| Resolve | `flutter pub get` | pass |
| Analyze | `flutter analyze` | **No issues found** |
| Tests | `flutter test` | **6 pass, 0 fail** |
| Web build | `flutter build web --release` | pass |

## Container

| Check | How | Result |
| --- | --- | --- |
| Image builds | `docker build -t tryveriqo:local .` | pass |
| Production fails closed | `ENVIRONMENT=production` with no secrets | **exit 1**; message names all four missing values |
| MCP fails closed | `ENVIRONMENT=production` without `MCP_AUTH_TOKEN` | **exit 1**; refuses an unprotected tool surface |
| Stack starts | `docker compose up --build` | pass — `mongo`, `mcp`, `api` all reach `healthy` |
| Health through the stack | `GET /health` | `200`, `service=tryveriqo-api`, `version=0.1.0` |
| Indexes created | MCP startup | `ensureIndexes()` on connect |
| Security boundary in-container | `node scripts/smoke.mjs` against the Compose API | **15 pass, 0 fail** |
| Child-process supervision | kill the MCP transport inside the entrypoint container | container exits **1** with `ERROR: MCP transport exited unexpectedly` |
| Graceful shutdown | `docker stop` the API container | exit 0 |

### Child-process supervision defect found and fixed

The entrypoint originally supervised with `wait -n`. Under BusyBox `ash` — the
shell in the Alpine runtime image — `wait -n` **does not return** when a tracked
child dies *after* it has started blocking. Reproduced against this image: the
MCP transport was killed and the container kept serving an API whose datastore
calls could no longer succeed, for over a minute, with no supervision log.

The entrypoint now polls liveness with `kill -0` instead. Re-verified: killing
the transport is detected within about one second, the API is terminated, and the
container exits 1. `wait -n` also behaves differently when the child has already
exited before the call, which is why an early test appeared to pass.

## AI provider — LIVE VERIFICATION

The live path is now exercised. This closes the extraction-time gap.

| Item | Observed value |
| --- | --- |
| Provider mode | `gemini-api` (Gemini Developer API) |
| Model id | `gemini-2.5-flash` |
| Model availability | confirmed served — returned by `GET /v1beta/models` with `generateContent` support |
| Route used | production `GeminiAssessmentClient` (`AssessmentAiClient` boundary) |
| Request construction | production code path, unmodified |
| Parser | production `parseTestSuiteResponse` / `parseClassifierResponse` / `parseIntegrityResponse` |
| Classifier call | success, attempt 1/3, **~2.7 s** |
| Suite generation call | success, attempt 1/3, **~10.4–11.2 s** |
| Classifier verdict | `isInputMeaningful=true`, `isAssessmentRelated=true`, `isAppropriate=true`, `confidence=1`, `detectedDomain="Junior Frontend JavaScript"` |
| Suite shape returned | 1 role, 2 competencies, 1 coding problem, 4 test cases (3 hidden), 1 testing matrix |
| Parser result | valid — UUID problem ids, every `problem.competencyId` resolves to a declared competency |
| Persistence | success — document present in `generated_test_suites` |
| Integrity analysis | success, **~12.5 s**, `overallScore=95`, structured flags with severity and confidence |
| Usage metadata | exposed by the SDK; the production parser records `tokenUsage` from the model's own JSON, which the model reports as zeros |

No secret value appears in this record, in the repository, or in any log.

### Model-identifier note

`AI_MODEL=gemini-2.5-flash` is confirmed to be currently served, so the
documented default is correct. The historical `gemini-3-flash-preview` identifier
was never served by the public API and remains retired.

### Defect found by the live call, and fixed

The live run exposed a real persistence bug that no fixture had caught.

Asked for a unique UUID for every identifier, `gemini-2.5-flash` repeatedly
answers with the **same memorised placeholder** — observed verbatim as
`a1b2c3d4-e5f6-7890-1234-567890abcdef`, across separate calls. The production
parser trusted model-supplied ids, so every generated suite carried an identical
`suiteId`. `metadata.suiteId` has a unique index, so the second generation failed
to persist with `E11000 duplicate key error`; the route reported
`persisted=false` and the suite was lost while still being returned to the caller
as a success.

Fixed at two layers:

1. **Parser** — a known placeholder id is replaced with a real UUID. Model-supplied
   ids that are *not* placeholders remain authoritative, so a suite's internal
   cross-references are preserved, and a problem can no longer reference a
   competency that does not exist.
2. **Store** — `storeTestSuite` is idempotent on `metadata.suiteId` (upsert), so a
   re-generation or a client retry replaces rather than fails.

Both layers carry regression tests. After the fix, the full live workflow passed
with `persisted=true`.

## Live end-to-end workflow

Executed against a running instance with a live credential configured. Every step
required by the release checklist was exercised.

| # | Step | Result |
| --- | --- | --- |
| 1 | Operator-authenticated assessment generation | pass — `201`, ~14.1 s |
| 1.1 | Live response parsed into a valid suite | pass — 1 problem, 2 competencies |
| 1.2 | Classifier executed against the live model | pass — `executed=true`, `degraded=false` |
| 2 | Generated suite persisted through the MCP surface | pass — `persisted=true` |
| 3 | Candidate registration / session creation | pass — `201`, scoped token issued |
| 4 | Candidate-scoped token accepted on candidate routes | pass — resolves its own identity |
| 5 | Cross-candidate access rejected | pass — `403` on ingest, cohort list, candidate reports and foreign review |
| 6 | Telemetry ingestion | pass — 17/17 events, persisted, snapshot persisted |
| 7 | Integrity analysis path (live model) | pass — report produced, scoped to the right session/candidate/assessment |
| 8 | Review / timeline retrieval | pass — 17-entry timeline, snapshot round-trips, report exposed |
| 9 | Terminate / close lifecycle | pass — `200`, then `404` from review |
| 10 | Delete lifecycle | pass — termination removes the session with its telemetry and reports |

**Totals: 25 pass, 0 fail.**

Repository scripts against the same instance:

| Script | Result |
| --- | --- |
| `npm run smoke` | **15 pass, 0 fail** |
| `npm run verify` | **15 pass, 0 fail** |

### Script defect found and fixed

`scripts/verify-lifecycle.mjs` asserted that the session status stays
`in_progress`. That only holds on an instance with **no** AI credential. The
verification batch contains a `FULLSCREEN_EXIT`, and `shouldAnalyze` treats any
fullscreen exit as warranting a pass, so with a credential configured the analysis
runs, scores the session and correctly promotes it to `flagged`. The assertion was
rewritten to expect `flagged` when a report exists and `in_progress` when it does
not. The product behaviour was not weakened.

## Security boundary

| Property | How verified | Result |
| --- | --- | --- |
| Anonymous callers refused | `smoke.mjs` over every sensitive route | `401` on each |
| Wrong operator token refused | `smoke.mjs` | `401` |
| Candidate cannot enumerate the cohort | `smoke.mjs`, live workflow | `403` |
| Candidate cannot read another candidate's reports | live workflow | `403` |
| Candidate cannot ingest for another candidate | live workflow | `403` |
| Candidate cannot review a foreign session | live workflow | `403` |
| Console operator token is embedded in the web bundle | built with a sentinel token and searched the output | **confirmed present verbatim in `main.dart.js`** |

The last row is a documented limitation, not a defect: see
[configuration.md](../configuration.md#console-operator-token).

## Dependency and licence audit

Recorded in full in [NOTICE](../../NOTICE). Summary:

| Closure | Packages | Copyleft | Unknown/missing |
| --- | --- | --- | --- |
| Node runtime (from `package-lock.json`) | 156 | 0 | 0 |
| Flutter / Dart (from `pubspec.lock`) | 28 | 0 | 0 |

No Apache-2.0 package in the closure ships a `NOTICE` file, so no section 4(d)
retention obligation is outstanding. The one reciprocal licence named by the
Flutter engine notices is MPL-2.0 on certificate *data* that a web build does not
include.

## What remains unverified

Stated plainly so it is not mistaken for a pass:

* **Vertex AI transport.** `AI_PROVIDER_MODE=vertex` is implemented and covered by
  request-construction tests, but no Google Cloud project or ADC was available, so
  the Vertex path has **not** been exercised live. Only `gemini-api` is verified.
* **A hosted reverse-proxy console deployment.** The documented safe pattern is
  described but not deployed here.
* **Sustained load or adversarial DoS.** In-process rate limits are a backstop, not
  a load-tested defence.
* **Non-web console targets.** `flutter analyze` and `flutter test` pass; only the
  web build was compiled.
