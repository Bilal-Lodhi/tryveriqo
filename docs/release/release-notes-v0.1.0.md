# tryveriqo v0.1.0 — First Independent Open-Source Release

> **Pre-release.** This is the first independent open-source release of tryveriqo.
> It is **not production ready**, and its integrity output is **advisory**: it
> produces signals for a human reviewer and never proves that a candidate cheated.

## What this is

tryveriqo is an open-source, self-hostable platform for generating online
assessments and giving reviewers evidence-based integrity signals about how
candidates completed them.

It solves two separate problems. **Authoring**: turning one description into a
structured question set — roles, competencies, problems, hidden test cases,
scoring formulas and per-problem integrity thresholds — is slow and repetitive.
**Review**: once candidates have submitted, a reviewer needs to reconstruct *how*
a submission was produced and compare it against reference material.

It is **not proctoring software**. It records and organises signals; a human makes
the judgement.

## Highlights

- **Assessment generation** from a single description, producing a structured
  suite with roles, a competency tree, problems, hidden test cases, scoring
  formulas and per-problem integrity thresholds.
- **Candidate sessions** with short-lived, candidate-scoped credentials and a full
  lifecycle: `in_progress → submitted → flagged → evaluated`, or `terminated`.
- **Telemetry ingestion** for nine event types, with duplicate suppression that
  cannot inflate counters and post-restart recovery of a lost in-memory
  projection.
- **Integrity analysis** producing an advisory score, structured flags, a
  similarity report and behavioural anomalies — deliberately described as signals,
  never as findings.
- **A reviewer console** that puts the submitted code beside the candidate's
  telemetry timeline.
- **Security by default**: fail-closed production startup, no default credential,
  an explicit CORS allow-list, and a token-guarded tool surface.
- **One command to self-host**: `cp .env.example .env && docker compose up --build`.

## Architecture and components

| Component | Role |
| --- | --- |
| `apps/api` | Hono (TypeScript) HTTP API: auth boundary, route layer, integrity engine, AI provider boundary |
| `packages/mcp-mongodb` | Model Context Protocol tool registry and MongoDB data layer, shared by one handler table across an HTTP and a stdio transport |
| `apps/console` | Flutter reviewer console (web or desktop) |
| MongoDB | Durable store for suites, sessions, telemetry and integrity reports |

Three design commitments are worth calling out:

- **One tool contract.** The MCP tool names have a single source of truth, and a
  test asserts the API never hard-codes a tool string.
- **One provider boundary.** Everything above `apps/api/src/agents/` depends on the
  `AssessmentAiClient` interface, so the provider is substitutable and the test
  suite never calls a paid model.
- **UTC everywhere.** Persisted timestamps are UTC ISO-8601; conversion happens in
  the viewer.

## Security and auth model

Two credential kinds exist, and only two:

- **Operator token** — a high-entropy shared secret that unlocks assessment
  generation (which spends money) and every reviewer surface.
- **Candidate token** — a short-lived, HMAC-SHA256-signed token scoped to a single
  `candidateId`, minted by candidate registration.

Properties: constant-time comparison for the operator token and for token
signatures; no default credential of any kind; production refuses to start without
`ASSESSMENT_API_TOKEN`, `ASSESSMENT_SESSION_SECRET`, `CORS_ALLOWED_ORIGINS` and an
AI credential; CORS is an explicit allow-list and a `*` entry is discarded; the
MCP tool surface is separately token-guarded and refuses an unprotected production
start; and only credential *presence* is ever logged, never a value.

Three limitations are documented rather than hidden, and a deployment must account
for them:

1. **Candidate registration is unauthenticated.** Any caller may register any
   `candidateId`. The token grants access only to that identity's own data —
   cross-candidate access is refused with `403` — but a caller can claim an unused
   identity. Untrusted-candidate deployments must verify identity at the edge.
2. **The console's operator token is compiled into the web bundle.** A token passed
   with `--dart-define=API_TOKEN` is readable by anyone who can load the page.
   Safe only for a local/trusted console, or behind a reverse proxy that injects
   the credential server-side. Never use a production operator token in a publicly
   served static build.
3. **There is one shared operator credential.** No per-reviewer identity, no RBAC,
   no access log.

## Verification evidence

Everything below was executed and observed; nothing is projected. The full record
is in
[`docs/release/verification.md`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/docs/release/verification.md).

