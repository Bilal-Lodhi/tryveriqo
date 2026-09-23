# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
