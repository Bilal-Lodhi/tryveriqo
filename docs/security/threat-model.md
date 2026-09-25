# Threat model

## Scope

This document covers tryveriqo as it exists in this
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
the `candidateId`, verified in constant time, and expire.

**Registration requires an operator-issued capability.** `POST
/api/v1/identity/set` refuses to mint a token without a registration capability
that is signed by the server, unexpired, and bound to the `candidateId` being
claimed — and to the `assessmentId` too when the operator bound one. Possessing a
candidate id is therefore no longer sufficient; the caller must also hold a grant
the operator created for exactly that candidate. Every failure — missing,
malformed, wrong signature, expired, wrong candidate, wrong assessment — returns
one identical `403`, so the endpoint is not an oracle for which check failed or
for whether a candidate id exists.

Ingestion enforces three further rules, because checking any one of them alone is
not enough:

1. **One candidate per batch.** `validateIngestRequest` refuses a batch whose
   events name more than one `candidateId`, so a caller cannot smuggle events
   attributed to someone else behind a first event of their own. This is an
   authorization boundary, not a tidiness rule — the route decides who a batch
   belongs to from the batch itself.
2. **The batch must match the token.** Ingestion compares the token's
   `candidateId` against the batch's and returns `403` on mismatch.
3. **The batch must own the session.** A batch may only be folded into a session
   whose stored owner is that same candidate, checked before the projection is
   created, cached or recovered. This is a data-integrity rule as much as an
   authorization one: without it any caller, including the operator, could write
   events attributed to one candidate into a session owned by another — and have
   that content written into the other candidate's stored code snapshot.

Session review resolves the owning candidate from the stored session, not from
the request, and refuses a candidate whose token does not own it. Verified by
tests for every direction, including the mixed-batch, foreign-session and
capability-mismatch cases.

**Residual.** What a capability proves is that the operator authorised this
candidate id, and that the presenter holds the operator's grant. It is not
verified human identity, and it does not prove the presenter is the person the id
names. Remaining limitations, stated rather than implied:

* **A capability is not one-time use.** It is signed, not stored, so it can be
  replayed by whoever holds it until it expires. Statelessness and single-use are
  mutually exclusive without a consumed-capability store, and making registration
  depend on the datastore would be a reliability regression. The window is
  bounded by `REGISTRATION_CAPABILITY_TTL_SECONDS` (default 15 minutes), and
  rotating `ASSESSMENT_SESSION_SECRET` revokes every outstanding capability at
  once.
* **A capability can be shared.** Whoever holds it can register as that
  candidate. The product does not attempt to bind it to a person or a device.
* **Capability issuance is not rate-limited per candidate.** The endpoint is
  operator-only and bounded per caller, but one operator can mint many.
* **Identity verification at the edge is still the deployment's job** if it must
  know *who* a candidate is. The product verifies authorization to claim an id,
  not the claimant's identity.

`CANDIDATE_REGISTRATION_MODE=open` restores the pre-existing unauthenticated
behaviour for local development. It is refused at startup in production, and an
unrecognised value falls back to `capability` so a typo cannot reopen it.

### T4 — Telemetry forgery to manufacture suspicion

**Threat.** A candidate submits fabricated paste or tab-switch events to inflate
another candidate's integrity score, or to test which thresholds trip.

**Mitigation.** Cross-candidate attribution is blocked by the three ingestion
rules in T3: a batch names one candidate, that candidate must match the token,
and the batch must own the target session. Forged events can therefore only
pollute the submitting candidate's *own* record. Ingestion caps batch size at
500 events and truncates free-text fields at 20,000 characters, so a single
request cannot exhaust storage.

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

**Threat.** A client floods ingestion or generation, or makes the process buffer
an unbounded request body.

**Mitigation.**

* **Request-body ceilings, per route, applied before anything parses a body.**
  The unauthenticated `POST /api/v1/identity/set` is the one that matters most:
  before this existed, any caller on the network could make the process buffer an
  arbitrarily large body. Registration and capability issuance are capped at
  16 KiB, generation at 64 KiB, ingestion at 8 MiB, with an 8 MiB backstop for
  `/api/*`. The ceiling is checked against `Content-Length` when that header is
  trustworthy and by counting the stream otherwise, so a missing or forged length
  cannot bypass it. The MCP HTTP transport applies the same treatment.
