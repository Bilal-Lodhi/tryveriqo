# Release checklist

Status of tryveriqo as a v0.1.0 **pre-release**. This separates what genuinely
blocks a tagged release from what is merely desirable, so a cosmetic gap is never
mistaken for a blocker and a real blocker is never buried in a list of nice-to-haves.

Current position: the source is published in the public repository, continuous
integration is green on `main`, and **no tag or GitHub Release exists**.

---

## A. Hard blockers

These must be true before a `v0.1.0` tag is pushed. Nothing else on this page
blocks the release.

| # | Blocker | State |
| --- | --- | --- |
| A1 | Release-preparation pull request merged into protected `main` through the normal review flow, with no branch-protection bypass | ☐ |
| A2 | All four required checks green on the resulting merge commit: `Backend (build, typecheck, test)`, `Console (analyze, test)`, `Container image builds and fails closed`, `Repository guards` | ☐ |
| A3 | Version `0.1.0` consistent across every manifest and reported by `GET /health` | ☑ verified on `main` |
| A4 | No tracked secret; credential guard and gitleaks clean over full history | ☑ verified on `main` |
| A5 | Real provider path verified against the live Gemini Developer API and recorded | ☑ recorded in [verification.md](verification.md) |
| A6 | Backend, console, container and guard suites green | ☑ verified on `main` |
| A7 | Transitive dependency and licence audit complete with no unresolved blocker | ☑ recorded in [NOTICE](../../NOTICE) |
| A8 | No placeholder product identity anywhere in the tree | ☑ verified on `main` |
| A9 | `LICENSE` retains the Apache-2.0 source copyright notice verbatim, with the derivative notice beside it | ☑ verified on `main` |
| A10 | Tag created and pre-release published, as its own explicitly authorised step | ☐ not authorised yet |

A1 and A2 are the only items this preparation phase can complete. A10 is a
deliberate, separate authorisation.

### A1 — known review constraint

`main` currently requires **one approving review**, and the repository has a
single collaborator (`Bilal-Lodhi`, who is also the author of the pull request).
GitHub does not permit a pull request author to approve their own pull request, so
the review requirement cannot be satisfied by the only available account.

This is a configuration deadlock, not a code or documentation defect. The honest
resolutions are, in preference order:

1. add a second collaborator and have them review — preserves the protection
   exactly as configured;
2. deliberately relax the review-count requirement to zero for a solo-maintainer
   project while keeping every required status check, the force-push ban, the
   deletion ban and conversation resolution — this is a documented configuration
   decision, not a bypass;
3. use an administrator bypass — **not recommended**, and it is the outcome this
   project's own process says to avoid.

The status checks, force-push protection and deletion protection are the parts of
branch protection that actually defend `main`; the approving-review rule is the
part that deadlocks a one-person repository. Any change is recorded in the final
report rather than applied silently.

---

## B. Recommended after the first release

Valuable, but explicitly **not** blocking v0.1.0.

| # | Item | Why it is not a blocker |
| --- | --- | --- |
| B1 | Live-verify the Vertex AI transport | Tracked as issue #1. `gemini-api` is the documented default and is fully verified; Vertex is an implemented, tested-but-unexercised alternative |
| B2 | Give the similarity report a real comparison source | Tracked as issue #4. The capability is described accurately as comparison against caller-supplied references |
| B3 | Add a `CODEOWNERS` file | Meaningful only once there is more than one maintainer |
| B4 | Enable Discussions | Issues are the current support channel and are documented as such in `SUPPORT.md` |
| B5 | Add a Dependabot version-update configuration | Dependabot **security** updates are already enabled; scheduled version bumps are convenience, not safety |
| B6 | Enable secret-scanning validity checks and non-provider patterns | Secret scanning and push protection are already enabled; these extend coverage rather than close a gap |
| B7 | Add a social preview image | Cosmetic |
| B8 | Add a CodeQL / code-scanning workflow | The guards, gitleaks and the test suite already run on every push; this would add depth, not close a hole |

---

## C. Intentionally deferred

Accepted v0.1.0 boundaries. Documented so they are decisions, not omissions. See
[Known limitations](../../README.md#known-limitations) and
[threat-model.md](../security/threat-model.md).

| # | Item | Rationale |
| --- | --- | --- |
| C1 | Candidate registration remains unauthenticated | Tracked as issue #2. It grants no access to another candidate's data; the residual is pre-registration hijack, which a deployment with untrusted candidates must close at the edge |
| C2 | Operator token compiled into the Flutter web bundle | Tracked as issue #3. Documented as a deployment constraint with acceptable and unacceptable patterns; fixing it properly needs a reverse proxy or a different auth model |
| C3 | Single shared operator credential, no per-reviewer identity or audit log | Would require an accounts/RBAC design that is out of scope for a v0.1.0 pre-release |
| C4 | No load, stress or denial-of-service testing | In-process rate limits are documented as a backstop, not a hardened defence |
| C5 | No hosted instance and no deployment guide for a public deployment | Publishing a hosted service is a separate decision with its own security obligations |
| C6 | No hardened candidate telemetry capture client | The API and console accept and display telemetry; a capture client is a separate product surface |
| C7 | No live session streaming | The API is request/response and the console refreshes on demand |
| C8 | Single tenancy | There is no tenancy model, so there is nothing to bypass |
| C9 | No published npm or container artifacts | The image is built and verified locally; publishing artifacts is a separate authorisation |

---

## D. Verification evidence

Every claim above traces to a recorded observation:

| Evidence | Location |
| --- | --- |
| Environment, test counts, container behaviour | [verification.md](verification.md) |
| Live provider mode, model id, latency, parser and persistence result | [verification.md](verification.md#ai-provider-live-verification) |
| Live end-to-end assessment workflow, 25 checks | [verification.md](verification.md#live-end-to-end-workflow) |
| Security boundary and cross-candidate refusals | [verification.md](verification.md#security-boundary) |
| Dependency and licence inventory | [NOTICE](../../NOTICE) |
| Threat model and accepted risks | [threat-model.md](../security/threat-model.md) |
| Provenance and derivation | [provenance.md](../provenance.md) |
