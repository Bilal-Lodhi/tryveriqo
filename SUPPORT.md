# Support

## Where to ask

| I want to… | Go to |
| --- | --- |
| Report a bug | Open an issue using the **Bug report** template |
| Request a capability | Open an issue using the **Feature request** template |
| Report a security problem | **Do not** open an issue — read [SECURITY.md](SECURITY.md) |
| Ask how something works | Open an issue using the **Question** template |
| Contribute a change | Read [CONTRIBUTING.md](CONTRIBUTING.md) |

## Before you open an issue

This project is at **v0.1.0, published as a pre-release**. It is not production
ready, no version has been designated stable, and there is no hosted instance.
When reporting, please say whether you are on the `v0.1.0` tag or on the default
branch. Maintainer time is limited, so please:

1. Read the [README](README.md) and [docs/configuration.md](docs/configuration.md).
2. Reproduce against a current build of the default branch.
3. Include the API version reported by `GET /health`.
4. Include the exact request and the exact response.
5. **Redact candidate ids, tokens, connection strings and telemetry content.**

## Things that are working as designed, not bugs

* `POST /api/v1/generate` returns **503** when no AI credential is configured.
  This is deliberate; generation is the only capability that needs a model.
* The console returns **403** on the session list when launched without an
  operator token. Reviewer surfaces require the operator credential.
* Telemetry that is submitted twice is only counted once. Duplicate suppression
  is intentional.
* Timestamps are returned in UTC. Convert for display; do not ask for local time
  in storage.
* An integrity score above the alert threshold does **not** mean a candidate
  cheated. It means a reviewer should look.

## Scope of support

The project is offered as-is under the Apache License 2.0, without warranty. There
is no commercial support offering, no service-level agreement, and no hosted
instance.
