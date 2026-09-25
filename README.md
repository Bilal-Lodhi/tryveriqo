# tryveriqo

**An open-source, self-hostable platform for generating online assessments and
giving reviewers evidence-based integrity signals about how candidates completed
them.**

> **What this is not.** This is not proctoring software and it does not detect
> cheating with certainty. It produces *integrity signals* and *suspicious
> behaviour indicators* that a human reviewer interprets. No output of this
> system should be treated as proof that a candidate cheated.

> **Status: v0.1.0 pre-release.** Published as a pre-release at
> [releases/tag/v0.1.0](https://github.com/Bilal-Lodhi/tryveriqo/releases/tag/v0.1.0).
> The API, the console and the datastore layer are built and tested, and the AI
> provider path has been exercised against a live Gemini credential. This is **not
> production ready** and there is no hosted instance. See
> [Release readiness](#release-readiness) for exactly what was observed, and
> [docs/release/checklist.md](docs/release/checklist.md) for what is deliberately
> still open.

---

## The problem it solves

Running an online assessment produces two separate problems:

1. **Authoring.** Writing a role-appropriate question set, with competencies,
   difficulty balance and hidden test cases, is slow and repetitive.
2. **Review.** Once candidates have submitted, a reviewer needs to reconstruct
   *how* a submission was produced — what was typed, what was pasted, what was
   copied, when the candidate left the window — and compare the submission
   against reference material.

This platform addresses both, and stores the review evidence in a shape a
reviewer can actually read.

## Core capabilities

| Capability | What it does |
| --- | --- |
| **Assessment generation** | Turns one description into a structured suite: roles, competency tree, problems, hidden test cases, scoring formula and per-problem integrity thresholds. |
| **Candidate sessions** | Registers a candidate, issues a short-lived scoped credential, and tracks a session through `in_progress → submitted → flagged → evaluated`, or `terminated`. |
| **Telemetry ingestion** | Accepts keystroke, paste, copy, code-delta, tab-switch, window-blur, developer-tools, fullscreen-exit and submission events. |
| **Integrity analysis** | Threshold-triggered analysis producing an advisory score, structured flags, a plagiarism report and behavioural anomalies. |
| **Review timeline** | Ordered, severity-classified timeline of everything the candidate did, beside their final submission. |
| **Duplicate suppression** | Replayed telemetry batches are recognised and cannot inflate integrity counters. |
| **Post-restart recovery** | A session whose in-memory projection was lost is rebuilt from its persisted record rather than silently reset. |

## Architecture

```
┌────────────────────────────┐        ┌─────────────────────────────┐
│  apps/console (Flutter)    │        │  Candidate client           │
│  reviewer UI               │        │  (telemetry producer)       │
└─────────────┬──────────────┘        └──────────────┬──────────────┘
              │  bearer: operator                    │  bearer: candidate
              ▼                                      ▼
      ┌───────────────────────────────────────────────────────┐
      │  apps/api — Hono (TypeScript)                          │
      │    auth middleware · route layer · integrity engine    │
      │    AI provider boundary (Gemini)                       │
      └───────────────────────────┬───────────────────────────┘
                                  │  MCP tools over HTTP, token-guarded
                                  ▼
      ┌───────────────────────────────────────────────────────┐
      │  packages/mcp-mongodb — tool registry + data layer     │
      │    one handler table shared by the HTTP and stdio      │
      │    transports                                          │
      └───────────────────────────┬───────────────────────────┘
                                  ▼
                            ┌──────────┐
                            │ MongoDB  │
                            └──────────┘
```

Design notes worth knowing:

* **One tool contract.** `packages/mcp-mongodb/src/tool-names.ts` is the single
  source of truth for MCP tool names. Both transports build from one handler
  table, and a test asserts that the API never hard-codes a tool string. The
  historical code maintained two tool tables that had already drifted apart.
* **One provider boundary.** Everything above `apps/api/src/agents/` depends on
  the `AssessmentAiClient` interface, so the provider is substitutable and tests
  never call a paid model.
* **Auth fails closed.** Production refuses to start without secrets. See
  [docs/security/threat-model.md](docs/security/threat-model.md).
* **UTC everywhere.** Persisted timestamps are UTC ISO-8601; local-time
  conversion happens in the viewer.

More detail: [docs/architecture.md](docs/architecture.md).

## Quick start

```sh
cp .env.example .env
docker compose up --build
```

MongoDB runs inside Compose, and the required indexes are created automatically
when the MCP tool server connects.

In the default `ENVIRONMENT=development`, the API generates ephemeral
credentials and prints the operator token once at startup:

```
[security] Development operator token: <generated>
```

Use it to exercise the reviewer endpoints:

```sh
curl -s http://localhost:8080/api/v1/sessions \
  -H "Authorization: Bearer <generated token>"
```

### AI credentials are required for generation

`POST /api/v1/generate` calls a paid AI provider. Set **one** of:

* `GEMINI_API_KEY` — a Gemini Developer API key from Google AI Studio (default), or
* `AI_PROVIDER_MODE=vertex` plus `GEMINI_VERTEX_PROJECT` and Application Default
  Credentials.

Without either, the API still starts and telemetry ingestion and review continue
to work; only generation returns `503`. The startup log says so explicitly.

### Running without Docker

```sh
npm ci
npm run build
docker compose up -d mongo      # or point MONGODB_URI at any MongoDB
npm run dev                     # MCP transport + API, with prefixed output
```

### Console

```sh
cd apps/console
flutter pub get
flutter run -d chrome \
  --dart-define=API_BASE_URL=http://localhost:8080 \
  --dart-define=API_TOKEN="<operator token>"
```

## Assessment workflow

1. **Generate.** An operator posts a description to `POST /api/v1/generate`. The
   input passes a deterministic pre-filter, then an AI classifier, then the
   generator. The resulting suite is persisted through the MCP tool surface.
2. **Register.** A candidate calls `POST /api/v1/identity/set` and receives a
   short-lived, candidate-scoped token.
3. **Attempt.** The candidate's client streams telemetry to
   `POST /api/v1/integrity/ingest` using that token.
4. **Analyse.** When configured thresholds are crossed and the submission has
   substance, the API runs an integrity analysis and stores the report. Identical
   code is never re-analysed.
5. **Review.** A reviewer opens `GET /api/v1/sessions` and then
   `GET /api/v1/sessions/:sessionId/review` for the full timeline, structured
   flags, similarity report and provisional score.
6. **Close.** The reviewer may terminate a session, which removes the session
   together with its telemetry and reports.

## Integrity signals

Signals are **advisory**. Each flag carries its own type, severity, confidence,
description and timestamp so a reviewer can verify it against the timeline.

| Signal source | Example indicator |
| --- | --- |
| Paste telemetry | A large block appeared in a single action |
| Copy telemetry | Submission content was copied out of the workspace |
| Tab switch / window blur | Focus left the assessment window repeatedly |
| Fullscreen exit | Fullscreen was abandoned |
| Developer tools | Browser developer tools were opened |
| Keystroke cadence | Typing speed that a human cannot plausibly sustain |
| Similarity | Structured match against reference material, with snippets |

No signal is presented as a conclusion. The console labels the score
"advisory only" in the interface itself.

## Configuration

One root [`.env.example`](.env.example) is the single configuration story; there
are no per-workspace environment files. See
[docs/configuration.md](docs/configuration.md) for every variable.

The values that matter most:

| Variable | Meaning |
| --- | --- |
| `ENVIRONMENT` | `development` (ephemeral credentials) or `production` (fail closed) |
| `ASSESSMENT_API_TOKEN` | Operator/reviewer credential |
| `ASSESSMENT_SESSION_SECRET` | Signing secret for candidate tokens (≥32 chars) |
| `CORS_ALLOWED_ORIGINS` | Explicit browser origin allow-list; never a wildcard |
| `GEMINI_API_KEY` | AI credential for assessment generation |
| `AI_MODEL` | Model identifier (default `gemini-2.5-flash`) |
| `ALERT_SCORE_THRESHOLD` | Integrity score above which an alert is raised |

## Privacy and security warning

* Telemetry is **candidate-personal data**. It records typing cadence, pasted and
  copied content, and window focus. Treat the database as sensitive.
* **The console's operator token is compiled into the Flutter web bundle.** A
  token passed with `--dart-define=API_TOKEN` ends up in the served JavaScript,
  where anyone who can load the page can read it. This is safe only for a
  local/trusted operator console on a machine you control. **Never use a real
  production operator token for a publicly hosted static console.** For a hosted
  deployment, put the console behind a reverse proxy or backend-for-frontend that
  injects the credential server-side, or keep the console off the public network.
  See [docs/configuration.md](docs/configuration.md#console-operator-token) and
  [docs/security/threat-model.md](docs/security/threat-model.md).
* **Registration proves authorization, not identity.** `POST
  /api/v1/identity/set` refuses to mint a candidate token without an
  operator-issued **registration capability** bound to that exact `candidateId`
  (and `assessmentId`, when bound). Knowing a candidate id is not enough to
  obtain a token for it, so a caller cannot reach an existing candidate's
  submitted code or integrity reports by guessing their id. What a capability
  proves is that the operator authorised the id and that the presenter holds the
  grant — **not** who the presenter is, and it is **not** one-time use. See
  [docs/configuration.md](docs/configuration.md#candidate-registration) and
  [Known limitations](#known-limitations).
* There is **no default credential**. Development mode generates ephemeral
  credentials and prints the operator token once; production refuses to start
  without secrets, and refuses to start with open candidate registration.
* CORS is an explicit allow-list and is never `*`.
* Telemetry free-text fields are length-bounded on ingestion, a batch is capped,
  and every route that accepts a body has a size ceiling applied before the body
  is parsed — so a hostile client cannot inflate storage or memory without limit.
* Report a vulnerability via [SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome;
please read the integrity-claims guidance there before writing user-facing text.

## Roadmap

* Live session streaming (the API is request/response today; the console
  refreshes on demand).
* Cross-candidate similarity search. The plagiarism report structure is settled,
  but reference completions are currently supplied by the caller.
* Reviewer authentication beyond a shared operator token.
* An adapter interface for the AI provider. The boundary already exists; a second
  provider has deliberately not been added.
* Console-provided telemetry capture. Telemetry submission is wired through the
  API client; the workspace capture widget is not part of this release.

## Release readiness

* Backend: builds, typechecks and the automated test suite passes (exact counts in
  [docs/release/verification.md](docs/release/verification.md)).
* Console: `flutter analyze` clean and `flutter test` passes.
* Container: image builds; a production start without secrets is proven to fail.
* Guards: credential guard and retired-identifier guard pass; gitleaks runs in CI.
* **Verified live:** one real assessment generation against the Gemini Developer
  API, parsed by the production parser and persisted through the MCP tool surface.
  Provider mode, model id, latency and parser result are recorded in
  [docs/release/verification.md](docs/release/verification.md).

## Known limitations

These are deliberate v0.1.0 boundaries. They are documented rather than hidden.

1. **Registration proves authorization, not identity.** `POST
   /api/v1/identity/set` requires an operator-issued registration capability bound
   to the candidate id being claimed, so knowing a candidate id is not enough to
   obtain a token for it. Three limits remain, stated plainly: a capability is
   **not one-time use** (it is signed, not stored, so a holder can replay it until
   it expires — a short TTL bounds the window), it can be **shared** with someone
   else, and it does not establish **who** the presenter is. A deployment that
   must know a candidate's real identity still verifies it at the edge. See
   [docs/configuration.md](docs/configuration.md#candidate-registration).
2. **The console operator token is embedded in the web bundle.** Safe for a
   local/trusted operator console only; not for a publicly served static build.
   The console now **withholds** an embedded token unless `API_BASE_URL` is
   loopback, or `ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set deliberately, so an
   accidental public deployment does not silently hand out operator access. For a
   hosted console, build without `API_TOKEN` and use the reference proxy in
   [`deploy/console-proxy/`](deploy/console-proxy/README.md), which injects the
   credential server-side. See
   [Privacy and security warning](#privacy-and-security-warning).
3. **Integrity output is advisory.** Flags and scores are signals for a human
   reviewer. Nothing in this system proves that a candidate cheated.
4. **Reference completions are caller-supplied.** The plagiarism report structure
   is settled, but the corpus it compares against is not built in.
5. **No reviewer accounts.** There is one shared operator credential; there is no
   per-reviewer identity, role or audit trail.
6. **Telemetry capture is client-side.** The API and console accept and display
   telemetry, but this repository does not ship a hardened candidate capture
   client.

## Provenance

This repository is an independent extraction of an earlier open-source
assessment product, taken from a specific historical commit. The full record is
in [docs/provenance.md](docs/provenance.md) and [NOTICE](NOTICE).

## License

[Apache License 2.0](LICENSE).
