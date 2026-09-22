# Threat model

## Scope

This document covers the Assessment Integrity Platform as it exists in this
repository: the API, the MCP tool surface, the MongoDB store, and the reviewer
console. It describes what the system protects, from whom, and — importantly —
what it does not claim.

## Assets

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| Candidate telemetry | Personal data: typing cadence, pasted and copied content, window focus | `micro_events` |
| Candidate submissions | The candidate's assessed work | `assessment_sessions.submittedCode` |
| Integrity reports | Allegations-adjacent analysis about a named person | `integrity_reports` |
| Generated assessments | Unreleased problems and hidden test cases | `generated_test_suites` |
| Operator credential | Unlocks generation (which spends money) and all candidate data | Environment only |
| AI provider credential | Billable and impersonable | Environment only |
| MCP tool token | Full datastore access | Environment only |

## Actors

| Actor | Capability | Trust |
| --- | --- | --- |
| Candidate | Holds a scoped candidate token; produces arbitrary telemetry | Untrusted input source |
| Reviewer / operator | Holds the operator credential; reads all candidate data | Trusted, but auditable |
| Anonymous internet caller | No credential | Untrusted |
| Instance operator | Controls environment and database | Trusted |
| AI provider | Receives submission content for analysis | Third party under contract |

## Threats and mitigations

### T1 — Anonymous access to candidate data

**Threat.** Anyone who can reach the API reads every candidate's telemetry,
submission and integrity report.

**Mitigation.** Session listing, session review, candidate reports and session
termination carry `requireOperator()`. Assessment generation carries
`requireOperator()` too, because it spends money. Verified by tests that assert
`401` for anonymous callers on each route.

**Residual.** Anyone who obtains the operator token has full read access. There is
no per-reviewer identity in v0.1.0. This is documented, not hidden, and is the
main reason the console must not be publicly hosted with a production token.

### T2 — Unauthenticated assessment generation (cost abuse)

**Threat.** An attacker drives the generation endpoint and burns the operator's
AI budget.

**Mitigation.** Operator credential required; in-process rate limit of 20
generation requests per minute per client address.

**Residual.** The rate limiter is per-process and keyed on a client-supplied
address header. Behind a proxy it is a backstop, not a defence. Put an edge
limiter in front of a public deployment.

### T3 — Candidate impersonation and cross-candidate access

**Threat.** A candidate submits telemetry as another candidate, or reads another
candidate's review.

**Mitigation.** Candidate tokens are HMAC-SHA256 signed over a payload carrying
the `candidateId`, verified in constant time, and expire. Ingestion compares the
token's `candidateId` against the event's and returns `403` on mismatch. Session
review resolves the owning candidate from the stored session, not from the
request, and refuses a candidate whose token does not own it. Verified by tests
for both directions.

**Residual.** Registration is unauthenticated by design: `POST
/api/v1/identity/set` accepts any `candidateId`. An attacker can mint a token for
any candidate id and submit *telemetry* attributed to them. This is a real,
accepted limitation of a self-hosted v0.1.0 — see "Accepted risks" below.

### T4 — Telemetry forgery to manufacture suspicion

**Threat.** A candidate submits fabricated paste or tab-switch events to inflate
another candidate's integrity score, or to test which thresholds trip.

**Mitigation.** Cross-candidate attribution is blocked (T3). Ingestion caps batch
size at 500 events and truncates free-text fields at 20,000 characters, so a
single request cannot exhaust storage.

**Residual.** Nothing binds a telemetry event to the candidate's actual browser.
The client is trusted with respect to *its own* session. Integrity signals are
therefore evidence to review, never proof — which is exactly how the product
presents them. A deployment that needs stronger provenance must add client
attestation, which is out of scope here.

### T5 — Provider credential theft

**Threat.** The AI provider key is read out of the image, the repository or a log.

**Mitigation.** The key is read from the environment only. There is no credential
file, no implicit filesystem discovery, and no key in `.env.example`. The
credential guard fails the build if an environment file, ADC file or key material
is present in the tree; gitleaks runs in CI. Logs record credential *presence*
("not detected"), never a value. Error responses are generic; provider messages
are logged server-side, not returned to callers.

### T6 — Unprotected MCP tool surface

**Threat.** The tool surface exposes unrestricted datastore read/write/delete. If
it is reachable, an attacker can read or destroy everything.

**Mitigation.** `MCP_AUTH_TOKEN` is compared in constant time; when set, every
request must present it. The transport binds loopback by default, so the tool
surface is not exposed unless explicitly configured. The only unauthenticated
endpoint is `GET /health`, which reports connectivity and a tool count and no
data. In production the transport refuses to start without a token.

