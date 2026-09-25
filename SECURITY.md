# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `v0.1.0` (pre-release) | Yes — current |
| Anything older | No — there is no older version |

`v0.1.0` is published as a **pre-release**. It is not production ready, and no
version has been designated stable. Security fixes are applied to the default
branch and to the current pre-release line; there are no maintained older
versions.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through this repository's
[private vulnerability reporting](https://github.com/Bilal-Lodhi/tryveriqo/security/advisories/new),
which is enabled. That is the preferred channel and it keeps the report private
between you and the maintainer. If it is unavailable to you for any reason, open a
minimal public issue that says only that you have a security report and asks for a
private channel — do not put the details in the issue.

Please include:

* what you did, and what you observed;
* the version from `GET /health`;
* the affected endpoint or component;
* the impact you believe it has;
* any proof of concept, with **candidate data and credentials redacted**.

We aim to acknowledge a report within a few days. There is no bug bounty.

## Threat model

The full model, including what is explicitly out of scope, is in
[docs/security/threat-model.md](docs/security/threat-model.md). In brief, the
protected assets are:

* candidate telemetry and submissions (personal data);
* the operator credential (assessment generation spends money);
* the MCP tool surface (unrestricted datastore access).

## Security properties this project claims

* **No default credential.** Development mode generates an ephemeral operator
  token and session secret for that process and prints the operator token once.
  Production refuses to start without `ASSESSMENT_API_TOKEN`,
  `ASSESSMENT_SESSION_SECRET`, `CORS_ALLOWED_ORIGINS` and an AI credential.
* **Fail closed.** The production check runs before the listener binds.
* **Sensitive routes are protected.** Session listing, session review, candidate
  reports, session termination and assessment generation require a credential.
* **Candidate credentials are scoped.** A candidate token is an HMAC-signed,
  short-lived token confined to one `candidateId`. Ingestion accepts a batch
  naming only that candidate, refuses a batch attributed to anyone else, and
  refuses a session owned by anyone else — so a candidate cannot write into
  another candidate's record. A candidate cannot enumerate the cohort or review a
  foreign session.
* **Registration requires operator authorization.** `POST /api/v1/identity/set`
  refuses to mint a candidate token without a registration capability: an
  HMAC-signed, short-lived grant the operator created for that exact
  `candidateId` (and `assessmentId`, when bound). Knowing a candidate id is not
  enough to obtain a token for it. Every capability failure returns one identical
  `403`, so the endpoint does not reveal whether a candidate id exists.
* **Constant-time comparison** is used for the operator token and for token and
  capability signatures.
* **No wildcard production CORS.** Origins are an explicit allow-list.
* **No credentials in logs.** Only credential *presence* is logged, never a
  value — including registration capabilities.
* **Request bodies are bounded.** Every route that accepts a body has a ceiling
  applied before the body is parsed, so an unauthenticated caller cannot make the
  process buffer an arbitrarily large body. The MCP HTTP transport is bounded the
  same way.
* **Telemetry is bounded.** Field lengths, free text per batch, and batch size are
  all capped on ingestion.
* **The MCP tool surface is separately protected** by `MCP_AUTH_TOKEN`, and in
  production it refuses to start without one.

## What is explicitly out of scope

* **Proctoring guarantees.** This software cannot know whether a candidate
  cheated. It records signals. Report a bug in a signal, not the fact that a
  signal is not proof.
* **Console credential storage.** The Flutter console compiles its operator token
  into the bundle, where anyone who can load the page can read it. That is
  documented and is not considered a vulnerability; it is a reason never to use a
  production operator token for a publicly served static build. Safe usage is a
  local/trusted operator console, or a reverse proxy that injects the credential
  server-side. The console **enforces** this rather than only documenting it: an
  embedded token is withheld unless `API_BASE_URL` is loopback, or
  `ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set deliberately. That guard prevents an
  accidental public deployment from becoming an operator-access leak; it cannot
  make an embedded token confidential. A reference proxy deployment is in
  [`deploy/console-proxy/`](deploy/console-proxy/README.md) — note that it fixes
  *where the credential lives*, not *who may use it*. See
  [docs/configuration.md](docs/configuration.md#console-operator-token).
* **Candidate identity verification.** Registration proves that the operator
  authorised a candidate id and that the presenter holds that grant. It does not
  verify *who* the presenter is. A registration capability is also **not
  one-time use** — it is signed, not stored, so a holder can replay it until it
  expires — and it can be shared. A deployment that must know a candidate's real
  identity has to verify it at the edge. See
  [docs/configuration.md](docs/configuration.md#candidate-registration) and
  [docs/security/threat-model.md](docs/security/threat-model.md) (T3).
* **Denial of service against a self-hosted instance.** In-process rate limiting
  exists to bound accidental amplification, not to withstand a determined
  attacker. Put an edge limiter in front of a public deployment.
* **Multi-tenancy and organisation isolation.** The design is single-tenant by
  intent. There is no tenancy model to bypass.
