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
* **Constant-time comparison** is used for the operator token and for token
  signatures.
* **No wildcard production CORS.** Origins are an explicit allow-list.
* **No credentials in logs.** Only credential *presence* is logged, never a
  value.
* **Telemetry is bounded.** Field lengths and batch size are capped on
  ingestion.
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
  local/trusted operator console, or a reverse proxy / backend-for-frontend that
  injects the credential server-side. See
  [docs/configuration.md](docs/configuration.md#console-operator-token).
* **Open candidate registration.** `POST /api/v1/identity/set` accepts any
  `candidateId` from any caller and mints a token scoped to exactly that id, with
  no check that the id is unused. A token cannot be widened to reach a third
  party, and cross-candidate writes are refused with `403`. The residual is a
  **read** exposure: a token for a known candidate id grants access to that
  candidate's own session reviews, submitted code and integrity reports, and can
  submit telemetry attributed to them. That is stronger than hijacking an unused
  id, and a deployment with untrusted candidates must close it at the edge before
  issuing a token. See
  [docs/security/threat-model.md](docs/security/threat-model.md) and issue #2.
* **Denial of service against a self-hosted instance.** In-process rate limiting
  exists to bound accidental amplification, not to withstand a determined
  attacker. Put an edge limiter in front of a public deployment.
* **Multi-tenancy and organisation isolation.** The design is single-tenant by
  intent. There is no tenancy model to bypass.