* **A batch free-text budget.** The per-field (20,000 characters) and per-batch
  (500 events) caps previously composed into roughly 30 MB of legitimate content
  for one request. Free text across a batch is now capped at 500,000 characters,
  which keeps the documented caps coherent with the body ceiling.
* In-process rate limits on registration, capability issuance, generation and
  ingestion; a 500-event batch cap; field-length truncation; MCP calls are
  timeout-isolated so a slow datastore degrades rather than holds a request open;
  AI calls have both a retry policy and a hard timeout.
* **Rate-limit keys are not attacker-controlled by default.** `X-Forwarded-For`
  and `X-Real-Ip` are ordinary request headers, so keying on them meant rotating
  one header defeated every limit, including the one on unauthenticated
  registration. They are consulted only when `TRUST_PROXY_HEADERS` is explicitly
  enabled, and only the exact strings `true`/`1`/`yes` enable it. The bucket map
  is capped at 10,000 entries and evicts rather than grows.

**Residual.** Not a hardened DoS defence. A determined attacker can exhaust a
self-hosted instance. In-process rate limiting remains a backstop rather than an
edge control (accepted risk 6). A client rotating rate-limit keys can displace
other callers' buckets once the map is full — memory stays bounded, but fairness
does not. And `POST /api/v1/generate` has no prompt-length bound beyond its 64 KiB
body ceiling, so an authenticated operator can still send a large prompt to a paid
model.

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

1. **Registration proves authorization, not identity.** Registration requires an
   operator-issued capability bound to the candidate id (see T3). What that
   proves is that the operator authorised this candidate id and that the
   presenter holds the grant — not that the presenter is the person the id names.
   A capability is also **not one-time use**: it is signed, not stored, so a
   holder can replay it until it expires. A deployment that must know *who* a
   candidate is still has to verify identity at the edge, and one that needs
   single-use grants needs a consumed-capability store this design deliberately
   does not have.
2. **Single shared operator credential.** No per-reviewer identity, no RBAC, no
   audit log of who read what.
3. **Console token in the bundle.** Documented in `SECURITY.md` and in the
   console README; it is a reason not to host the console publicly. The console
   withholds an embedded token unless `API_BASE_URL` is loopback, or
   `ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set deliberately, which bounds the
   accident rather than the class: an embedded token still cannot be made
   confidential, and the reference proxy in `deploy/console-proxy/` fixes where
   the credential lives, not who may use it.
4. **Advisory-only integrity signals.** No output is proof of misconduct, and the
   product says so in its own UI.
5. **Single tenancy.** There is no tenancy model, so there is nothing to bypass,
   and nothing that isolates one operator's data from another's.
6. **No load, stress or denial-of-service testing.** The in-process rate limits
   exist to bound accidental amplification, not to withstand a determined
   attacker, and they have not been tested under load. A public deployment needs
   an edge limiter in front of it. Nothing here is a capacity or resilience claim.
7. **The Vertex AI transport has not produced a live response.** It is implemented
   and covered by request-construction tests, and a live call against a real
   project with Application Default Credentials has since been made — that call
   authenticated, reached the provider and returned a structured
   `BILLING_DISABLED` refusal, so ADC discovery, region acceptance and the client's
   terminal-error handling are verified against the real service. A **successful**
   generation is not: the parser has never seen a live Vertex response shape. A
   deployment choosing `AI_PROVIDER_MODE=vertex` is relying on a path with no
   recorded live success; `gemini-api` is the one with recorded evidence. See
   [docs/release/verification.md](../release/verification.md#vertex-ai-transport-live-result-post-v010).

### Telemetry sensitivity

Telemetry is the most sensitive data this system holds and it deserves to be
stated plainly rather than implied. It records **typing cadence, the content of
pasted and copied text, and window focus over time** for a named individual, and
the integrity reports built from it are allegations-adjacent. Treat the database
as personal data:

* access is limited to the operator credential, but that credential is shared and
  there is no per-reviewer audit trail (accepted risk 2);
* there is no retention or deletion policy beyond terminating a session, which
  removes that session with its telemetry and reports;
* a deployment is responsible for its own lawful basis, retention window and
  subject-access handling. This software does not implement any of those.

## What would change the model

Deliberately listed so a future release can plan for them:

* Verifying candidate eligibility before token issuance.
* Per-reviewer credentials and an access log.
* Client attestation for telemetry provenance.
* An external similarity corpus, which turns the similarity report from
  caller-supplied references into a real plagiarism check.
* Multi-tenancy, if the product ever needs it.
