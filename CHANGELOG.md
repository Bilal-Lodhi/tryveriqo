# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

* **Rate-limit keys are no longer client-supplied.** The limiter chose its bucket
  from `X-Forwarded-For` / `X-Real-Ip`, which any direct client can set, so
  rotating one header evaded every limit — including the one on unauthenticated
  registration. Those headers are now consulted only when `TRUST_PROXY_HEADERS` is
  explicitly enabled (default off, and only `true`/`1`/`yes` enable it). Telemetry
  ingestion is now rate-limited too, keyed per candidate rather than per connection
  so candidates behind one address do not share a budget. The bucket map is capped
  at 10,000 entries and evicts rather than grows, where it previously swept only
  above a threshold and only expired entries.
* **Request bodies are bounded.** Nothing capped a request body, and
  `POST /api/v1/identity/set` is unauthenticated by design, so any caller on the
  network could make the process buffer an arbitrarily large body. Every route
  that accepts a body now has a ceiling applied before the body is parsed —
  16 KiB for identity, 64 KiB for generation, 8 MiB for ingestion, with an 8 MiB
  backstop for `/api/*` — refused with `413` in the standard error shape. The MCP
  HTTP transport caps a tool-call body the same way. Free text across one
  telemetry batch is additionally capped at 500,000 characters, because the
  per-field and per-batch caps previously composed into roughly 30 MB of
  legitimate content for a single request.
* **MCP tool dispatch resolves only declared tools.** `dispatchTool` looked a
  handler up with a bare property access, so `constructor`, `toString`,
  `hasOwnProperty`, `__proto__` and friends resolved to `Object.prototype`
  members and were invoked as though they were tools, returning `200` instead of
  the `404` the transport owes.
* **Candidate registration now requires an operator-issued registration
  capability.** `POST /api/v1/identity/set` previously accepted any `candidateId`
  from any caller with no check that the id was unused, so anyone who knew a
  candidate id could obtain a token for that candidate — including an existing
  one, whose submitted code and integrity report history the token could then
  read. Registration now refuses to mint a token without a capability: an
  HMAC-signed, short-lived grant created only by the operator credential at
  `POST /api/v1/identity/capability`, bound to that exact `candidateId` and (when
  the operator binds one) that `assessmentId`. Every failure returns one
  identical `403`, so the endpoint does not reveal which check failed or whether
  a candidate id exists. A capability proves that the operator authorised the id
  and that the presenter holds the grant — **not** who the presenter is — and it
  is **not** one-time use; a short TTL bounds the replay window and rotating
  `ASSESSMENT_SESSION_SECRET` revokes every outstanding capability at once.
  `CANDIDATE_REGISTRATION_MODE=open` restores the old behaviour for local
  development only, and the API now **refuses to start in production** with it.

### Fixed

* **The console reported a cancelled or unsaved generation as a success, and
  claimed it had been persisted.** The generate panel read only the happy path out
  of the response and told the operator "The suite was persisted for issue to
  candidates" whenever a suite came back — including when the API reported
  `persisted: false`, meaning the store rejected the write and the suite exists
  only in that response. A cancelled request, which the API answers with `200` and
  `success: false`, was reported as a completed generation. `GenerateResult` now
  carries `success` and `persisted`, and the panel renders four distinct states —
  saved, generated-but-not-saved, cancelled, failed — with the not-saved case
  deliberately styled as a warning rather than a success.
* **The reviewer was shown the *oldest* integrity report.** `integrity_reports`
  holds a series per session and the store returns it newest-first, but review
  selected the last array element — the oldest report — and derived the session's
  status and provisional `finalScore` from it. A session analysed more than once
  therefore displayed its earliest score and flags, and could be reported as
  `submitted` when the newest report was above the alert threshold. Selection is
  now by newest `generatedAt` in one shared helper, applied in both the API and
  the console, so it cannot invert with a sort order. A stored score that is not a
  finite number no longer produces `NaN`: it is bounded to `0-100`, and an
  unusable score yields `finalScore: null` rather than a confident `100`.
