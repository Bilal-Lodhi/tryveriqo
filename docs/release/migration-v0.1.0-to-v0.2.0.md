# Migration — v0.1.0 to v0.2.0

**One change requires operator action.** Everything else is additive or internal.

This is a **minor** version, not a major one: the repository has no stated policy
that would make it major, the change is bounded, and there is a documented
development-mode fallback. It is nonetheless a change a self-hoster must act on,
which is why it is not a patch release.

## The one required change: candidate registration

### What changed

In v0.1.0, `POST /api/v1/identity/set` accepted any `candidateId` from any caller
and returned a token for it. In v0.2.0 it **refuses to mint a token without an
operator-issued registration capability** bound to that exact candidate id.

### Why

The v0.1.0 behaviour was not merely "a caller can claim an unused id". Nothing
checked whether an id was already in use, so a caller who knew an **existing**
candidate's id could obtain a token for it and read that candidate's own submitted
code and integrity report history. That is an authorization boundary defect. See
[`errata-v0.1.0.md`](errata-v0.1.0.md) entry 2.

### What to do

**If candidates already receive their id from you** (the normal case — you issue
assessments), mint a capability per candidate and give it to them with the id:

```sh
# Once per candidate, with the operator credential.
curl -sS -X POST https://your-api/api/v1/identity/capability \
  -H "Authorization: Bearer $ASSESSMENT_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"candidateId":"candidate-42","assessmentId":"assessment-7"}'
```

The response contains `capability`, `capabilityId`, `candidateId`,
`assessmentId` and `expiresAt`. The capability is a **credential**: deliver it the
same way you would deliver a password — not by email in plain text if you can avoid
it, and never in a public channel.

The candidate then registers with it:

```sh
curl -sS -X POST https://your-api/api/v1/identity/set \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Ada Lovelace","candidateId":"candidate-42",
       "assessmentId":"assessment-7","registrationCapability":"rv1...."}'
```

`assessmentId` is required in the registration request when the capability was
minted with one, and must match.

**If you bind a capability to an assessment**, the same capability cannot be used
to register for a different assessment. Binding is optional; a capability minted
without `assessmentId` is bound to the candidate id only.

### Tuning the lifetime

| Variable | Default | Range |
| --- | --- | --- |
| `REGISTRATION_CAPABILITY_TTL_SECONDS` | `900` (15 min) | 30–86400 |

**Capabilities are not one-time use.** A capability can be replayed by whoever
holds it until it expires. This is a deliberate trade-off: statelessness means
registration never depends on the datastore, and a restart cannot invalidate an
outstanding capability. If you need a tighter guarantee:

* keep the lifetime short — 15 minutes is enough for a candidate to register;
* mint immediately before the candidate needs it, not days ahead;
* rotate `ASSESSMENT_SESSION_SECRET` to revoke **every** outstanding capability at
  once.

### If you cannot mint capabilities yet

For **local development only**, set:

```sh
CANDIDATE_REGISTRATION_MODE=open
```

This restores the v0.1.0 behaviour. It is **refused at startup in production**, an
unrecognised value falls back to `capability`, and enabling it in development logs
a warning stating exactly what it reopens. Do not treat it as a production
workaround — it reopens the defect this release closes.

### If you wrote your own candidate client

`POST /api/v1/identity/set` now returns **`403`** where it previously returned
`201`, when no valid capability is presented. The response body is
`{"success":false,"error":"A valid registration capability is required to register this candidate. Ask the assessment operator for one."}`.

Every capability failure returns that same response, deliberately, so the endpoint
does not reveal which check failed or whether a candidate id exists.

## Changes that need no action

* **No database migration.** No collection was renamed, no index removed, no stored
  document rewritten. Existing suites, sessions, telemetry and reports are read
  unchanged.
* **No new required production secret.** The capability signing key is derived from
  `ASSESSMENT_SESSION_SECRET`, which you already set.
* **The operator credential is unchanged.** Same `ASSESSMENT_API_TOKEN`, same
  routes, same semantics.
* **Candidate tokens are unchanged.** Same format, same lifetime variable, same
  scoping. Existing tokens remain valid until they expire.
* **New variables are optional.** `TRUST_PROXY_HEADERS` defaults to `false`, which
  is the safe value; `REGISTRATION_CAPABILITY_TTL_SECONDS` defaults to 15 minutes.

## Changes that alter behaviour without requiring action

Review these if you depend on the affected surfaces:

| Change | Effect |
| --- | --- |
| Request-body ceilings | A request above the ceiling now returns `413`. Identity 16 KiB, generation 64 KiB, ingestion 8 MiB |
| Batch free-text budget | Free text across one telemetry batch is capped at 500,000 characters; exceeding it is a `400` |
| Ingestion rate limiting | 240 requests/minute, keyed per authenticated candidate |
| Rate-limit keys | `X-Forwarded-For` / `X-Real-Ip` are ignored unless `TRUST_PROXY_HEADERS=true`. **Behind a proxy, per-client bucketing requires setting it** |
| `eventCount` in the session list | Now the true stored total, not the page length; `countsSampled` says when per-type counts came from a page |
| Review response | Adds `timelineTotal`, `timelineReturned`, `timelineTruncated`, `nextEventOffset` |
| `finalScore` | May now be `null` where it was previously derived from a malformed score; may be computed from a different (correct) report |
| `plagiarismReport.source` | New field recording what the similarity comparison used |
| `SESSION_TTL_SECONDS` | Now actually enforced against the in-memory projection |
| Console with a remote API | An embedded `API_TOKEN` is withheld unless `ALLOW_REMOTE_EMBEDDED_TOKEN=true` |

## Verifying the upgrade

```sh
# 1. The API must still refuse to start in production with incomplete config.
docker compose up --build
docker compose logs api | grep -i "Refusing to start"   # only if you removed a required value

# 2. Registration must refuse an unproven candidate.
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/v1/identity/set \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Ada","candidateId":"candidate-1"}'   # expect 403

# 3. The full lifecycle, including a capability mint and a refusal.
ASSESSMENT_API_TOKEN="<operator token>" node scripts/verify-lifecycle.mjs
ASSESSMENT_API_TOKEN="<operator token>" node scripts/smoke.mjs
```

Both scripts mint a capability as the operator, register with it, and assert that
registration without one is refused.

## Rollback

Reverting to v0.1.0 restores open registration and the other v0.1.0 behaviour. No
data written by v0.2.0 needs undoing: the schema is unchanged, and capability
records do not exist because capabilities are never stored.
