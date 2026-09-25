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

### Correction: what the cross-candidate rows above did and did not cover

The live workflow verified cross-candidate rejection for the **single-event,
same-candidate** shape only. Two gaps survived it, and both were real:

* Ingestion decided who a batch belonged to from `events[0]` alone, while the
  validator allowed a batch to carry events naming **different** candidates. A
  two-event batch — the caller's own event first, a victim-attributed event
  second — was accepted, persisted, and its content written into the victim
  session's stored code snapshot. The row "Candidate cannot ingest for another
  candidate" was therefore true of the shape that was tested and false of the
  shape that was not.
* Ingestion never compared the session's stored owner against the caller at all,
  so any caller holding a known `sessionId` could write into that session
  regardless of the events' `candidateId`. No row above covered this.

Both are fixed, with regression tests for the mixed-candidate batch, the foreign
session, the foreign code snapshot, and the operator writing into a
differently-owned session. The enforced rules are now stated in
[threat-model.md](../security/threat-model.md) (T3). A batch names exactly one
candidate, that candidate must match the token, and the batch must own the
session — checked before the projection is created, cached or recovered.

The read-side residual is unchanged and still real: registration is
unauthenticated, so a known candidate id yields a token that can read that
candidate's own data. That is issue #2.

### Correction: registration was unauthenticated

The row "Candidate registration / session creation — pass, `201`, scoped token
issued" was accurate and also incomplete. Registration accepted **any**
`candidateId` from **any** caller, with no check that the id was unused, so the
`201` above was reachable by anyone who knew a candidate id — including an
existing candidate's, whose submitted code and integrity reports the resulting
token could then read. The live workflow verified that a *legitimate* candidate
could register; it did not test that an *illegitimate* one could not.

That is now closed. `POST /api/v1/identity/set` requires an operator-issued
registration capability bound to the candidate id being claimed (and to the
assessment, when the operator bound one), and returns one identical `403` for
every failure. See
[configuration.md](../configuration.md#candidate-registration) and
[threat-model.md](../security/threat-model.md) (T3).

Re-verified against a live self-hosted stack in the default `capability` mode:
`npm run smoke` reports 17 pass / 0 fail and `npm run verify` 18 pass / 0 fail,
including two checks that did not exist before — "registration without a
capability is refused" and "operator issues a registration capability". The
"Candidate cannot ingest for another candidate" row was re-verified in the same
run.

The published v0.1.0 release body still describes the old behaviour. It is
deliberately left untouched; see the note at the end of this file.

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

* **Vertex AI transport — a successful generation.** `AI_PROVIDER_MODE=vertex` is
  implemented and covered by request-construction tests, and a live call has since
  been made against a real project with ADC (see "Vertex AI transport: live
  result" below). That call authenticated, reached the provider and returned a
  structured `BILLING_DISABLED` refusal, so the transport is exercised but has
  **never produced a response**, and the parser has never seen a live Vertex
  shape. Only `gemini-api` has recorded live success.
* **A hosted reverse-proxy console deployment.** The documented safe pattern is
  described but not deployed here.
* **Sustained load or adversarial DoS.** In-process rate limits are a backstop, not
  a load-tested defence.
* **Non-web console targets.** `flutter analyze` and `flutter test` pass; only the
  web build was compiled.

## The published v0.1.0 release body

`docs/release/release-notes-v0.1.0.md` is the exact body of the published v0.1.0
GitHub Release and is deliberately left **byte-identical** to it, even where
later work proved a claim in it incomplete — the cross-candidate rows and the
registration description above are the two known cases.

Correcting a published release body is a release-authority action, not a
documentation edit, so it is not done here. The current-state documents
(README, `SECURITY.md`, `docs/configuration.md`, the threat model, and the
corrections above) carry the accurate position. If the maintainer authorises an
edit to the release body, this file must be updated in the same change so the two
stay identical.

## Vertex AI transport: live result (post-v0.1.0)

Issue #1 asked for a real Vertex call. One was made, after v0.1.0, against a real
Google Cloud project using Application Default Credentials. It did **not** produce
a generation, and the reason is worth recording precisely.

**Setup.** `AI_PROVIDER_MODE=vertex`, model `gemini-2.5-flash`, region
`us-central1`, no API key — ADC only. The project id and the credentials file were
supplied through the process environment and mounted read-only into the container;
neither appears in any tracked file, which the credential guard enforces.

**Result.**

| Observation | Value |
| --- | --- |
| Provider mode reached | `vertex` (confirmed on `/health` as `gemini (vertex)`) |
| Model | `gemini-2.5-flash` |
| Region | `us-central1` |
| ADC discovery | **Worked.** No API key was configured, and the request authenticated |
| Request reached the provider | **Yes** — a structured Google API error came back |
| Provider response | `403 PERMISSION_DENIED`, reason `BILLING_DISABLED` |
| Wall-clock for the full request | ~7.3 s |
| Parser outcome | **Not reached** — there was no response body to parse |
| Persistence outcome | **Not reached** |
| Route status | `500`, `retryable: false` |

**What this proves.** The parts a request-construction test cannot reach:

* **ADC is discovered and used.** The call authenticated with no API key present,
  which is the whole difference between the two transports.
* **The configured region is accepted.** No region or model-location error was
  returned, so `us-central1` is valid for this model on this project.
* **The request reaches Vertex and comes back as a structured provider error**,
  not a transport failure, a timeout, or a client-side rejection.
* **The client's failure semantics are correct on a real provider error.**
  `PERMISSION_DENIED` was classified as terminal and **not retried** (one attempt,
  not three), the classifier degraded rather than blocking generation
  (`Classifier unavailable … continuing to generation`), and the route returned
  `500` with `retryable: false` rather than a misleading `503`.

**What remains unverified.** A **successful** Vertex generation, and therefore
`parseTestSuiteResponse` against a live Vertex response shape, and persistence of
the result. The provider refused before producing output.

**Why, and what it would take.** The project has billing disabled, and Vertex
requires it. The provider's own message is the actionable error the issue asked
for, so the transport is not stale or broken — it is gated. Enabling billing on a
Google Cloud project is a spend decision, which this project's own rules reserve
for the maintainer, so it was not done. Issue #1 stays open for that reason.

**What a deployment should take from this.** `AI_PROVIDER_MODE=vertex` is
implemented and reaches the provider, but a successful generation has not been
observed. `gemini-api` remains the transport with recorded live success. A
deployment choosing `vertex` should expect to verify its own billing, project and
region before relying on it.
