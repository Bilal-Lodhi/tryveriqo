# v0.2.0 release checklist

**Status: prepared, NOT PUBLISHED.** No `v0.2.0` tag exists and no GitHub Release
has been created. This document separates what is genuinely required before
publication from what is deliberately deferred, the way the
[v0.1.0 checklist](checklist.md) did.

Draft release notes: [`release-notes-v0.2.0.md`](release-notes-v0.2.0.md).
Migration: [`migration-v0.1.0-to-v0.2.0.md`](migration-v0.1.0-to-v0.2.0.md).
Corrections to v0.1.0's published claims: [`errata-v0.1.0.md`](errata-v0.1.0.md).

## A. Hard blockers before publication

These must be true before a `v0.2.0` tag is pushed.

| # | Item | State |
| --- | --- | --- |
| A1 | Every workstream merged to `main` through protected branch flow | ☑ |
| A2 | `main` CI green on the proposed tag target | ☑ |
| A3 | Version `0.2.0` consistent across every manifest and reported by `GET /health` | ☑ || A4 | Full test suite green — API, MCP, console | ☑ |
| A5 | Container image builds and fails closed without secrets | ☑ |
| A6 | Fail-closed checks extended to open candidate registration | ☑ |
| A7 | `smoke.mjs` and `verify-lifecycle.mjs` pass against a live self-hosted stack | ☑ |
| A8 | Credential guard and its self-test pass; retired-identifier guard passes | ☑ |
| A9 | No project id, credential or token in any tracked file | ☑ |
| A10 | Changelog, release notes and migration notes complete and accurate | ☑ |
| A11 | Every release-note claim supported by a test, a recorded live observation, or an explicit statement that it is unverified | ☑ |
| A12 | Known limitations stated, including those that changed since v0.1.0 | ☑ |
| A13 | `v0.1.0` tag and published release body untouched | ☑ |
| A14 | **Convert relative links in the release notes to absolute GitHub URLs before publishing** | ☐ |
| A15 | Tag created and release published, as its own explicitly authorised step | ☐ |

**A14 is the one open preparation item.** `docs/release/release-notes-v0.1.0.md`
uses absolute GitHub URLs because relative links resolve differently on a release
page. The v0.2.0 draft currently uses relative links, which is correct for a
document read in the repository and wrong for a release body. Convert them in the
same change that publishes, so the repository copy and the published body stay
identical — the invariant v0.1.0 established.

**A15 requires explicit human authorisation.** Publishing is reserved.

### Two coupling traps this preparation hit

Recorded because both are easy to miss and one of them fails a required CI check.

1. **`apps/api` pins the workspace dependency exactly.** `apps/api/package.json`
   declares `"@assessment/mcp-mongodb": "<version>"` — an exact pin, not a range.
   Bumping the workspace version without bumping that pin makes `npm install`
   fail with a `404` for the old version, and `npm ci` would fail in CI. Both
   must move together.
2. **Do not regenerate `package-lock.json` to sync it.** Running
   `npm install --package-lock-only` also re-resolved and **pruned a transitive
   dependency** (`gcp-metadata@5.3.0`), which is a dependency-graph change
   disguised as a version bump. The lock was instead edited to change exactly the
   five version fields, leaving the graph byte-identical, and `npm ci` verified.

## B. Deliberately deferred, not blocking

Valuable, and explicitly not blockers.

| # | Item | Why deferred |
| --- | --- | --- |
| B1 | A successful live Vertex generation | Needs GCP billing enabled. A spend decision, not taken. Issue #1 stays open |
| B2 | Code scanning (CodeQL or equivalent) enabled on the repository | Repository configuration, not a code change. "No dependency alerts" therefore means *no known current alert* |
| B3 | Per-reviewer credentials and an access log | Would need an accounts/RBAC design; out of scope |
| B4 | A hosted reverse-proxy console deployment actually deployed | The reference configuration ships and is `nginx -t` validated, but nothing is deployed |
| B5 | Load, stress and adversarial DoS testing | In-process rate limits are a backstop, not a load-tested defence |
| B6 | Pagination UI for very long telemetry timelines | The continuation mechanism and the truncation notice ship; a full pager does not |
| B7 | `npm audit`-driven dependency upgrades beyond security-relevant ones | Avoid churn |
| B8 | `config.database.uri` is parsed and never read by the API | Filed as issue #31 during the release-gate config census. Not release-blocking: it changes no behaviour, and the MCP process's use of `MONGODB_URI` is correct |

## C. Accepted limitations carried into v0.2.0

Documented so they are decisions, not omissions. See the release notes for the
full list.

| # | Item | Rationale |
| --- | --- | --- |
| C1 | A registration capability is not one-time use | Statelessness and single-use are mutually exclusive without a consumed-capability store, and making registration depend on the datastore would be a reliability regression. A short TTL bounds the window |
| C2 | A registration capability is not identity verification | It proves operator authorisation and possession, not who the presenter is |
| C3 | Single shared operator credential, no per-reviewer identity or audit log | Would require an accounts/RBAC design |
| C4 | The console token guard is not a secret store | It bounds an accidental deployment; an embedded token still cannot be made confidential |
| C5 | Similarity compares against the assessment's own solution only | Cross-candidate comparison was rejected because the model can echo a matched snippet into a report the candidate can read |
| C6 | `POST /api/v1/generate` has no prompt-length bound beyond its 64 KiB body ceiling | A tighter per-field bound is the better fix and is not done |
| C7 | Rate-limit bucket eviction is not fair | Memory is bounded absolutely; a client rotating keys can still displace other callers' buckets |

## D. Publication procedure (for when it is authorised)

