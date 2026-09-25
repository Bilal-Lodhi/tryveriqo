# Configuration

One file is the source of truth: [`.env.example`](../.env.example) at the
repository root. Copy it and fill in what you need.

```sh
cp .env.example .env
```

There are no per-workspace environment files. The historical project had one per
service plus a separate root file, and they disagreed; that was removed.

## Modes

| `ENVIRONMENT` | Behaviour |
| --- | --- |
| `development` (default) | Missing secrets are generated per process. The operator token is printed once. Relaxed CORS defaults (localhost). |
| `test` | Used by the automated tests. Silent request logging, no implicit origins. |
| `production` | Startup fails closed unless every required value is set. |

Development is explicit, not silent: the API logs that it generated a credential
and why. Nothing is persisted between runs, so a restart in development
invalidates candidate tokens.

## Reference

### Runtime

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `ENVIRONMENT` | `development` | — | Runtime mode |
| `API_PORT` | `8080` | — | Host port Compose publishes the API on |
| `MONGO_PORT` | `27017` | — | Host port Compose publishes MongoDB on |

### Datastore

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `MONGODB_URI` | `mongodb://mongo:27017` | — | Connection string. Inside Compose this is the bundled service |
| `MONGODB_DATABASE` | `assessment` | — | Database name. Collections and indexes are created automatically. The bundled Compose stack overrides this to `tryveriqo` |

### MCP tool transport

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `MCP_SERVER_ENDPOINT` | `http://mcp:3001` | — | Where the API reaches the tool surface |
| `MCP_TIMEOUT_MS` | `5000` | — | Per-call timeout |
| `MCP_AUTH_TOKEN` | *(empty)* | **yes** | Shared token for the tool surface |
| `MCP_PORT` | `3001` | — | Transport port |
| `MCP_HOST` | `127.0.0.1` | — | Bind interface. Set `0.0.0.0` only when the transport is its own container |
| `ASSESSMENT_MCP_IN_PROCESS` | `true` | — | Entrypoint switch: start the transport in the same container |

### Authentication

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `ASSESSMENT_API_TOKEN` | *(empty)* | **yes** | Operator/reviewer credential. Grants generation and every reviewer surface |
| `ASSESSMENT_SESSION_SECRET` | *(empty)* | **yes** | Signing secret for candidate tokens and registration capabilities. Minimum 32 characters |
| `CANDIDATE_SESSION_TTL_SECONDS` | `7200` | — | Candidate token lifetime |
| `CANDIDATE_REGISTRATION_MODE` | `capability` | — | `capability` (default) or `open`. `open` is refused in production |
| `REGISTRATION_CAPABILITY_TTL_SECONDS` | `900` | — | Registration capability lifetime, clamped to 30–86400 |

Generate a secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating `ASSESSMENT_SESSION_SECRET` invalidates every outstanding candidate
token **and** every outstanding registration capability. That is the intended
lever for ending all candidate sessions at once, or for revoking capabilities
that were handed out but not yet used.

