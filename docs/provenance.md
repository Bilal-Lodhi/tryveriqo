# Provenance and post-pivot evaluation

> This file is the **one** place in the repository where the successor product's
> name and hackathon-era vocabulary appear. The retired-identifier guard
> (`scripts/guards/identifier-guard.mjs`) exempts this file and `NOTICE` by
> design: an open-source release must be able to explain its own history
> truthfully.

## Source

| Fact | Value |
| --- | --- |
| Source repository | `Google-Cloud-Hackathon` (local historical repository) |
| Commit used | `644e4bfd0a7ac0a0eeeb2c58584aad28150730e0` |
| Extraction method | `git archive 644e4bf`, read-only |
| History preserved | **No** — a clean import commit, per the extraction brief |
| Licence of source | Apache License 2.0 |

### Why this commit

`644e4bf` is the last commit whose tree is still an **assessment** product: an
assessment generator, candidate sessions, telemetry ingestion, plagiarism
analysis and a review timeline. Direct inspection confirmed its tree contains
exactly those concepts, so the brief's primary baseline was used without needing
the fallback (`7959327`).

### Why the successor line was not imported

The assessment-to-successor pivot was introduced atomically at `a145b65`, which
retargeted the same codebase at a different product: insider threat and data
exfiltration monitoring for financial services. Everything downstream inherits
that vocabulary — `employeeId`, `auditId`, compliance matrices, threat
scenarios, exfiltration reports.

None of that belongs in an assessment integrity product, so the extraction stops
at `644e4bf` and no commit from the pivot line is imported wholesale.

## Post-pivot changes evaluated

Each candidate was inspected as a diff, then classified. "Adapt" means the
behaviour was ported and re-expressed in assessment semantics; "reject" means it
was not ported, with the reason recorded. Nothing was cherry-picked.