Do not run these without an explicit decision. Recorded so the step is mechanical.

```sh
# 1. Confirm the target and that CI is green on it.
git fetch origin --prune --tags
git rev-parse origin/main
gh run list --repo Bilal-Lodhi/tryveriqo --branch main --limit 1

# 2. Confirm v0.1.0 is still immovable before touching anything.
git ls-remote --tags origin | grep v0.1.0
# expect c6eaf96f6323306ce824ad4df9a91bd97c3ef56c  refs/tags/v0.1.0
#        62b0f5af1d1c1442a9150c0632d7c746b0c6046b  refs/tags/v0.1.0^{}

# 3. Convert the release-note links to absolute URLs and merge that change (A14).

# 4. Tag the resulting merge commit on main.
git tag -a v0.2.0 -m "tryveriqo v0.2.0" <merge-commit-sha>
git push origin v0.2.0

# 5. Publish as a pre-release, with the body from
#    docs/release/release-notes-v0.2.0.md.
gh release create v0.2.0 \
  --repo Bilal-Lodhi/tryveriqo \
  --title "tryveriqo v0.2.0" \
  --prerelease \
  --notes-file docs/release/release-notes-v0.2.0.md
```

**Do not** mark it `--latest` or stable: no version has been designated stable, and
nothing here is production ready.

## E. Verification matrix

Every claim in the release notes and where it is proven.

| Claim | Proven by |
| --- | --- |
| Registration requires a capability | `apps/api/test/registration.test.ts` — 16 acceptance cases |
| Capability envelope, bindings, expiry, tampering | `apps/api/test/registration-capability.test.ts` — 29 cases |
| Production refuses `CANDIDATE_REGISTRATION_MODE=open` | `apps/api/test/startup.test.ts` + a CI container step |
| Cross-candidate write isolation | `apps/api/test/auth.test.ts` — four tests that fail against the pre-fix code |
| Request-body ceilings and batch budget | `apps/api/test/body-limit.test.ts` — 21 cases incl. exact boundaries |
| Rate-limit key trust and bucket bound | `apps/api/test/rate-limit.test.ts` — 18 cases |
| MCP dispatch refuses prototype members | `packages/mcp-mongodb/test/dispatch.test.ts` + HTTP-level tests |
| Session TTL enforcement and settled-state recovery | `apps/api/test/integrity-session.test.ts`, `telemetry.test.ts` |
| Newest-report selection | `apps/api/test/sessions.test.ts` — 8 cases |
| Review truncation disclosure and paging | `apps/api/test/review-paging.test.ts`, `session-review-paging.test.ts` |
| Recovered counters exact | `apps/api/test/session-bounds.test.ts`, `recovery-counts.test.ts` |
| Bounded in-memory windows | `apps/api/test/session-bounds.test.ts` — 31 cases |
| Console generation outcome | `apps/console/test/widget_test.dart` |
| Console token guard | `apps/console/test/operator_token_guard_test.dart` |
| Similarity source and threshold | `apps/api/test/similarity-source.test.ts` — 20 cases |
| Credential guard reproducibility | `credential-guard.mjs --self-test`, run in CI |
| End-to-end lifecycle | `scripts/smoke.mjs`, `scripts/verify-lifecycle.mjs` against a live stack |
| Vertex ADC + region + terminal error | One recorded live call — `verification.md` |
| Vertex **successful** generation | **Not proven.** Stated as unverified |

## F. Release-gate results

Run against the merged candidate. Recorded so the claims are evidence-backed rather
than asserted.

| Check | Result |
| --- | --- |
| `npm ci` against the edited lock | pass |
| TypeScript typecheck and build | pass |
| API tests | 366 pass, 0 fail |
| MCP tests | 78 pass, 0 fail |
| Console tests | 38 pass, 0 fail |
| `flutter analyze` / `dart format --set-exit-if-changed` | clean |
| Credential guard (137 tracked files) | pass |
| Credential guard `--self-test` (9 scenarios) | pass |
| Retired-identifier guard (55 runtime files) | pass |
| Container image build | pass |
| Production refuses missing secrets | pass — names all four at once |
| Production refuses `CANDIDATE_REGISTRATION_MODE=open` | pass |
| Production refuses a short session secret | pass |
| MCP refuses to start unprotected in production | pass |
| `npm run smoke` against a live stack | **17 pass, 0 fail** |
| `npm run verify` against a live stack | **22 pass, 0 fail** |
| `GET /health` reports the prepared version | pass — `service=tryveriqo-api version=0.2.0` |
| Relative markdown links resolve (24 files) | pass |
| Config census: documented env variables referenced | pass — 34 of 34 |
| Config census: `loadConfig()` fields consumed | **one finding** — `config.database.uri`, filed as #31 |
| `npm audit` (all deps, and production-only at `high`) | 0 vulnerabilities |
| `v0.1.0` tag unmoved | pass — `c6eaf96f` → `62b0f5af…` |
| No `v0.2.0` tag created | pass |
| `release-notes-v0.1.0.md` untouched | pass — still at `3e7ee35` |

### A note on running the live gate

`docker compose` publishes the API on `8080` and MongoDB on `27017` by default. On
the machine used for this gate **both ports belonged to an unrelated project**, so
the first attempt bound nothing and the health check answered from the wrong
service — visible only because `/health` reported a different `service` name and
version.

The gate was re-run with `API_PORT=18080` and `MONGO_PORT=17017`, and the service
identity was confirmed before any workflow ran:

```
service=tryveriqo-api version=0.2.0 ai=gemini (gemini-api)
```

Worth recording because a live gate that silently exercises another project's API
produces failures that look like product bugs. **Check the `service` field in
`/health` before trusting a live run.**
