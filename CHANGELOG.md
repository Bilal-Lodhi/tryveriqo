# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Removed

* The unauthenticated identity model where any caller could register as any
  candidate with no credential.
* The SSE streaming endpoint and the client-side polling fallback that emulated
  it; the API is request/response and the console refreshes on demand.
* The hackathon-era branding, agent-orchestration framing, cloud-project
  references and deployment identifiers.
* The `*.md` blanket ignore rule that had been excluding documentation from the
  repository.

### Security

* Failed-closed production startup, verified by a test that spawns the real
  entry point.
* Constant-time comparison for the operator token and for candidate token
  signatures.
* Candidate tokens are HMAC-signed and scoped to a single candidate.
* Telemetry ingestion bounds batch size and free-text field length.
* The MCP tool surface requires its own token and refuses to start unprotected in
  production.

## [0.1.0] — unreleased candidate

The initial version, prepared but **not tagged and not published**.
