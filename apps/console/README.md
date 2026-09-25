# tryveriqo console

The reviewer console for tryveriqo. It is a Flutter application (web or desktop)
that talks to the tryveriqo API.

## What it does

* **Review** — lists candidate sessions, shows the submitted code beside the
  candidate's telemetry timeline, integrity flags, similarity report and
  behavioural anomalies.
* **Generate** — turns one description into a structured assessment suite.

## Configuration

Both values are compile-time definitions:

| Define | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:8080` | tryveriqo API base URL |
| `API_TOKEN` | *(empty)* | Operator credential for generation and cohort review |

```sh
flutter run -d chrome \
  --dart-define=API_BASE_URL=http://localhost:8080 \
  --dart-define=API_TOKEN="$ASSESSMENT_API_TOKEN"
```

Without `API_TOKEN` the console can still register a candidate and read that
candidate's own review, but session listing and assessment generation return
401/403.

> **The operator token is compiled into the bundle.** It is not a runtime secret:
> a release web build inlines it into `main.dart.js`, so anyone who can load the
> page can read it. This is safe only for a local/trusted operator console.
>
> The console **enforces** that: an embedded token is withheld unless
> `API_BASE_URL` is loopback (`localhost`, `127.x.x.x`, `::1`), or
> `ALLOW_REMOTE_EMBEDDED_TOKEN=true` is set deliberately. Against a remote origin
> it sends no `Authorization` header and explains why, rather than handing full
> operator access to every visitor. That guard prevents an accident; it cannot
> make an embedded token confidential.
>
> For a hosted console, build **without** `API_TOKEN` and use the reference proxy
> in [`deploy/console-proxy/`](../../deploy/console-proxy/README.md), which
> injects the credential server-side. See
> [`docs/configuration.md`](../../docs/configuration.md#console-operator-token)
> and [`docs/security/threat-model.md`](../../docs/security/threat-model.md).

## Development

```sh
flutter pub get
flutter analyze
flutter test
```
