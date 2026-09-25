# Contributing

Thanks for considering a contribution. This project handles **candidate-personal
data**, so the bar for correctness and for honest wording is deliberately high.

## Getting set up

```sh
git clone <your fork>
cd assessment
npm ci
npm run build
npm test
```

The console needs the Flutter SDK:

```sh
cd apps/console
flutter pub get
flutter analyze
flutter test
```

## Before you open a pull request

Run the same checks CI runs:

```sh
npm run typecheck          # all TypeScript workspaces
npm run build
npm run test:backend       # API + MCP tests
npm run lint:console       # flutter analyze
npm run test:console       # flutter test
node scripts/guards/credential-guard.mjs
node scripts/guards/identifier-guard.mjs
```

### About the repository guards

`credential-guard.mjs` inspects **tracked files** by default, which is what makes
its verdict reproducible: CI checks out exactly the tracked tree, so a local run
and a CI run over the same commit must agree. A file you have not committed cannot
fail it.

```sh
# The default: the tracked tree. This is what CI runs.
node scripts/guards/credential-guard.mjs

# Tracked plus committable files — what `git commit -a` would publish.
# A local pre-commit aid: CI cannot reproduce a finding in a file that is not in
# the repository, and the output says so.
node scripts/guards/credential-guard.mjs --include-untracked

# Deterministic scenarios proving the two verdicts agree for the same content.
node scripts/guards/credential-guard.mjs --self-test
```

Ignored files — `.env`, `application_default_credentials.json` — are outside both
sets, because an ignored file cannot be published. `.gitignore` covers them, and
CI separately asserts that no environment file is tracked.

If you have a local file that legitimately mentions a retired identifier — a
scratch note, an editor session file — the default run will not fail on it. Do not
add it to `.gitignore` just to silence the widened check; either keep it out of
the committable set or move the content out of the repository.

## The rules that matter here

### 1. Never call a paid AI provider from a test

Substitute the provider at the `AssessmentAiClient` boundary
(`apps/api/src/agents/gemini-client.ts`). Parser behaviour is tested with
recorded fixtures. A test that needs a real key will be rejected.

### 2. Tool names come from the shared contract

Add or rename an MCP tool in `packages/mcp-mongodb/src/tool-names.ts` and in the
handler table. Never write a tool name as a string literal at a call site; the
contract test will fail, and that test exists because two hand-maintained tool
tables drifted apart in this codebase's history.

### 3. Collection names come from the shared contract

Use `COLLECTIONS` in `packages/mcp-mongodb/src/collections.ts`. Readers and
writers must agree, and a test asserts it.

### 4. Timestamps are UTC ISO-8601 in storage

`apps/api/src/utils/time.ts` is the only place that formats time. Local-time
rendering happens in the viewer, never in the stored value.

### 5. Never overstate what an integrity signal means

In code, UI text, documentation and commit messages:

| Do not write | Write instead |
| --- | --- |
| detects cheating | surfaces integrity signals |
| proves plagiarism | reports similarity to reference material |
| flags a cheater | raises a suspicious behaviour indicator |
| production ready | v0.1.0 release candidate |
| compliance certified | *(nothing — there is no certification)* |

A human reviewer makes the judgement. The software assists.

### 6. Never commit a credential

`.env` is ignored. `.env.example` must contain blank values for every secret.
CI runs a credential guard, an identifier guard and gitleaks.

### 7. New routes declare their access

Every route under `/api/v1` is either explicitly public with a written reason, or
guarded by `requireAuth()`, `requireOperator()` or a candidate-access guard. A
sensitive route without a guard is a bug.

### 8. Tests come with the change

Add or extend tests for behaviour you introduce. If a change is untestable
without a network or a live model, say so in the pull request and explain what
you verified by hand.

## Commit messages

Short imperative subject lines, optionally with a body explaining *why*.

```
feat(integrity): suppress replayed telemetry batches

A polling client can re-send the same batch. Without suppression the
paste counter inflates and the analysis threshold trips on stale evidence.
```

## Reporting a bug

Use the bug report template. Include the API version from `GET /health`, the
exact request, and the response. **Redact** candidate ids, tokens and any
telemetry content before pasting logs.

## Reporting a security issue

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
