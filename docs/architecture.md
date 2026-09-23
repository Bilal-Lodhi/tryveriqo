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
| Operator token | `ASSESSMENT_API_TOKEN`, an operator-managed secret | assessment generation; session list; any session review; candidate reports; termination |
| Candidate token | `POST /api/v1/identity/set` | that candidate's own telemetry ingestion and review |

Candidate tokens are `v1.<base64url payload>.<base64url HMAC-SHA256>`. They are
stateless, so any API process can validate a token another process issued, and
they survive a restart. They carry the `candidateId` and an expiry.

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