| Commit | Subject | Class | Reasoning |
| --- | --- | --- | --- |
| `bbd560f` | duplicate risk/flag dedup | **Adapt** | The real defects are real here: a retrying client re-sends a batch, and the source's own counter inflation made the analysis threshold trip on stale evidence. Ported as an observation fingerprint over type, problem, a one-second time bucket and payload — with `eventId` excluded, because a retry carries fresh ids. The same commit's code-hash guard was also adopted: unchanged code is not re-analysed. |
| `2fd7543` | post-restart session recovery via MongoDB fallback | **Adapt** | Genuinely valuable and provider-neutral: losing the in-memory projection on restart previously meant a session silently restarted empty, destroying the evidence a reviewer depends on. Ported as `hydrateFromPersisted()`, with a persisted `submittedCode` treated as authoritative over reconstructed code. |
| `160fc42` | human-readable Mongo timestamps | **Reject** | The change stored the *server's local offset* instead of UTC, which makes timelines produced in different regions non-comparable — a correctness regression for review evidence. The intent (readable times) is served correctly by the console converting UTC to the viewer's local zone at render time. Recorded in the changelog so it is not reintroduced. |
| `f7eff86` | session termination (delete) flow + CORS fix | **Adapt** | Three separable parts, all adopted: `delete_session` removing a session together with its telemetry and reports; the reviewer-facing termination endpoint; and adding `DELETE` to the allowed CORS methods. The source's `origin: "*"` was **not** adopted — CORS here is an explicit allow-list, per the security requirement. |
| `f06142e` | bind tab-switch logic to the frontend | **Adapt** | The API already defines and validates `TAB_SWITCH`; what was missing was a way for a client to produce it. Ported as `MicroEvent.toJson()` for the assessment semantics, and the ingestion path is exercised by automated tests over the wire. |
| `71f714d` | bind copy logic to the frontend | **Adapt** | As above for `COPY_ATTEMPT`; a copy attempt is a first-class telemetry event with a bounded `selectedText` field. |
| `750b43b` | flagged-content detail | **Adapt** | Identified a genuine defect still present at the baseline: the review route assumed `flags` was a `string[]` and flattened structured flag objects, discarding `description`, `severity`, `confidence` and `timestamp`. The route now preserves structured flags verbatim and widens legacy bare-string flags on read, so the console never branches on shape. |
| `1d43a4a` | drawer refresh + close/terminate session | **Adapt** | The console gains a refresh action and a terminate flow with a confirmation dialog, and the drawer closes on selection. |
| `4e95a3b` | vulgarity / gibberish detection | **Adapt, narrowed** | The intent — reject unusable input cheaply before spending a model call — is sound and provider-neutral. Ported as a deterministic pre-filter in front of the classifier. The source's pattern set was **not** copied: its gibberish heuristics misfire on legitimate long words, and its profanity list embedded slurs. The ported filter is limited to high-precision rules (empty, greeting-only, six-fold character repetition, vowel-less input, keyboard-row sweeps), and a test asserts that real technical terms pass. Ambiguous input is left to the semantic classifier. Note: the source's own rejection message named the successor product; that text was obviously not carried over. |
| `f500c9f` | session lock / workspace freeze | **Adapt, narrowed** | The product-neutral core is that a settled session cannot be edited. Ported as a lock indicator in the console, derived from session status, and `update_session_status` on the tool surface so lifecycle transitions are possible. The bulk of this commit is successor-specific workspace UI and was not ported. |
| `d0b9e1c` | real-time risk notification UI | **Adapt, narrowed** | Only the product-neutral part was taken: integrity reports are structured, persisted in full and surfaced in review with their individual flags. The notification popup widget itself is successor vocabulary and was not ported. |
| `bacfebf` | flag timestamps | **Adapt** | Subsumed by preserving structured flags: each flag carries its own `timestamp`, which the console displays. |
| `48cb3f0` | onboarding guide | **Reject** | Successor-specific onboarding copy for a different workflow. The equivalent for this product is the README, `docs/configuration.md` and the console's registration screen. |
| `63d9ed2` | target-system suggestions | **Reject** | "Target systems" is successor-domain vocabulary; there is no assessment equivalent. |
| `b2aed5b` | smoke / telemetry / stress scripts | **Reject** | 750+ lines of PowerShell built entirely on successor semantics — `employeeId`, `/api/v1/guardian/*`, compliance and threat endpoints, and a hard-coded cloud-credit balance. None of the endpoints exist here, so carrying the files over would be a rewrite wearing a port's clothes. Replaced by `scripts/smoke.mjs`, which exercises the actual assessment API including the authentication boundary and never calls a paid model. |
| `f374fb0` | Cloud Run cold-start fix | **Reject** | Mitigates a metadata-server race in a specific serverless environment, and the change also added an implicit Application Default Credentials filesystem scan that hunts for credential files — undesirable in a self-hostable OSS release. Timeouts and retries already exist at the provider boundary. |
| `e27d771` | Docker deploy improvements | **Reject** | Cloud Build and `gcloud` deployment configuration for a specific hosted environment. This repository ships a self-hostable Compose stack instead. |
| `a145b65` and the successor migration commits (`cb51110`, `447f727`, `e51312c`, `0714563`, `c67a053`, `a43cf24`, `12e5be5`, `0d5e0ce`, `9ed9af9`) | successor rebrand; OpenAI SDK swap; auditor and notification services | **Reject** | Out of scope by the brief and out of scope by product: successor branding, a provider migration made for another product, and `auditor.ts` / `notifications.ts`, which model a different domain. |

### Explicitly not ported, with reasons

* Successor and financial-services terminology, in any form.
* The OpenAI migration. Provider choice is per-product; this product was built
  against Gemini, and the extraction brief requires one working provider boundary.
* `auditor.ts`, `notifications.ts`.
* The compliance-matrix rewrite.
* Insider-threat and exfiltration semantics.

## What was changed that has no counterpart in the source

These are additions required by the extraction brief rather than ports:

* The entire authentication and authorisation boundary. The source had
  effectively unauthenticated identity and session operations; publishing that
  was explicitly out of scope.
* A single MCP tool registry shared by both transports. The source maintained two
  hand-written tables that had already drifted: the HTTP adapter exposed
  `update_session_code` and `append_micro_event`, which the stdio server did not,
  and the stdio server exposed tools the adapter did not. A test now asserts the
  handler table matches the declared contract exactly, and that the API never
  hard-codes a tool name.
* A single configuration story. The source had three environment files that
  disagreed with each other and with the code.
* A container that runs locally with MongoDB in Compose, with indexes created
  automatically.
* Repository guards and CI. The source had none.
* Honest documentation about what an integrity signal is and is not.
