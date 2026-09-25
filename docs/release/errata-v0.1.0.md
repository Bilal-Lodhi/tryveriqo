# Post-release errata — v0.1.0

**Status: a correction record, not a release artifact.**

The v0.1.0 release is a published, immutable snapshot of what was believed and
verified at publication time. It is deliberately **not** rewritten. This document
records, in current documentation, the places where work after v0.1.0 established
that something in that snapshot was incomplete or imprecise.

Nothing here changes the v0.1.0 tag, its target commit, or the published release
body. Corrections belong in current docs and in the next release notes; that is
what this file and [`release-notes-v0.2.0.md`](release-notes-v0.2.0.md) are for.

Each entry states what was claimed, what was verified then, what later work
discovered, and what the behaviour is now.

---

## 1. Cross-candidate access was not refused in every shape

**Claimed (release body, "Security and auth model").**

> Candidate registration is unauthenticated. Any caller may register any
> `candidateId`. The token grants access only to that identity's own data —
> cross-candidate access is refused with `403` — but a caller can claim an unused
> identity.

**Verified then.** The live workflow tested cross-candidate rejection for the
**single-event, same-candidate** shape, and recorded `403` on ingest, the cohort
list, candidate reports and a foreign review. Those observations were real.

**Discovered later.** Two gaps survived that test:

* Ingestion decided who a batch belonged to from `events[0].candidateId` alone,
  while the validator permitted a batch to carry events naming **different**
  candidates. A two-event batch — the caller's own event first, a victim-attributed
  event second — was accepted, persisted, and its `pasteContent` written into the
  victim session's stored code snapshot by the `update_session_code` write-back.
* Ingestion never compared the session's stored owner against the caller at all,
  so any caller holding a known `sessionId` could write into that session
  regardless of the events' `candidateId`.

**Impact.** A candidate could attribute forged evidence to another named
individual and overwrite their stored submission. The claim was true of the shape
that was tested and false of the shape that was not.

**Fixed by** PR #8 (`fix/cross-candidate-telemetry-isolation`), merged into `main`
at `c2e1f8b`. Enforced now: a batch names exactly one candidate, must match the
token, and must own the session — checked before the projection is created, cached
or recovered.

**Accurate statement now:** [threat-model.md T3](../security/threat-model.md),
[verification.md](verification.md#correction-what-the-cross-candidate-rows-above-did-and-did-not-cover).

---

## 2. Open registration was worse than "claim an unused identity"

**Claimed (release body, "Known limitations").**

> Candidate registration is unauthenticated. Any caller may register any
> `candidateId`. The token grants access only to that identity's own data —
> cross-candidate access is refused with `403` — but a caller can claim an unused
> identity. Untrusted-candidate deployments must verify identity at the edge.

**Believed then.** The residual was framed as *pre-registration hijack*: a caller
could claim an id an operator had intended for someone else, if they got there
first.

**Discovered later.** Nothing checked whether a candidate id was already in use.
Registering with a **known, in-use** candidate id returned `201`, and the resulting
token read that candidate's own `submittedCode` and integrity report history. The
exposure was therefore **read as well as write**, the id did not have to be unused,
and no race was involved — a later claimant simply received an equivalent token.

**Impact.** A known candidate id granted access to that candidate's record. This
is an authorization boundary defect, not a documentation gap.

**Fixed by** PR #17 (`security/registration-capability`), merged into `main` at
`aa7e2a9`. Registration now requires an **operator-issued registration
capability** bound to the exact `candidateId` (and `assessmentId`, when bound), and
returns one identical `403` for every failure so the endpoint is not an oracle for
whether a candidate id exists.

**Accurate statement now:** [configuration.md § Candidate
registration](../configuration.md#candidate-registration), [threat-model.md T3 and
accepted risk 1](../security/threat-model.md).

---

## 3. "Vertex AI transport is not live-verified" was superseded

**Claimed (release body, "Known limitations").**

> **Vertex AI transport is not live-verified.** It is implemented and covered by
> request-construction tests; only the Gemini Developer API path has been exercised
> end to end.

**Accurate at publication.** `docs/release/verification.md` recorded that no
Google Cloud project or ADC was available to the release workflow.

**Changed later.** A real Vertex call was made after v0.1.0, against a real project
using Application Default Credentials. It authenticated with **no API key present**,
was accepted for `us-central1`, reached the provider, and returned
`403 PERMISSION_DENIED`, reason `BILLING_DISABLED`, in about 7.3 seconds.

So ADC discovery, region acceptance, structured provider errors, and the client's
terminal-error handling are now verified against the real service. A **successful**
generation is not: the parser has never seen a live Vertex response shape, and
persistence was not reached. The project has billing disabled, and enabling it is a
spend decision that was not taken.

**Accurate statement now:** [verification.md § Vertex AI transport: live
result](verification.md#vertex-ai-transport-live-result-post-v010),
[threat-model.md accepted risk 7](../security/threat-model.md).

---

## 4. The similarity report had no comparison source

**Claimed (release body, "Known limitations").**

> **Reference completions for similarity analysis are caller-supplied.** There is
> no built-in corpus, so this is not yet a plagiarism check against the open web.

**Accurate at publication,** and it understated the practical position: no caller
supplied any. The ingest route passed an empty array, so the report compared
against **nothing** while presenting a similarity structure.

**Changed later.** The comparison source is now the **stored assessment's own
reference solution** — the suite's `expectedAnswer` and `starterCode` for the
session's problem — with the source recorded on the report
(`plagiarismReport.source`). Bounded to 3 references and 20,000 characters.
`PLAGIARISM_THRESHOLD`, previously parsed and never read, now raises an advisory
flag at or above the threshold.

It is still **not** a check against the open web, and a high score is still a
similarity indicator rather than a finding of plagiarism.

**Fixed by** PR #28 (`feat/similarity-reference-source`), merged into `main` at
`63c6bd5`.

**Accurate statement now:** [configuration.md § What the similarity report
compares against](../configuration.md#what-the-similarity-report-compares-against).

---

## Claims that were accurate and remain so

Recorded so the absence of an entry is not read as an oversight:

* **Not production ready**, no hosted instance, no SLA, no load or DoS testing.
* **Integrity output is advisory**; nothing proves misconduct.
* **Telemetry capture is client-side**; no hardened capture client ships here.
* **No live session streaming.**
* **Single tenancy**, and one shared operator credential with no per-reviewer
  identity or audit log.
* **The console compiles its operator token into the web bundle.** Still true —
  and now the console additionally withholds an embedded token from a non-loopback
  host rather than only documenting the risk (PR #27).