**Residual.** In the default Compose development profile `MCP_AUTH_TOKEN` is
empty and the transport binds `0.0.0.0` inside the Compose network, because the
API reaches it across containers. It is not published to the host. Set the token
for any deployment that is not a local experiment.

### T7 — Secret and identifier leakage through the repository

**Threat.** A real cloud project id, connection string or key lands in Git.

**Mitigation.** Three layers:

1. `scripts/guards/credential-guard.mjs` — fails on environment files, ADC
   files, key material, private key blocks, a value set for any secret key in
   `.env.example`, and a real-looking cloud project id.
2. `scripts/guards/identifier-guard.mjs` — fails when a retired product's
   branding or product-specific vocabulary appears in the runtime.
3. gitleaks in CI over full history.

**Note.** The guard scripts must *name* the patterns they forbid. They are the
only files exempt from their own scans, and that exemption is explicit in code.

### T8 — Prompt injection through candidate content

**Threat.** A candidate submits code containing text intended to manipulate the
integrity analysis — for example, instructions to return a score of zero.

**Mitigation (partial).** The analysis response is parsed into a strict shape;
scores are clamped to 0–100; unknown severities fall back to `medium`; flag
descriptions are data, not instructions. The reviewer sees the raw submission
beside the flags and can verify them.

**Residual.** A model can still be influenced by content it is asked to judge,
and a manipulated report is indistinguishable from a genuine low score. This is
inherent to using a language model for this task. Treat integrity scores as a
**triage aid**, never as the decision. Cross-checking the timeline is the
mitigation, which is why the timeline is the primary review surface rather than
the score.

### T9 — Replayed telemetry inflating counters

**Threat.** A retrying or hostile client re-sends a batch, inflating paste counts
and tripping the analysis threshold on stale evidence.

**Mitigation.** Every applied event contributes a fingerprint over type, problem,
a one-second time bucket and payload. Duplicates are dropped without touching any
counter, and a replay is still durably persisted once. Verified by tests.

### T10 — Lost in-memory state across a restart

**Threat.** An API restart discards the session projection. A naive
reimplementation would recreate the session empty, losing the signal history the
reviewer depends on.

**Mitigation.** The durable write happens before counters move, and a session
absent from memory is rehydrated from its persisted record and stored telemetry.
`submittedCode` from the record is treated as authoritative over reconstructed
code. Verified by tests.

### T11 — Denial of service

**Threat.** A client floods ingestion or generation.

**Mitigation.** In-process rate limits on the two amplification endpoints; a
500-event batch cap; field-length truncation; MCP calls are timeout-isolated so a
slow datastore degrades rather than holds a request open; AI calls have both a
retry policy and a hard timeout.

**Residual.** Not a hardened DoS defence. A determined attacker can exhaust a
self-hosted instance.

### T12 — Cross-site request forgery and origin abuse

**Threat.** A malicious page drives the API from a victim's browser.

**Mitigation.** CORS is an explicit allow-list; a `*` entry in configuration is
discarded. `credentials: false`, so cookie-based ambient authority is not usable.
The API authenticates with a bearer token that a third-party page cannot read.

**Residual.** CORS is a browser control only. Server-to-server callers are
unaffected, which is why T1 and T2 do not rely on it.

### T13 — Local time stored instead of UTC

**Threat.** Timelines produced in different time zones become non-comparable,
which is a correctness problem for review evidence rather than a classic
security one.

**Mitigation.** Storage is UTC ISO-8601. The rejected alternative is recorded in
`docs/provenance.md` and in the changelog so it is not reintroduced.

## Accepted risks

These are deliberate, documented limitations of a self-hosted v0.1.0:

1. **Open candidate registration.** Any caller can register any `candidateId` and
   receive a valid token for it. Candidate tokens scope *telemetry submission*,
   not eligibility. A deployment with untrusted candidates must verify identity
   at the edge before issuing a token.
2. **Single shared operator credential.** No per-reviewer identity, no RBAC, no
   audit log of who read what.
3. **Console token in the bundle.** Documented in `SECURITY.md` and in the
   console README; it is a reason not to host the console publicly.
4. **Advisory-only integrity signals.** No output is proof of misconduct, and the
   product says so in its own UI.
5. **Single tenancy.** There is no tenancy model, so there is nothing to bypass,
   and nothing that isolates one operator's data from another's.

## What would change the model

Deliberately listed so a future release can plan for them:

* Verifying candidate eligibility before token issuance.
* Per-reviewer credentials and an access log.
* Client attestation for telemetry provenance.
* An external similarity corpus, which turns the similarity report from
  caller-supplied references into a real plagiarism check.
* Multi-tenancy, if the product ever needs it.