| Check | Result |
| --- | --- |
| Backend tests (`@assessment/api`) | 154 pass, 0 fail |
| Backend tests (`@assessment/mcp-mongodb`) | 33 pass, 0 fail |
| `flutter analyze` / `flutter test` | no issues / 6 pass |
| `dart format --set-exit-if-changed` | clean |
| Container image build | pass |
| Compose stack | `mongo`, `mcp`, `api` all healthy |
| Production start without secrets | fails closed, exit 1, naming every missing value |
| Production MCP start without a token | fails closed, exit 1 |
| Child-process supervision | transport death terminates the container, exit 1 |
| `scripts/smoke.mjs` | 15 pass, 0 fail |
| `scripts/verify-lifecycle.mjs` | 15 pass, 0 fail |
| Live end-to-end assessment workflow | 25 pass, 0 fail |
| **Live AI provider call** | **verified** — `gemini-api` / `gemini-2.5-flash` |
| Dependency licence audit | 184 packages, 0 copyleft, 0 unknown |
| CI on the published commit | all four jobs green |

The live provider run exercised the real `AssessmentAiClient` boundary, parsed the
model's response through the production parser, and persisted the resulting suite
through the MCP tool surface into MongoDB. It also **found two real defects that no
fixture had caught**, both fixed in this release: every generated suite collided on
one `suiteId` because the model returns a fixed placeholder UUID, and container
child-process supervision never noticed the tool transport dying.

## Known limitations

- **Not production ready.** No hosted instance, no published artifacts, no service
  level agreement, and no load or denial-of-service testing.
- **Integrity output is advisory.** Flags and scores are triage aids. Nothing here
  proves misconduct, and a manipulated or low score is indistinguishable from a
  genuine one.
- **Vertex AI transport is not live-verified.** It is implemented and covered by
  request-construction tests; only the Gemini Developer API path has been exercised
  end to end.
- **Reference completions for similarity analysis are caller-supplied.** There is
  no built-in corpus, so this is not yet a plagiarism check against the open web.
- **Telemetry capture is client-side.** This repository does not ship a hardened
  candidate capture client.
- **No live session streaming.** The API is request/response and the console
  refreshes on demand.
- **Single tenancy.** There is no tenancy model.

## Migration and provenance

This repository is an independent extraction of an earlier open-source assessment
product, taken from a specific historical commit and then substantially changed: a
new repository layout, build, container and CI setup; a mandatory authentication
and authorisation boundary that did not exist in the source; a consolidated
MongoDB schema and a single MCP tool registry; and revised configuration and
documentation.

The extraction deliberately stops at the point where that earlier product pivoted
to a different domain. Nothing from that successor product — its branding,
vocabulary or domain identifiers — is present in this codebase, and a guard
enforces that on every push.

The Apache-2.0 source copyright notice is retained verbatim in
[`LICENSE`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/LICENSE) as the
licence requires, with the derivative notice recorded beside it. The full
derivation, including what was ported, adapted and rejected, is in
[`docs/provenance.md`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/docs/provenance.md)
and [`NOTICE`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/NOTICE).

## Getting started

```sh
git clone https://github.com/Bilal-Lodhi/tryveriqo.git
cd tryveriqo
cp .env.example .env
docker compose up --build
```

`POST /api/v1/generate` needs an AI credential: either `GEMINI_API_KEY` for the
Gemini Developer API, or `AI_PROVIDER_MODE=vertex` with a Google Cloud project and
Application Default Credentials. Without one, the API still starts and telemetry
ingestion and review continue to work; only generation returns `503`.

See the
[README](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/README.md) and
[`docs/configuration.md`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/docs/configuration.md)
for the full configuration story, and
[`docs/security/threat-model.md`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/docs/security/threat-model.md)
before exposing an instance to a network.

## Contributing

Issues and pull requests are welcome. Please read
[`CONTRIBUTING.md`](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/CONTRIBUTING.md)
first, particularly the guidance on not overstating what an integrity signal means.
Security problems should be reported privately through
[private vulnerability reporting](https://github.com/Bilal-Lodhi/tryveriqo/security/advisories/new),
never as a public issue.

## License

[Apache License 2.0](https://github.com/Bilal-Lodhi/tryveriqo/blob/main/LICENSE).
Offered as-is, without warranty.
