# Where this repository comes from

The scanner, the site, and the pipeline are developed in a private monorepo and
extracted into this repository by `scripts/extract-public-repo.mjs`, which
copies an explicit allowlist and refuses to run if any selected file trips a
content-safety rule.

Extraction is one-directional. **Send changes as pull requests against this
repository** — see [`CONTRIBUTING.md`](CONTRIBUTING.md); they are merged upstream
and returned by the next extraction.

## This tree

| | |
| --- | --- |
| Upstream commit | `f8e871aef7b8a096e3d962bb04aa518ce191bba9` |
| Extracted | 2026-09-05 |
| Files | 1,370 |

## What is deliberately absent

- **`data/`** — the packaged catalogue of 11,464 workflows. It is a separate artifact with its
  own terms; see [`docs/LICENSING.md`](docs/LICENSING.md). Everything that reads it is therefore
  skipped here: `npm run build`,
  `npm test` and `npm run test:e2e` cannot pass in this repository. Run
  `npm run gates:source` and `npm run test:source` instead — those are what CI
  runs, and they cover the scanner, the CLI and the shared contracts.
- **Internal planning** — audit packets, OpenSpec change proposals, and working
  plans for decisions not yet taken. Architecture decisions that *were* taken
  are published, in [`docs/decisions/`](docs/decisions/).
- **Agent and tool configuration** — instruction files and local editor state.
