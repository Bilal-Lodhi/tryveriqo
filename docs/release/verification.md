# Verification record

This document records what has actually been executed and observed, and what has
not. It is deliberately explicit about the difference.

## Environment

| Item | Value |
| --- | --- |
| Node.js | `v24.19.0` |
| npm | `11.17.0` |
| Docker | `28.0.4` |
| Flutter | stable channel, present on the build host |
| Platform | Windows |

## Backend

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm ci` | pass |
| Build | `npm run build` | pass (both workspaces) |
| Tests | `npm run test:backend` | pass |

The exact test counts are recorded in the final extraction report rather than
duplicated here, because they change with every commit during preparation.

## Console

| Check | Command | Result |
| --- | --- | --- |
| Resolve | `flutter pub get` | pass |
| Analyze | `flutter analyze` | no issues |
| Tests | `flutter test` | pass |

## Container

| Check | How | Result |
| --- | --- | --- |
| Image builds | `docker build -t assessment:local .` | recorded in the final report |
| Production fails closed | run with `ENVIRONMENT=production` and no secrets | non-zero exit; the message names every missing value |
| Stack starts | `docker compose up --build` | recorded in the final report |
| Health through the stack | `GET /health` | recorded in the final report |
| Indexes created | MCP startup log | created by `ensureIndexes()` on connect |

## AI provider

| Check | Result |
| --- | --- |
| **Live generation call** | **NOT VERIFIED** |
| Parser correctness against recorded fixtures | verified by automated tests |
| Request construction, retry policy, JSON recovery | verified by automated tests with the SDK module substituted |
| Provider-outage behaviour | verified: an outage does not reject telemetry already durably accepted |

### Why the live call is unverified

No `GEMINI_API_KEY`, Vertex AI project, `GOOGLE_API_KEY` or `OPENAI_API_KEY` was
present in the extraction environment. Request and response handling is covered
by fixtures, but **a fixture is not a live call**: it cannot prove that the
configured model identifier is currently served, that the account has quota, or
that the live response shape matches the fixtures.

Consequently the extraction is complete and release readiness is **not** claimed.
See `docs/release/v0.1.0.md`.

## How to close the gap

```sh
# 1. Configure a credential (never commit it)
export GEMINI_API_KEY="<key>"

# 2. Start the stack
npm ci && npm run build
docker compose up -d mongo
npm run dev

# 3. Capture the development operator token from the API output, then make the
#    smallest possible generation request.
curl -sS -X POST http://localhost:8080/api/v1/generate \
  -H "Authorization: Bearer <operator token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A short junior JavaScript assessment","roleContext":"frontend-junior","problemCount":1}' \
  | tee /tmp/generate.json

# 4. Record: HTTP status, provider, model, wall-clock latency, problems parsed,
#    suite id, and whether persistence succeeded.
```

Then replace the "NOT VERIFIED" row above with the observed values.