* **Cross-candidate telemetry injection.** Ingestion decided who a batch belonged
  to from its first event alone, while the validator allowed a batch to carry
  events naming different candidates. A caller could therefore send their own
  event first and a victim-attributed event second: the batch was accepted, the
  forged event was persisted, and its content was written into the victim
  session's stored code snapshot. A batch must now name exactly one candidate.
* **Ingestion never checked session ownership.** Any caller holding a known
  `sessionId` could write into that session regardless of the events'
  `candidateId`. A batch is now refused unless the session's stored owner is that
  same candidate, checked before the projection is created, cached or recovered.
  This is a data-integrity rule as well as an authorization one: it also stops
  the operator writing events attributed to one candidate into another
  candidate's session.
* **`SESSION_TTL_SECONDS` was inert.** The documented session staleness horizon
  had no consumer anywhere in the source. It is now the enforced horizon for the
  API's in-memory session projection; the durable session, its telemetry and its
  reports are never deleted by it, and the documentation now says so explicitly.
* **Recovery lost settled state.** A session recovered from its stored record
  carried the persisted `submitted` status but not the `submitted` flag, so
  `shouldAnalyze` treated an already-final answer as live and spent a fresh paid
  model call re-analysing it. Recovery also discarded the last analysis, so
  unchanged code was re-analysed after every recovery.
* **A refused session termination dropped live state.** `DELETE
  /api/v1/integrity/sessions/:sessionId` removed the in-memory projection before
  checking whether the store accepted the delete, so a `502` silently discarded
  the live view of a session that still existed.

### Changed

* Threat model T3/T4, `SECURITY.md`, the README and the release checklist now
  state the residual of open candidate registration accurately: cross-candidate
  *writes* are refused, but a token for a **known** candidate id still grants read
  access to that candidate's own reviews, submitted code and integrity reports.
  The previous wording claimed this granted no access to another candidate's data.

## [0.1.0] — 2026-09-23

The first independent release of tryveriqo, published as a **pre-release** at
<https://github.com/Bilal-Lodhi/tryveriqo/releases/tag/v0.1.0>. It is not
production ready and there is no hosted instance.

This section covers the whole of the work that produced v0.1.0: the extraction
from the historical repository, the hardening that followed, and the release
preparation. Because the extracted baseline is this version's starting point
rather than a prior release, it is recorded here rather than under its own
heading.

### Added

* Post-restart session recovery: a session whose in-memory projection was lost is
  rebuilt from its persisted record and stored telemetry rather than silently
  recreated empty.
* Duplicate telemetry suppression: replayed batches are recognised by an
  observation fingerprint, cannot inflate integrity counters, and are **not
  written to storage**, so the reviewer timeline never shows the same action
  twice.
* The reconstructed submission snapshot is written back to the session record as
  telemetry arrives, so `GET /api/v1/sessions/:sessionId/review` returns the code
  the candidate actually produced. A settled session's snapshot is frozen and
  cannot be rewritten by late telemetry.
* `scripts/smoke.mjs` and `scripts/verify-lifecycle.mjs`, which verify the
  security boundary and the full candidate session lifecycle against a running
  instance without calling a paid model.
* Deterministic content pre-filter for generation requests (empty, greeting-only,
  profanity, unambiguous keyboard mashing), running before the semantic
  classifier.
* Session termination: `DELETE /api/v1/integrity/sessions/:sessionId` removes a
  session together with its telemetry and integrity reports.
* `update_session_code` and `update_session_status` MCP tools, so a session
  lifecycle can be driven from the tool surface.
* Repository guards: a credential guard, a retired-identifier guard, and
  gitleaks in CI.
* Failure-containment tests that prove an AI-provider outage does not reject
  telemetry the server has already durably accepted.
* Product identity: the project is named **tryveriqo**, applied across the README,
  package and service metadata, the API's `service` health field, the console
  title and web manifest, the container project name and the documentation. The
  API reports `service=tryveriqo-api`.
* A transitive dependency and licence inventory, covering the full resolved Node
  closure (156 packages) and the locked Flutter/Dart closure (28 packages).
  Recorded in `NOTICE`.
* Live provider verification against the Gemini Developer API, recorded in
  `docs/release/verification.md`, together with a live end-to-end workflow run.
* Explicit known-limitations documentation for open candidate registration and for
  the console operator token embedded in a web bundle.
