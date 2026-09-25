# Reference console deployment: serve the console, inject the credential

The console compiles its operator token into the web bundle when it is built with
`--dart-define=API_TOKEN`. A `--dart-define` value is **not** a runtime secret:
anyone who can load the page can read it out of `main.dart.js`, and that token
grants full operator access — every candidate's telemetry, submissions and
integrity reports, plus billable generation.

The console now enforces that rather than only documenting it: an embedded token
is withheld unless the API base URL is loopback, or
`--dart-define=ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set deliberately.

For a console that is reachable by reviewers over a network, build it **without**
a token and put a proxy in front that adds `Authorization` server-side. This
directory is a working reference for that.

## How it works

```
reviewer's browser ──▶ proxy ──▶ API
                       │          ▲
   no credential in    │          │
   the page            └──────────┘
                       adds Authorization: Bearer $ASSESSMENT_API_TOKEN
```

The token lives in the proxy's environment. It is never sent to the browser, so
it never appears in the bundle, in a network response, or in the page source.

## Build the console without a token

```sh
cd apps/console
flutter build web --release \
  --dart-define=API_BASE_URL=https://review.example.org
  # deliberately NO --dart-define=API_TOKEN
```

`API_BASE_URL` is the origin the browser will talk to — the **proxy**, not the API
directly. The console then calls `https://review.example.org/api/...`, the proxy
adds the credential, and the API sees an ordinary authenticated request.

## Run the proxy

`Dockerfile` builds the static console plus the proxy. The credential goes in the
**environment**, never in the image:

```sh
# Build the console first, from apps/console, WITHOUT --dart-define=API_TOKEN.
docker build -f deploy/console-proxy/Dockerfile -t tryveriqo-console .

docker run --rm -p 8080:8080 \
  -e API_UPSTREAM=http://api:8080 \
  -e ASSESSMENT_API_TOKEN="$ASSESSMENT_API_TOKEN" \
  tryveriqo-console
```

`default.conf.template` is rendered by the official nginx image at container
start, so both the upstream and the credential are server-side configuration. The
entrypoint **refuses to start** if either is missing, rather than injecting an
empty `Bearer ` and turning every request into an opaque 401.

`API_UPSTREAM` is a full origin **without a trailing slash** — `http://api:8080`,
not `http://api:8080/`. A trailing slash makes nginx replace the matched path
prefix instead of forwarding it, so `/api/v1/sessions` would arrive as
`/v1/sessions`.

Two things in the template matter: serving the static build, and overwriting
`Authorization` on the proxied paths. It **overwrites** rather than appends, so a
caller cannot substitute their own credential.

Validated with `nginx -t` after rendering; see the PR that added this directory
for the exact command.

## What this does and does not give you

**Does:** removes the operator credential from anything a browser can read, so a
publicly reachable console no longer hands out operator access to every visitor.

**Does not:** authenticate the reviewer. The proxy injects one shared operator
credential for everyone who can reach it, so **anyone who can load the page still
has full operator access** — they simply no longer hold the token. Put
authentication in front of the proxy (your SSO, a VPN, an allow-list, basic auth
over TLS) if the console is reachable beyond people you trust. Per-reviewer
credentials and an access log remain out of scope; see
[`docs/security/threat-model.md`](../../docs/security/threat-model.md)
(accepted risk 2).

That distinction is the whole point of this directory: it fixes *where the
credential lives*, not *who may use it*.
