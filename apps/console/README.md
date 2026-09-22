# Assessment console

The reviewer console for the Assessment integrity platform. It is a Flutter
application (web or desktop) that talks to the Assessment API.

## What it does

* **Review** — lists candidate sessions, shows the submitted code beside the
  candidate's telemetry timeline, integrity flags, similarity report and
  behavioural anomalies.
* **Generate** — turns one description into a structured assessment suite.

## Configuration

Both values are compile-time definitions:

| Define | Default | Purpose |
| --- | --- | --- |
| `API_BASE_URL` | `http://localhost:8080` | Assessment API base URL |
| `API_TOKEN` | *(empty)* | Operator credential for generation and cohort review |

```sh
flutter run -d chrome \
  --dart-define=API_BASE_URL=http://localhost:8080 \
  --dart-define=API_TOKEN="$ASSESSMENT_API_TOKEN"
```

Without `API_TOKEN` the console can still register a candidate and read that
candidate's own review, but session listing and assessment generation return
401/403.

> A value passed with `--dart-define` is compiled into the bundle and is
> readable by anyone who has the bundle. Never use a real production operator
> token here for a publicly hosted console. See `docs/security/threat-model.md`.

## Development

```sh
flutter pub get
flutter analyze
flutter test
```
