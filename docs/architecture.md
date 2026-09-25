# Architecture

## Repository layout

```
assessment/                 (repository directory name; the product is tryveriqo)
  apps/
    api/                    tryveriqo API (TypeScript, Hono)
      src/
        app.ts              application assembly: middleware order, route mounting
        index.ts            entry point; configuration validation and listener
        config.ts           environment loading and production fail-closed checks
        types.ts            domain types (Assessment-native vocabulary)
        assessment-input.ts generation request validation and the content pre-filter
        telemetry.ts        telemetry validation and normalisation
        integrity-session.ts in-memory session projection, dedup, recovery, heuristics
        mcp-client.ts       typed client for the MCP tool surface
        agents/
          gemini-client.ts  the single AI provider boundary
        middleware/
          auth.ts           authentication and authorisation
          tokens.ts         candidate session tokens (HMAC)
          rate-limit.ts     in-process amplification guard
          correlation.ts    request correlation ids
        routes/
          health.ts identity.ts generate.ts integrity.ts sessions.ts candidates.ts
      test/                 automated tests (no network, no paid model)
    console/                Reviewer console (Flutter)
  packages/
    mcp-mongodb/            MCP tool registry and MongoDB data layer
      src/
        tool-names.ts       THE tool-name contract
        collections.ts      THE collection-name contract
        tools.ts            definitions + one handler table + dispatcher
        mongo-store.ts      data access, indexes, aggregation
        http-server.ts      HTTP transport
        stdio-server.ts     stdio transport
        http-server-main.ts HTTP transport process entry point
      test/                 contract, store and transport tests
  docs/
  scripts/                  development, smoke and guard scripts
```

## Request flow: telemetry ingestion

```
candidate client
   │  POST /api/v1/integrity/ingest   Authorization: Bearer <candidate token>
   ▼
correlationId()        attach a request id to the response
authenticate()         resolve the caller (never rejects here)
rateLimit()            bound accidental amplification
requireAuth()          401 for anonymous
route handler
   ├─ validateIngestRequest()      shape, event types, batch cap, field caps
   ├─ candidateId match           403 if a candidate posts for someone else
   ├─ resolveSession()
   │     ├─ in-memory projection hit        → use it
   │     ├─ persisted session exists        → hydrate from records (recovery)
   │     └─ neither                         → create durably, then project
   ├─ decideAndApplyEvents()      fingerprint each observation; new ones only
   ├─ ingestMicroEvents() via MCP persist exactly the new observations
   ├─ updateSessionCode() via MCP persist the reconstructed snapshot
   └─ shouldAnalyze()?
         ├─ code hash unchanged since last analysis → reuse the report
         └─ otherwise → analyzeIntegrity() → storeIntegrityReport()
```

Ordering is deliberate. Each observation is fingerprinted **before** anything is
written, so a suppressed replay is never persisted and the reviewer timeline
cannot show one action twice. The durable write then happens before the response
is returned; if it fails, the response says `persisted: false` so the client can
retry rather than assume the telemetry landed.

The submission snapshot is written back only while a session is still
`in_progress`. Once a session is settled — `submitted`, `flagged`, `evaluated`
or `terminated` — its persisted snapshot is frozen and stays authoritative, so
late telemetry can never rewrite a submission that has already been reviewed.

**A note on the recovery path.** `decideAndApplyEvents` suppresses an observation
only when the process still holds a projection for that session. After a restart,
`hydrateFromPersisted` rebuilds the projection from stored telemetry, so the
fingerprints are repopulated and a replay of an already-stored batch is
recognised again.

## Authentication model

Two credential kinds, and only two.

| Credential | Issued by | Grants |
| --- | --- | --- |
| Operator token | `ASSESSMENT_API_TOKEN`, an operator-managed secret | assessment generation; session list; any session review; candidate reports; termination; minting registration capabilities |
| Candidate token | `POST /api/v1/identity/set` | that candidate's own telemetry ingestion and review |

Candidate tokens are `v1.<base64url payload>.<base64url HMAC-SHA256>`. They are
stateless, so any API process can validate a token another process issued, and
they survive a restart. They carry the `candidateId` and an expiry.

### Registration capability

A third token format exists but is **not** a credential kind: a registration
capability authorizes one candidate to claim one identity, and is consumed by
`POST /api/v1/identity/set` rather than presented as a bearer token.

```
rv1.<base64url payload>.<base64url HMAC-SHA256>
payload: { kind: "registration", candidateId, assessmentId | null,
           issuedAt, expiresAt, capabilityId }
```

