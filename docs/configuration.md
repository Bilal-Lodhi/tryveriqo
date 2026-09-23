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
| `ASSESSMENT_SESSION_SECRET` | *(empty)* | **yes** | Signing secret for candidate tokens. Minimum 32 characters |
| `CANDIDATE_SESSION_TTL_SECONDS` | `7200` | — | Candidate token lifetime |

Generate a secret:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Rotating `ASSESSMENT_SESSION_SECRET` invalidates every outstanding candidate
token. That is the intended lever for ending all candidate sessions at once.

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
| `SESSION_TTL_SECONDS` | `7200` | Session staleness horizon |
| `MAX_PASTE_EVENTS` | `5` | Paste events in a session before analysis is triggered |
| `MIN_HUMAN_KEYSTROKE_MS` | `80` | Keystrokes faster than this count as implausible |
| `PLAGIARISM_THRESHOLD` | `0.75` | Similarity above which the report raises a concern |
| `ALERT_SCORE_THRESHOLD` | `50` | Integrity score above which an alert is raised |

Raising `MAX_PASTE_EVENTS` or `ALERT_SCORE_THRESHOLD` makes the system quieter;
lowering them makes it noisier. Neither changes whether a signal is *true*.

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
