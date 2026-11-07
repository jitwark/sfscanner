# Contributing to n8n-Secureflow

> This file describes the proposed contribution workflow for the future public repository.
> Maintainer handles, the final support channel, and the independent release-review assignment
> require owner confirmation.

Contributions are welcome when they improve the deterministic scanner, static catalogue, search
experience, documentation, accessibility, or reproducible release process without weakening the
project's local-only and provenance boundaries.

## Before opening a change

1. Read the root [`README.md`](README.md), [`docs/SECURITY.md`](docs/SECURITY.md),
   [`docs/privacy.md`](docs/privacy.md), [`docs/sources.md`](docs/sources.md), and
   [`docs/LICENSING.md`](docs/LICENSING.md).
2. Keep browser code browser-safe: no server routes, server actions, Node built-ins, or scanner
   network calls in the static application.
3. Use synthetic fixtures for examples and tests. Never commit credentials, private workflows,
   local environment files, Firebase state, acquisition workdirs, or hand-edited generated data.
4. Preserve provenance, rights state, redaction, attribution, deterministic ordering, and the
   distinction between link-only and downloadable records.
5. Add a focused test for changed behavior. Keep source files below the repository's size limit
   and import modules through their direct paths.

## Pull requests

Describe the reason for the change, affected boundaries, tests run, and any residual risk. Keep
generated artifacts separate from source changes and use the owning generator for catalogue,
search, graph, attribution, and release outputs.

Changes involving workflow bodies, provenance, licences, redistribution, privacy, security,
release integrity, or public claims need the corresponding specialist review. A passing test suite
does not replace rights review or a recorded release decision. Unknown rights remain link-only or
excluded; they are never inferred from a missing field.

Do not put secrets or private workflow content in an issue or pull request. Use the private channel
specified by [`SECURITY.md`](SECURITY.md) when one is available, and describe sensitive problems
with the smallest safe reproduction.

## Local checks

```text
npm ci
npm run typecheck
npm run test
npm run lint
npm run gates
```

Run the narrowest relevant check first, then the full canonical gate for a cross-cutting change.

### Two things `npm test` needs, and how it gets them

`app/public/data/` is generated, not committed, and one suite asserts on the built static export.
Both used to fail a fresh clone with errors that read like a broken checkout:

- **Staged catalogue artifacts.** A `pretest` hook runs `node scripts/sync-data.mjs --if-present`,
  so `npm test` stages them itself. On a source-only checkout with no `data/` directory the hook
  says so and exits 0 rather than failing.
- **The built export.** `app/src/catalogue/link-graph.test.ts` inspects `app/out/`. Without it the
  suite prints a named skip and moves on. Run `npm run build` first to include that check —
  CI always does, because `CORE_GATES` runs `build` before `test`.

### Working on the scanner only

`npm run gates:source` runs the fifteen gates that do not read the corpus, and `npm run test:source`
runs the `scanner-core`, `scanner-cli` and `contracts` suites. Both complete in well under a minute
and are what the standalone scanner repository runs in CI.

## Review and conduct

Reviewers should consider correctness, privacy, security, provenance, rights, accessibility,
reproducibility, and operational impact. Please follow [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
when discussing disagreements or reporting harmful behavior.