`apps/api/src/middleware/registration-capability.ts` is the whole of it.
`issueRegistrationCapability` is called only by the operator-only
`POST /api/v1/identity/capability`; `verifyRegistrationCapability` is called only
by registration. The signing key is **derived** from `ASSESSMENT_SESSION_SECRET`
under the label `tryveriqo:registration-capability:v1`, which gives domain
separation — a capability signature is not a valid candidate-token signature and
vice versa — without adding a required production secret.

Design consequences worth stating:

* **Stateless**, so registration never touches the datastore and a restart with
  an unchanged secret cannot invalidate an outstanding capability.
* **Not one-time use.** Statelessness and single-use are mutually exclusive
  without a consumed-capability store. A short TTL bounds the window instead, and
  rotating the session secret revokes every outstanding capability at once.
* **One response for every failure.** Missing, malformed, bad signature, expired,
  wrong candidate and wrong assessment all return the same `403`, so registration
  is not an oracle for which check failed or for whether a candidate id exists.
* **Bound before verification.** A capability longer than
  `MAX_CAPABILITY_LENGTH` is rejected before any signature work.

`authenticate()` resolves the caller without rejecting: it sets `anonymous`,
`candidate` or `operator` on the request context. Each route then declares the
access it needs. That keeps "who is this" separate from "may they do this", which
is what makes the 401/403 distinction honest.

See [security/threat-model.md](security/threat-model.md).

## AI provider boundary

`AssessmentAiClient` in `apps/api/src/agents/gemini-client.ts` is the only
interface the rest of the API knows about:

```ts
classifyAssessmentIntent(prompt, roleContext, signal): Promise<IntentVerdict>
generateTestSuite(prompt, roleContext, problemCount, signal): Promise<GeneratedTestSuite>
analyzeIntegrity(code, pastes, keystrokes, references, signal): Promise<IntegrityReport>
```

`GeminiAssessmentClient` implements it over `@google/genai`, in one of two modes
selected explicitly by `AI_PROVIDER_MODE`:

* `gemini-api` (default) — Developer API, `GEMINI_API_KEY`.
* `vertex` — Vertex AI, `GEMINI_VERTEX_PROJECT` + Application Default Credentials.

There is no implicit credential discovery, and no fallback to a second model
identifier. Routes receive the client by dependency injection, so tests
substitute a stub and no paid model is ever called from the suite.

## Data model

```
generated_test_suites
  metadata.suiteId (unique index), metadata.generatedAt
      └── problems[] ── problemId, competencyId ── competencies[]
      └── testingMatrices[] ── integrityThresholds

assessment_sessions
  sessionId (unique index), candidateId, assessmentId, status, submittedCode,
  createdAt, updatedAt
  indexes: {candidateId, assessmentId}, {createdAt: -1}

micro_events
  sessionId, eventType, timestamp, payload, clientMetadata
  indexes: {sessionId, timestamp: -1}, {eventType: 1}

integrity_reports
  integrityReportId, sessionId, candidateId, assessmentId, overallScore,
  flags[], plagiarismReport, behavioralAnomalies[], generatedAt
  indexes: {sessionId, generatedAt: -1}, {candidateId: 1}
```

`COLLECTIONS` in `packages/mcp-mongodb/src/collections.ts` is the only place
these names appear. The MCP tools and the store both resolve them from there, and
a test asserts the naming.

`getCandidateReport` aggregates the **latest report per session** for a candidate
with a `$match → $sort → $group → $replaceRoot` pipeline, so a candidate with
many analyses of one session still produces one row.

### Which report is "latest"

A session can be analysed more than once, so `integrity_reports` holds a series
per session. The store returns them **newest-first** (`{generatedAt: -1}`), and
that ordering is an implementation detail of one query — not something the
reviewer-facing logic may depend on.

`apps/api/src/integrity-report.ts` is the single place that decides which report
is current. `selectLatestReport` picks the entry with the newest `generatedAt`
rather than the first or last element, so selection cannot invert if a sort order
changes. `finiteScore` bounds a stored score to `0-100` and never returns `NaN`.

Both matter for review. A positional pick silently selects the **oldest** report
and shows a reviewer the earliest score, flags and plagiarism report for a
session analysed several times — and derives the session's status and provisional
`finalScore` from it. And a non-numeric stored score would otherwise propagate
`NaN` into a displayed score.

