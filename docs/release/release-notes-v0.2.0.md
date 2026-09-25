# tryveriqo v0.2.0 — Release candidate notes

> **Status: a draft. NOT PUBLISHED.**
>
> No `v0.2.0` tag exists, no GitHub Release has been created, and nothing has been
> pushed to a registry. These notes are prepared on the default branch and await an
> explicit publication decision.
>
> The current published artifact remains the **v0.1.0 pre-release**, at
> <https://github.com/Bilal-Lodhi/tryveriqo/releases/tag/v0.1.0>. Where v0.1.0's
> published claims were later found incomplete, that is recorded in
> [`errata-v0.1.0.md`](errata-v0.1.0.md) — v0.1.0 itself is not rewritten.
>
> This is still **not production ready**. Integrity output remains **advisory**: it
> produces signals for a human reviewer and never proves that a candidate cheated.

## What this release is

v0.1.0 was the first independent open-source release of tryveriqo. v0.2.0 is a
**correctness and security** release: it closes an authorization boundary defect,
bounds several resources that were previously unbounded, removes two places where
the product silently presented partial evidence as complete, and makes the console
refuse a credential-leak deployment rather than only documenting it.

It also contains one **behaviour change an operator must act on**:
candidate registration now requires an operator-issued capability. See
[Migration](#migration-from-v010).

## Security

### Candidate registration requires an operator-issued capability

`POST /api/v1/identity/set` previously accepted any `candidateId` from any caller,
with **no check that the id was unused**. Anyone who knew a candidate id could
obtain a token for that candidate — including an existing one — and read that
candidate's own `submittedCode` and integrity report history.

Registration now refuses to mint a token without a **registration capability**:

| Property | Value |
| --- | --- |
| Minted by | `POST /api/v1/identity/capability`, **operator credential only** |
| Format | `rv1.<base64url payload>.<base64url HMAC-SHA256>` |
| Bound to | One `candidateId`, and optionally one `assessmentId` |
| Lifetime | `REGISTRATION_CAPABILITY_TTL_SECONDS`, default 900s (range 30–86400) |
| Stored | **Nothing.** Signed, not persisted |
| Logged | **Never** |
| One-time use | **No** — see below |

The signing key is **derived** from `ASSESSMENT_SESSION_SECRET` under a
domain-separation label, so no new production secret is required and a capability
signature is not a valid candidate-token signature or the reverse.

**What a capability proves:** that the operator authorised this candidate id, and
that the presenter holds the operator's grant. **Nothing more.** It is **not**
verified human identity, KYC, biometrics, or proof that the presenter is the person
the id names.

**What it prevents:** a caller who knows a candidate id from obtaining a token for
it. Knowing a candidate id is no longer sufficient.

**What it does not solve:**

* It is **not one-time use.** It is signed rather than stored, so a holder can
  replay it until it expires. Statelessness and single-use are mutually exclusive
  without a consumed-capability store, and making registration depend on the
  datastore would be a reliability regression. A short TTL bounds the window;
  rotating `ASSESSMENT_SESSION_SECRET` revokes every outstanding capability at
  once.
* It can be **shared** with someone else.
* It does not verify **who** the presenter is. A deployment that must know a
  candidate's real identity still verifies it at the edge.

Every failure — missing, malformed, wrong signature, expired, wrong candidate,
wrong assessment — returns **one identical `403`**, so the endpoint is not an
oracle for which check failed or for whether a candidate id exists.

`CANDIDATE_REGISTRATION_MODE=open` restores the previous behaviour for local
development only. The API **refuses to start in production** with it, and an
unrecognised value falls back to `capability` so a typo cannot reopen it.

### Cross-candidate telemetry and session ownership

Ingestion decided who a batch belonged to from `events[0].candidateId` alone,
while the validator allowed a batch to name different candidates — so a caller
could send their own event first and a victim-attributed event second, and have
that content written into the victim session's stored code snapshot. Ingestion also
never compared the session's stored owner against the caller, so any caller holding
a known `sessionId` could write into that session regardless of the events'
`candidateId`.

Three rules are now enforced, because any one alone is insufficient:

1. a batch names **exactly one** candidate;
2. that candidate must **match the token**;
3. the batch must **own the session** — checked before the projection is created,
   cached or recovered.

Rule 3 is a data-integrity constraint as much as an authorization one: it also
stops the operator writing events attributed to one candidate into another's
session.

### Request-body ceilings

Nothing bounded a request body, and `POST /api/v1/identity/set` is unauthenticated
by design — so any caller on the network could make the process buffer an
arbitrarily large body.

| Route | Ceiling |
| --- | --- |
| `POST /api/v1/identity/*` | 16 KiB |
| `POST /api/v1/generate` | 64 KiB |
| `POST /api/v1/integrity/ingest` | 8 MiB |
| any other `/api/*` route (backstop) | 8 MiB |

Applied **before** the body is parsed, refused with `413` in the standard error
shape. The ceiling is checked against `Content-Length` when that header is
trustworthy and by counting the stream otherwise, so a missing or forged length
cannot bypass it. The MCP HTTP transport is bounded the same way.

Free text across one telemetry batch is additionally capped at **500,000
characters**, because the per-field and per-batch caps previously composed into
roughly 30 MB of legitimate content for a single request.

### Ingestion rate limiting and proxy-header trust

The limiter chose its bucket from `X-Forwarded-For` / `X-Real-Ip` — ordinary
request headers any direct client can set — so rotating one header **evaded every
limit**, including the cap on unauthenticated registration.

Those headers are now consulted only when `TRUST_PROXY_HEADERS` is explicitly
enabled (default off; only `true`/`1`/`yes` enable it). Telemetry ingestion is now
rate-limited, keyed **per candidate** rather than per connection, so candidates
behind one address do not share a budget. The bucket map is capped at 10,000
entries and evicts rather than grows.

### MCP tool dispatch

`dispatchTool` looked a handler up with a bare property access, so `constructor`,
`toString`, `hasOwnProperty`, `__proto__` and friends resolved to
`Object.prototype` members and were **invoked as though they were tools**,
returning `200` instead of the `404` the transport owes. Dispatch now uses an
own-property lookup.

### Console operator token

The console compiles `--dart-define=API_TOKEN` into the web bundle, where anyone
who can load the page can read it — that token grants full operator access. The
console now **withholds** an embedded token unless `API_BASE_URL` is loopback
(`localhost`, `127.x.x.x`, `::1`) or `ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set
deliberately, and explains why instead of showing a bare 401. A candidate session
token is unaffected.

This is a **guard against an accidental public deployment, not a secret store**: it
cannot make an embedded token confidential.

A reference reverse-proxy deployment ships in
[`deploy/console-proxy/`](../../deploy/console-proxy/README.md): an nginx template
that serves the static build and **overwrites** `Authorization` server-side, plus a
Dockerfile that refuses to start without the credential. Read its README: it fixes
**where the credential lives**, not **who may use it**.

## Correctness

### Session TTL is enforced

`SESSION_TTL_SECONDS` was parsed, documented and wired through Compose but had **no
consumer anywhere in the source** — a documented staleness horizon that did not
exist. It is now the enforced horizon for the API's in-memory session projection.
It bounds the projection **only**: the durable session, its telemetry and its
reports are never deleted by it.

Enforcing it exposed two recovery defects, both fixed: `submitted` was lost on
recovery (spending a fresh paid model call re-analysing an already-final answer),
and the last analysis was discarded (re-analysing unchanged code).

### The newest integrity report is selected

`integrity_reports` holds a series per session and the store returns it
newest-first, but review selected the **last array element** — the **oldest**
report — and derived the session's status and provisional `finalScore` from it. A
session analysed more than once displayed its earliest score and flags, and could
be reported as `submitted` when the newest report was above the alert threshold.
Selection is now by newest `generatedAt`, order-independent, in both the API and the
console.

A stored score that is not a finite number no longer produces `NaN`; it is bounded,
and an unusable score yields `finalScore: null` rather than a confident `100`.

### Reviewer evidence is complete or explicitly partial

`get_session_review` returned at most the newest 500 events and said nothing about
it — so the events dropped were the **oldest**, often where an assessment starts,
and a partial timeline read as the whole record. The cohort list undercounted the
same way.

| Field | Meaning |
| --- | --- |
| `timelineTotal` | True stored event count, from a count |
| `timelineReturned` | Events in this page |
| `timelineTruncated` | True when the page is not the whole record |
| `nextEventOffset` | Pass as `eventOffset` for the next older page, or `null` |

`GET /api/v1/sessions/:sessionId/review` accepts `eventLimit` (1–5000, default
500) and `eventOffset`; a malformed value is a `400`, never a silent substitution.
The cohort list reports the true total and marks per-type counts `countsSampled`
when they come from a page. The console shows a "Partial timeline: N of M" notice
with a **Load older events** control.

### Recovered counters are exact

Rebuilding a projection replays the fetched events, and that is at most one page —
so for a long session the reconstructed counters described the page, and those
counters feed `shouldAnalyze`. A long session could therefore fail to cross a
threshold it had in fact crossed. Recovery now takes its counters from a per-type
aggregation over **all** stored telemetry, and reports `countersExact`.

### The in-memory projection is bounded

`SessionState.events` and `keystrokeDeltas` were appended on every applied event
and never trimmed, so an authenticated candidate could grow one session's footprint
indefinitely. The projection now retains the newest 1,000 observations, 2,000
keystroke deltas and 50 pasted contents, while `*Observations` counters stay true
totals. Pasted content moved to its own window so trimming events cannot silently
change what an analysis is shown. Stored telemetry remains authoritative for review.

### The console no longer fabricates a generation result

The generate panel told the operator *"The suite was persisted for issue to
candidates"* whenever a suite came back — including when the API reported
`persisted: false`, meaning the store rejected the write. A cancelled request,
which the API answers with `200` and `success: false`, was reported as a completed
generation. Four distinct states are now rendered: saved,
generated-but-not-saved, cancelled, failed.

### The similarity report has a real comparison source

`analyzeIntegrity` took a `referenceCompletions` argument and the ingest route
passed an **empty array**, so similarity was measured against nothing. The source
is now the **stored assessment's own reference solution** — the suite's
`expectedAnswer` and `starterCode` for the session's problem — bounded to 3
references and 20,000 characters, with the source recorded on the report:

| Field | Meaning |
| --- | --- |
| `plagiarismReport.source.kind` | `assessment-solution`, or `none` |
| `source.suiteId` / `source.problemId` | Exactly what was compared |
| `source.count` | How many references were supplied |
| `source.reason` | Why there are none |

This relies on a session's `assessmentId` naming the suite's `suiteId`.

**Cross-candidate comparison was deliberately not chosen.** The model can echo a
matched snippet into `plagiarismReport`, which is returned to the candidate's own
review and is readable by that candidate — so a cross-candidate corpus would leak
one candidate's code to another. The assessment's own solution has the same
comparison value with none of that exposure. Nothing here scrapes, crawls, calls a
third party, or uses an external vector store.

**`PLAGIARISM_THRESHOLD` now has effect.** It was parsed into config, documented,
and never read. Similarity at or above it now adds an advisory
`SIMILARITY_ABOVE_THRESHOLD` flag. The flag is informational: the model's own
`overallScore` is left exactly as produced, so it cannot change a session's status
or trip `ALERT_SCORE_THRESHOLD` on its own. Its wording states the measurement and
refuses the conclusion — a correct, idiomatic solution can resemble the reference
without any copying.

### The credential guard is reproducible

It walked the working directory, so an untracked local file could fail it locally
while CI passed. It now inspects **tracked files** by default — exactly what CI
checks out — with `--include-untracked` as a labelled local pre-commit aid and a
nine-scenario `--self-test` wired into CI.

## Vertex AI transport

`AI_PROVIDER_MODE=vertex` has now been exercised against a real Google Cloud
project using Application Default Credentials, with **no API key configured**.

| Observation | Result |
| --- | --- |
| ADC discovery | **Worked** |
| Region (`us-central1`) | **Accepted** |
| Request reached the provider | **Yes** |
| Provider response | `403 PERMISSION_DENIED`, reason `BILLING_DISABLED` |
| Successful generation | **Not verified** |
| Parser against a live Vertex response | **Not verified** |

So ADC discovery, region acceptance, structured provider errors and the client's
terminal-error handling are verified against the real service — the parts a
request-construction test cannot reach. A **successful** generation is not, because
the project has billing disabled and Vertex requires it. Enabling billing is a
spend decision that was not taken.

**`gemini-api` remains the transport with recorded live success.** A deployment
choosing `vertex` should verify its own billing, project and region before relying
on it. See
[`verification.md`](verification.md#vertex-ai-transport-live-result-post-v010).

## Migration from v0.1.0

**One change requires operator action.** Full detail in
[`migration-v0.1.0-to-v0.2.0.md`](migration-v0.1.0-to-v0.2.0.md).

In short: registration now requires a capability, so an operator mints one per
candidate before that candidate registers. A deployment that relied on candidates
self-registering with only an id must either mint capabilities or set
`CANDIDATE_REGISTRATION_MODE=open` in development.

No database migration is required. No collection was renamed. No stored data is
rewritten.

## Known limitations

* **Not production ready.** No hosted instance, no published artifacts, no
  service-level agreement, and no load or denial-of-service testing.
* **Integrity output is advisory.** Flags and scores are triage aids. Nothing here
  proves misconduct, and a manipulated or low score is indistinguishable from a
  genuine one.
* **A registration capability is not identity verification** and is not one-time
  use. See [Security](#candidate-registration-requires-an-operator-issued-capability).
* **The console token guard is not a secret store.** An embedded token cannot be
  made confidential; the reference proxy fixes where the credential lives, not who
  may use it.
* **Vertex has not produced a live response.** See
  [Vertex AI transport](#vertex-ai-transport).
* **Similarity compares against the assessment's own solution**, not the open web
  and not other candidates. A high score is a similarity indicator, not a finding.
* **`POST /api/v1/generate` has no prompt-length bound** beyond its 64 KiB body
  ceiling, and a generation request reaches a paid model.
* **Rate limiting is a backstop.** A client rotating keys can displace other
  callers' buckets once the map is full: memory stays bounded, fairness does not.
  Put an edge limiter in front of a public deployment.
* **Telemetry capture is client-side.** This repository does not ship a hardened
  candidate capture client.
* **No live session streaming.** The API is request/response.
* **Single tenancy**, and one shared operator credential with no per-reviewer
  identity or audit log.
* **Code scanning is not enabled** on this repository, so "no dependency alerts"
  means *no known current alert*, not a clean bill of health.
* **Repository issue #1 remains open** for a successful Vertex generation, which
  needs a billing decision.

## Verification

The full record is in [`verification.md`](verification.md), and the release-gate
results are tabulated in
[`checklist-v0.2.0.md`](checklist-v0.2.0.md#f-release-gate-results).

| Check | Result |
| --- | --- |
| TypeScript typecheck and build | pass |
| API tests | **366 pass, 0 fail** |
| MCP tests | **78 pass, 0 fail** |
| Console tests | **38 pass, 0 fail** |
| `flutter analyze` / `dart format` | clean |
| Credential guard + its self-test | pass (137 tracked files, 9 scenarios) |
| Retired-identifier guard | pass (55 runtime files) |
| Container image build | pass |
| Fail-closed production startup (4 cases) | pass |
| `npm run smoke` against a live self-hosted stack | **17 pass, 0 fail** |
| `npm run verify` against a live self-hosted stack | **22 pass, 0 fail** |
| `GET /health` reports the prepared version | `service=tryveriqo-api version=0.2.0` |
| Relative documentation links resolve | pass (24 files) |
| Dependency audit | **0 vulnerabilities** |

Live-stack runs were made against a self-hosted Compose deployment, not a stub, and
the service identity was confirmed from `/health` before any workflow ran.

**One thing the gate found, and this release fixes:** a config census showed
`config.database.uri` was parsed and never read by the API — the API reaches the
datastore through the MCP tool surface, and the **MCP process** owns the MongoDB
connection and reads `MONGODB_URI` itself. The dead field is removed, `MONGODB_URI`
is documented as MCP-owned, and a new census test fails if any config field is ever
parsed and read by nothing again.

## Getting started

Unchanged from v0.1.0 except for registration. See the
[README](../../README.md) and [`docs/configuration.md`](../configuration.md).

## License

Apache-2.0. See [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