### Rate limiting

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRUST_PROXY_HEADERS` | `false` | Trust `X-Forwarded-For` / `X-Real-Ip` for rate-limit bucket keys |

In-process limits, per bucket, per minute:

| Endpoint | Limit | Bucket key |
| --- | --- | --- |
| `POST /api/v1/identity/set` | 30 | client address |
| `POST /api/v1/generate` | 20 | client address |
| `POST /api/v1/identity/capability` | 60 | client address |
| `POST /api/v1/integrity/ingest` | 240 | authenticated candidate, else address |

Ingestion is keyed per **candidate** rather than per connection so that candidates
behind one address — a shared NAT, a campus network — do not share a budget. The
operator credential falls back to the address.

`TRUST_PROXY_HEADERS` defaults to **false**, and that default is the
security-relevant one. `X-Forwarded-For` and `X-Real-Ip` are ordinary request
headers that any direct client can set, so keying on them without a proxy in front
means rotating one header evades every limit above. Enable it **only** when every
request reaches this process through a proxy you control that overwrites those
headers. Only the exact strings `true`, `1` or `yes` enable it, so a typo leaves
the safe default.

The bucket map is capped at 10,000 entries and evicts rather than grows: expired
buckets first, and if every bucket is still live the soonest-to-expire one is
dropped. A client rotating keys therefore cannot grow it without bound — though
note that eviction also means such a client can displace other callers' buckets.

These are backstops, not a hardened DoS defence. Put an edge limiter in front of a
public deployment.

### Request limits

Every route that accepts a body has a ceiling, applied **before** the body is
parsed. Registration and capability issuance carry only short strings, so they are
capped tightly; ingestion legitimately carries a telemetry batch.

| Route | Body ceiling |
| --- | --- |
| `POST /api/v1/identity/*` | 16 KiB |
| `POST /api/v1/generate` | 64 KiB |
| `POST /api/v1/integrity/ingest` | 8 MiB |
| any other `/api/*` route (backstop) | 8 MiB |

An oversized body is refused with `413` and the same JSON error shape as every
other failure. The ceiling is checked against `Content-Length` when that header
is present, and by counting the stream when it is not, so a missing or forged
length cannot bypass it. The MCP HTTP transport caps a tool-call body at 8 MiB
the same way.

The telemetry caps compose as follows, and all three are enforced:

| Limit | Value |
| --- | --- |
| Events per batch | 500 |
| Characters per free-text field (`pasteContent`, `selectedText`, `diffPatch`) | 20,000 |
| Characters of free text across one batch | 500,000 |

The batch-wide budget exists because the other two together permit far more than
anyone intended: 500 × 3 × 20,000 characters is roughly 30 MB for a single
request. Exceeding it is a `400` naming the batch, not a silent truncation.

`POST /api/v1/generate` has **no** prompt-length bound beyond the 64 KiB body
ceiling, and a generation request reaches a paid model. The ceiling is the
effective limit today; a tighter per-field bound would be a better one.

### In-memory session projection

The API keeps a live projection of each active session so integrity thresholds can
be evaluated on the ingestion hot path without a datastore round trip. Its arrays
are bounded; the counters beside them are **totals** and are never reduced by
trimming.

| Retained | Bound | True total alongside it |
| --- | --- | --- |
| Observations | 1,000 | `eventsObserved` |
| Keystroke deltas | 2,000 | `keystrokeObservations` |
| Pasted content | 50 | `pasteObservations` |
| Event fingerprints | 128 | — |

These are constants, not configuration: they bound memory, and an operator has no
reason to tune them.

What this does **not** affect:

* **Review.** The reviewer timeline reads stored telemetry through the MCP tool
  surface, never the projection, so trimming changes nothing a reviewer sees.
* **Counters.** `pasteCount`, `tabSwitchCount`, `windowBlurCount`,
  `fullscreenExitCount`, `copyAttemptCount` and `devToolsOpenCount` are totals and
  keep counting past the window.
* **Pasted content available to analysis.** It lives in its own bounded window, so
  trimming the event window cannot silently change what an analysis is shown.

`GET /api/v1/integrity/sessions/:sessionId` (operator-only) reports the true totals
(`eventCount`, `keystrokeObservations`, `pasteObservations`) alongside the window
sizes (`retainedEvents`, `retainedKeystrokes`, `retainedPastes`), so an operator
can see both.

**Recovery takes its counters from exact stored counts.** When a session is rebuilt
from the store, its retained windows and code snapshot come from replaying the
fetched events, but its **counters come from a per-type aggregation** over all
stored telemetry. Replaying a page could only ever reconstruct that page's
counters, and those counters feed `shouldAnalyze` — so without this a long session
could fail to trip a threshold it had crossed.

Two fields make the state of a recovered projection explicit:

| Field | Meaning |
| --- | --- |
| `recoveredPartially` | The retained **window** was rebuilt from a partial page |
| `countersExact` | The counters that feed thresholds are true totals |

`countersExact` is `false` only when the store did not supply counts — a
page-derived projection, which logs `counters are rebuilt from the recovered
subset and may undercount`. A fresh (non-recovered) projection is always exact,
because it accumulates real totals as it goes.

### Session review paging

`GET /api/v1/sessions/:sessionId/review` returns **one page** of telemetry, not
necessarily the whole record, and always says which it is.

| Query parameter | Default | Range |
| --- | --- | --- |
| `eventLimit` | `500` | 1–5000 |
| `eventOffset` | `0` | ≥ 0 |

Every response carries the disclosure, whatever the page size:

| Field | Meaning |
| --- | --- |
| `timelineTotal` | True stored event count for the session |
| `timelineReturned` | Events in `timeline` |
| `timelineTruncated` | True when `timeline` is a page, not the whole record |
| `nextEventOffset` | Pass as `eventOffset` for the next older page, or `null` when complete |

Pages are newest-first at the store and re-ordered **ascending** in `timeline`, so
a client loading older pages should prepend them. Walk `nextEventOffset` until it
is `null` to read the whole record.

A malformed `eventLimit` or `eventOffset` is a `400`, never a silent substitution
— quietly choosing a different page size would make the disclosure above a lie.

`GET /api/v1/sessions` reports the **true** `eventCount` per session. Its
`pasteCount` and `tabSwitchCount` are derived from one page per session, because
counting each type separately would add a query per type to a list that already
fans out one call per session. When a session is longer than that page the summary
sets `countsSampled: true`, so sampled counts are never presented as totals.

The reviewer console shows a "Partial timeline" notice with the true total and a
**Load older events** control whenever `timelineTruncated` is true.

### Candidate registration

Registration is the only unauthenticated write in the API, so it is the one
place where an unauthenticated caller could otherwise claim an identity. It
requires an **operator-issued registration capability**.

```sh
# 1. The operator mints a capability for one candidate.
curl -sS -X POST http://127.0.0.1:8080/api/v1/identity/capability \
  -H "Authorization: Bearer $ASSESSMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"candidateId":"candidate-42","assessmentId":"assessment-7"}'

# 2. The candidate presents it to register. No operator credential needed here.
curl -sS -X POST http://127.0.0.1:8080/api/v1/identity/set \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Ada Lovelace","candidateId":"candidate-42",
       "assessmentId":"assessment-7","registrationCapability":"rv1...."}'
```

| Property | Value |
| --- | --- |
| Who may mint | The operator credential only (`POST /api/v1/identity/capability`) |
| Bound to | One `candidateId`, and optionally one `assessmentId` |
| Lifetime | `REGISTRATION_CAPABILITY_TTL_SECONDS`, default 15 minutes |
| Stored | **Nothing.** It is HMAC-signed, not persisted |
| One-time use | **No.** See below |
| Replay after expiry | Refused |
| Replay after consumption | Not applicable — there is no consumption step |
| Replay after secret rotation | Refused |
| Survives a restart | Yes, while the session secret is unchanged |
| Logged | Never |

**What it proves.** That the operator authorised this candidate id, and that the
presenter holds the operator's grant. Nothing more. It is **not** verified human
identity, KYC, biometrics, or proof that the presenter is the person the id
names. The product makes no such claim anywhere.

**What it prevents.** A caller who knows a candidate id from obtaining a token
for that candidate — including an existing candidate whose submitted code and
integrity reports are already stored. Before this existed, `candidateId` alone
was sufficient, which meant a known candidate id granted read access to that
candidate's record.

**What it does not solve.**

* It is **not one-time use**. A capability can be replayed by whoever holds it
  until it expires. Statelessness and single-use are mutually exclusive without a
  consumed-capability store, and making registration depend on the datastore
  would be a reliability regression. A short TTL is what bounds the window; if
  you need a tighter guarantee, mint per-candidate capabilities with a short
  lifetime and rotate `ASSESSMENT_SESSION_SECRET` to revoke them all.
* It does not stop a candidate from sharing their capability with someone else.
* It does not rate-limit how many candidates one operator registers.
* It does not replace identity verification at the edge, which a deployment that
  must know *who* a candidate is still has to do itself.

**`CANDIDATE_REGISTRATION_MODE=open`** restores the old behaviour — any caller,
any `candidateId`, no capability. It exists only for local development and
demoware. The API **refuses to start in production** with it, an unrecognised
value falls back to `capability`, and enabling it in development logs a warning
stating exactly what it reopens.

### CORS

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | localhost dev origins | **yes** | Comma-separated origin allow-list. A `*` entry is discarded |

```sh
CORS_ALLOWED_ORIGINS=http://localhost:8080,https://review.example.org
```

### AI provider

| Variable | Default | Required in production | Purpose |
| --- | --- | --- | --- |
| `AI_PROVIDER_MODE` | `gemini-api` | — | `gemini-api` or `vertex` |
| `GEMINI_API_KEY` | *(empty)* | **yes** for `gemini-api` | Developer API key |
| `GEMINI_VERTEX_PROJECT` | *(empty)* | **yes** for `vertex` | Google Cloud project |
| `GEMINI_VERTEX_LOCATION` | `us-central1` | — | Vertex region |
| `AI_MODEL` | `gemini-2.5-flash` | — | Model identifier |
| `AI_MAX_OUTPUT_TOKENS` | `65536` | — | Output cap |
| `AI_TEMPERATURE` | `0.2` | — | Sampling temperature |
| `AI_REQUEST_TIMEOUT_MS` | `90000` | — | Per-attempt timeout |

`AI_MODEL` must name a model the configured transport actually serves. The
historical default, `gemini-3-flash-preview`, never resolved on the public API,
so every call silently fell back to a different model. Do not reintroduce it.

### Integrity thresholds

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TTL_SECONDS` | `7200` | Live-projection staleness horizon; `0` disables eviction |
| `MAX_PASTE_EVENTS` | `5` | Paste events in a session before analysis is triggered |
| `MIN_HUMAN_KEYSTROKE_MS` | `80` | Keystrokes faster than this count as implausible |
| `PLAGIARISM_THRESHOLD` | `0.75` | Similarity above which the report raises a concern |
| `ALERT_SCORE_THRESHOLD` | `50` | Integrity score above which an alert is raised |

Raising `MAX_PASTE_EVENTS` or `ALERT_SCORE_THRESHOLD` makes the system quieter;
lowering them makes it noisier. Neither changes whether a signal is *true*.

#### What `SESSION_TTL_SECONDS` does and does not do

The API keeps a live, in-process projection of each active session so that
integrity thresholds can be evaluated on the ingestion hot path without a
database round trip. `SESSION_TTL_SECONDS` is the staleness horizon for that
projection: once a session has received no telemetry for longer than the
horizon, the projection is dropped and the next batch rebuilds it from the
stored record.

It is deliberately **not** a data-retention or deletion policy:

| | Effect of exceeding `SESSION_TTL_SECONDS` |
| --- | --- |
| In-memory session projection | **Dropped.** Rebuilt from the store on the next batch |
| `assessment_sessions` record | Unchanged |
| Stored telemetry and integrity reports | Unchanged |
| Candidate token validity | Unchanged — that is `CANDIDATE_SESSION_TTL_SECONDS` |

Nothing in the product expires stored candidate data on a timer. Deleting a
session's durable record is an explicit operator action
(`DELETE /api/v1/integrity/sessions/:sessionId`), and retention beyond that is
the operator's responsibility — see
[docs/security/threat-model.md](security/threat-model.md#telemetry-sensitivity).

Setting the horizon to `0` disables eviction, so every session this process has
observed stays in memory until it is terminated or the process restarts.

### Console operator token

The console takes compile-time definitions rather than environment variables,
because it is a compiled client bundle:

| Define | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:8080` | API base URL |
| `API_TOKEN` | *(empty)* | Operator credential |

```sh
flutter run -d chrome \
  --dart-define=API_BASE_URL=http://localhost:8080 \
  --dart-define=API_TOKEN="$ASSESSMENT_API_TOKEN"
```

> **A `--dart-define` value is compiled into the bundle.** It is not a runtime
> secret: `flutter build web` inlines the token into the emitted JavaScript, so
> anyone who can load the page can read it out of the served assets. There is no
> way to make it confidential in a static build, because the browser must present
> it to the API.

This constrains where the console may be deployed:

| Deployment | Operator token in the bundle? | Acceptable |
| --- | --- | --- |
| Local / trusted operator machine | Yes, a development or short-lived token | Yes |
| Hosted behind a reverse proxy or backend-for-frontend that injects `Authorization` server-side | No — build the console without `API_TOKEN` and let the proxy add it | Yes |
| Publicly served static build with a real production operator token | Yes | **No.** Anyone who loads the page obtains full operator access: every candidate's telemetry, submissions and integrity reports, plus billable generation |

The third row is the one to avoid. If the console must be reachable by reviewers
over a network, terminate authentication at the proxy and keep
`ASSESSMENT_API_TOKEN` on the server side. A production operator token must never
be embedded in a publicly served static bundle. This is tracked as a known
limitation in the [README](../README.md#known-limitations) and analysed in
[docs/security/threat-model.md](security/threat-model.md) (T1, accepted risk 3).

## Startup behaviour

```
loadConfig()
  ├─ read ENVIRONMENT
  ├─ production?  → collect every missing required value and throw once
  │                 (the listener never binds)
  └─ development? → generate ephemeral operator token + session secret,
                    log that it did so and why
```

The generated development operator token is printed exactly once, at startup:

```
[security] Development mode: ASSESSMENT_API_TOKEN was not set, so a random token
was generated for this process only. ...
[security] Development operator token: <value>
```

Capture it from the container log if you need to call the reviewer endpoints:

```sh
docker compose logs api | grep "Development operator token"
```

## Verification scripts

Two scripts exercise a running instance without calling a paid model:

```sh
# The security boundary: every sensitive route refuses an anonymous caller.
ASSESSMENT_API_TOKEN="<operator token>" node scripts/smoke.mjs

# The candidate session lifecycle, end to end.
ASSESSMENT_API_TOKEN="<operator token>" node scripts/verify-lifecycle.mjs
```

Both accept `ASSESSMENT_BASE_URL` (default `http://127.0.0.1:8080`) and exit
non-zero on a failure. `npm run smoke` and `npm run verify` are the same
commands.

## Common failure modes

| Symptom | Cause |
| --- | --- |
| API exits immediately with `Refusing to start in production` | A required value is missing; the message names every one |
| `503` from `POST /api/v1/generate` | No AI credential configured. Ingestion and review still work |
| `401` from the reviewer endpoints | No bearer token, or the operator token is wrong |
| `403` from the reviewer endpoints | A candidate token was used where the operator credential is required |
| `502` from ingestion | The MCP tool surface or MongoDB is unreachable; telemetry is *not* silently dropped |
| Console shows "The console credential was rejected" | Built without `--dart-define=API_TOKEN` |