When the newest report's score is unusable, `GET /api/v1/sessions/:sessionId/review`
returns `finalScore: null` rather than defaulting to zero. Zero would render as a
confident `100` for a session whose analysis data is malformed, which is the
misreading the review surface exists to avoid.

The console applies the same rule in `ReviewRecord.latestReport`, so the flags and
plagiarism panel cannot disagree with the score header.

### Evidence completeness in review

`get_session_review` returns at most one page of telemetry, and the store's
`getSessionEvents` sorts newest-first. A reviewer shown a page without being told
it is a page is looking at partial evidence that reads as the whole record — the
oldest events, often where an assessment starts, simply absent.

The tool therefore reports the page **and** its completeness: `eventTotal` from
`countSessionEvents`, `eventsReturned`, `eventsTruncated`, and `nextEventOffset`
for the next older page. The API re-orders the page ascending for display and
forwards the disclosure as `timelineTotal`, `timelineReturned`,
`timelineTruncated` and `nextEventOffset`.

Three consequences worth stating:

* **The true total comes from a count, not from the page length.** Deriving it
  from the returned array would reproduce the original defect.
* **The cohort list marks sampled counts.** `eventCount` is the true total, but
  `pasteCount` and `tabSwitchCount` are derived from one page, so the summary sets
  `countsSampled` when the session is longer than that page. Counting each type
  separately would add a query per type per session to a list that already fans
  out one call per session.
* **The console prepends, and discloses.** The timeline renders oldest-first
  while pages arrive newest-first, so older events belong at the front; a "Partial
  timeline" notice states how many of how many are loaded and offers the next page.

## Integrity engine

`apps/api/src/integrity-session.ts` is pure state manipulation — no network, no
clock — which is why it is directly testable.

**Duplicate suppression.** Each applied event contributes a fingerprint over its
type, problem, a one-second time bucket and its payload. `eventId` is excluded
because a retrying client re-serialises the batch with fresh ids. A retry
therefore collapses onto the original observation, while two genuinely distinct
observations a few seconds apart stay separate.

**Code-hash guard.** After an analysis, the SHA-256 of the analysed code is
retained. Further batches with byte-identical code reuse the previous report
instead of spending another model call.

**Recovery.** `hydrateFromPersisted()` rebuilds counters and code from stored
telemetry. A persisted `submittedCode` wins over reconstructed code, because it
is the authoritative snapshot; the counters are still rebuilt so thresholds
behave as they did before the restart.

**Heuristics** are advisory and threshold-driven: paste count, tab switches,
window blurs, fullscreen exits, copy attempts, developer tools, and keystroke
cadence. None of them is a conclusion.

## Timestamps

Storage is UTC ISO-8601 with milliseconds (`Z`). `apps/api/src/utils/time.ts`
owns the helpers. Local-time rendering is a viewer concern: the console converts
with `DateTime.parse(...).toLocal()`.

An intermediate revision of the source product stored server-local offsets
instead, which made timelines produced in different time zones non-comparable.
That approach was rejected here.

## Console

Flutter, Material 3, `provider` for state. Structure:

* `services/api_client.dart` — HTTP layer; attaches the operator token when
  configured, otherwise the candidate token.
* `providers/` — health, review, integrity, identity, theme.
* `screens/session_setup_screen.dart` — candidate registration.
* `screens/dashboard_screen.dart` — session drawer, review panes, generation tab.
* `widgets/code_workspace_panel.dart` — the submission, with a lock indicator
  once a session is settled.
* `widgets/integrity_metrics_panel.dart` — score, structured flags, similarity
  report, anomalies, timeline.
* `widgets/generate_panel.dart` — assessment generation.

There is **no polling loop**. The API is request/response, so the console
refreshes on demand and after each action, rather than pretending to stream.

## Testing strategy

| Layer | How it is tested |
| --- | --- |
| Auth | HTTP-level tests over the real app object, all credential kinds |
| Validation | Pure-function tests for the request validator and pre-filter |
| Integrity engine | Pure-function tests for dedup, heuristics, recovery |
| Telemetry path | HTTP tests with stub AI and stub MCP collaborators |
| AI parsing | The SDK module itself is mocked; real request construction, retry and JSON recovery run |
| Tool contract | Handler-table coverage plus a source scan proving the API never hard-codes a tool name |
| Data layer | An in-memory driver double implementing only the surface the store uses |
| MCP transport | A real HTTP server on an ephemeral port |
| Startup | The real entry point is spawned and its exit code and output asserted |
| Console | `flutter analyze` plus widget and model tests |

Every paid-provider call is behind the provider boundary, so **no test needs a
model credential**.
