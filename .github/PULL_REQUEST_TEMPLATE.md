## What this change does

<!-- One or two sentences. What behaviour changes, and why. -->

## Scope

- [ ] API
- [ ] MCP tool surface
- [ ] Console
- [ ] Documentation
- [ ] Build, container or CI

## How it was verified

<!--
Be specific and honest. "npm run test:backend — 122 pass" is useful.
"Tested locally" is not. If something was verified by hand, say so.
-->

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | |
| Build | `npm run build` | |
| Backend tests | `npm run test:backend` | |
| Console analyze | `flutter analyze` | |
| Console tests | `flutter test` | |
| Guards | `node scripts/guards/*.mjs` | |

## Checklist

- [ ] I read `CONTRIBUTING.md`
- [ ] No paid AI provider is called from a test; the provider boundary is stubbed
- [ ] MCP tool names come from `MCP_TOOLS`, not string literals
- [ ] MongoDB collection names come from `COLLECTIONS`
- [ ] Persisted timestamps are UTC ISO-8601
- [ ] Every new sensitive route declares its access requirement
- [ ] No credential, connection string or retired identifier is introduced
- [ ] User-facing wording does not overstate what an integrity signal means
- [ ] Tests cover the behaviour, or the pull request explains why they cannot

## Breaking change?

<!--
If yes, describe the old and new behaviour and what a deployment must do.
Anything that renames a route, a tool, a collection or a stored field is
breaking.
-->

- [ ] No
- [ ] Yes — described above and recorded in `CHANGELOG.md`

## Related issues

<!-- Closes #... -->