* A release checklist that separates hard blockers from post-release improvements
  and deliberately deferred items (`docs/release/checklist.md`).

### Changed

* **Breaking:** routes renamed to Assessment vocabulary. `POST
  /api/v1/guardian/ingest` is now `POST /api/v1/integrity/ingest`, and the
  session review endpoint moved from `GET /api/v1/sessions/:sessionId` to
  `GET /api/v1/sessions/:sessionId/review`.
* **Breaking:** MongoDB collection names are `generated_test_suites`,
  `assessment_sessions`, `micro_events` and `integrity_reports`; the database
  default is `assessment`.
* **Breaking:** `suspicion_reports` documents are now `integrity_reports`, and
  the payload type is `IntegrityReport` with `integrityReportId` and
  `overallScore`.
* **Breaking:** the AI model identifier is `gemini-2.5-flash`. The historical
  `gemini-3-flash-preview` identifier never resolved on the public API and always
  fell back.
* **Breaking:** the MCP tool table is now a single registry shared by the HTTP
  and stdio transports. The two hand-maintained tables had drifted apart.
* **Breaking:** configuration is one root `.env.example`; per-workspace
  environment files and the implicit Application Default Credentials filesystem
  scan were removed.
* Authentication is now mandatory on every sensitive route. Development mode
  generates ephemeral credentials and logs the operator token once; production
  fails closed.
* CORS is an explicit allow-list. The wildcard origin was removed.
* Persisted timestamps are UTC ISO-8601. An intermediate change stored
  server-local offsets, which made timelines from different regions
  incomparable; that was reverted.
* Structured integrity flags are preserved verbatim through review. Flags stored
  as bare strings by earlier versions are widened on read.
* The provider SDK is obtained through an injectable loader rather than Node's
  experimental module mocking, so the test suite behaves identically on every
  supported Node version. Production still lazily imports and caches the real SDK.

### Removed

* The unauthenticated identity model where any caller could register as any
  candidate with no credential.
* The SSE streaming endpoint and the client-side polling fallback that emulated
  it; the API is request/response and the console refreshes on demand.
* The hackathon-era branding, agent-orchestration framing, cloud-project
  references and deployment identifiers.
* The `*.md` blanket ignore rule that had been excluding documentation from the
  repository.

### Fixed

* **Every generated suite collided on a single `suiteId`.** Asked for a unique
  UUID, `gemini-2.5-flash` returns the same memorised placeholder on every call,
  so the unique index on `metadata.suiteId` rejected the second suite. The API
  reported success to the caller while the suite was lost. Placeholder ids are now
  replaced in the parser, genuine model-supplied ids stay authoritative, a
  problem can no longer reference an undeclared competency, and `storeTestSuite`
  is idempotent on `metadata.suiteId`. Found by the live provider call; covered by
  regression tests at both layers.
* **Container supervision never noticed the tool transport dying.** The entrypoint
  used `wait -n`, which under BusyBox `ash` does not return when a tracked child
  dies after it has started blocking, so a container kept serving an API whose
  datastore calls could not succeed. Replaced with explicit liveness polling.
* **The MCP transport connected to the datastore before validating its
  configuration.** The production auth-token check lives in the server
  constructor, so an unreachable database masked an unprotected tool surface.
  The constructor now runs first, making the fail-closed guarantee independent of
  datastore reachability.
* `scripts/verify-lifecycle.mjs` asserted a session status that only holds on an
  instance with no AI credential. It now expects `flagged` when an integrity
  analysis ran and `in_progress` when it did not.
* The console source now satisfies `dart format --set-exit-if-changed`, which CI
  enforces.

### Security

* Failed-closed production startup, verified by a test that spawns the real
  entry point.
* Constant-time comparison for the operator token and for candidate token
  signatures.
* Candidate tokens are HMAC-signed and scoped to a single candidate.
* Telemetry ingestion bounds batch size and free-text field length.
* The MCP tool surface requires its own token and refuses to start unprotected in
  production, independently of whether the datastore is reachable.
* The secret scan resolves the commit range an event introduced and falls back to
  full-history detection when there is no usable range, so it cannot report
  success while examining zero commits.
